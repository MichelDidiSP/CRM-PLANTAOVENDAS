import { dbReady, supabase, type Broker, type QueueEntry } from '../supabase';
import { dispatchBroker, fetchAll } from '../queueEngine';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { busyReceptionIds } from './fallbackOrchestrator';
import { claimReceptionCall } from './fallbackStore';
import { allBrokersAbsent, canRefuseInverse, directPosition, freeDirectPosition, operationalDispatch, originalBrokerId,
  type ManagedEntry, type ReceptionPolicy, type WaitingMode } from './operationalChoices';

const policyId = (id: string) => `reception_${id}`;
function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
export function newReceptionPolicy(entryId: string, ownerId: string | null, mode?: WaitingMode, at?: string): ReceptionPolicy {
  return { kind: 'reception_v1', entryId, ownerId, mode, refusedIds: [], events: mode && at ? [{ type: 'waiting', at }] : [] };
}
export async function readReceptionPolicy(entryId: string): Promise<ReceptionPolicy | undefined> {
  await dbReady;
  const result = await supabase.from('plantao_sessions').select('schedule_data').eq('id', policyId(entryId)).maybeSingle();
  check(result.error);
  return result.data?.schedule_data?.kind === 'reception_v1' ? result.data.schedule_data : undefined;
}
export async function createReceptionPolicy(policy: ReceptionPolicy, day: string, at: string) {
  // An ended, namespaced record cannot be mistaken for the active shift or a draw.
  // The existing reset already deletes sessions for this operational day.
  const result = await supabase.from('plantao_sessions').insert({ id: policyId(policy.entryId), plantao_date: day,
    status: 'ended', started_at: at, ended_at: at, schedule_data: policy });
  check(result.error);
}
async function updatePolicy(policy: ReceptionPolicy) {
  const result = await supabase.from('plantao_sessions').update({ schedule_data: policy }).eq('id', policyId(policy.entryId));
  check(result.error);
}
export async function removeReceptionPolicy(entryId: string) {
  const result = await supabase.from('plantao_sessions').delete().eq('id', policyId(entryId));
  check(result.error);
}
export function attachReceptionPolicies(queue: QueueEntry[], sessions: { schedule_data?: ReceptionPolicy }[]): ManagedEntry[] {
  const policies = new Map(sessions.filter(s => s.schedule_data?.kind === 'reception_v1').map(s => [s.schedule_data!.entryId, s.schedule_data!]));
  return queue.map(entry => ({ ...entry, reception_policy: policies.get(entry.id) }));
}

/** Idempotent completion of the trace after the existing atomic claim RPC.
 * Retried on reload if a network failure interrupted the subsequent metadata writes.
 */
export async function synchronizeReceptionTrace(entry: ManagedEntry, brokers: Broker[]) {
  const policy = entry.reception_policy;
  if (!policy || !['chamando', 'em_atendimento', 'concluido'].includes(entry.queue_status)) return;
  const broker = brokers.find(b => b.id === entry.broker_id);
  const owner = brokers.find(b => b.id === policy.ownerId);
  if (!broker) return;
  const split = Boolean(policy.ownerId && policy.ownerId !== broker.id);
  const rule = policy.mode === 'arrival' ? 'Espera prioritária · Primeiro corretor a chegar' : policy.mode === 'nominal'
    ? 'Espera nominal · Corretor próprio' : !owner ? 'Fila Inversa' : owner.id === broker.id ? 'Corretor próprio'
      : owner.agency !== broker.agency ? 'Transbordo Interempresas' : owner.equipe === broker.equipe ? 'Último da Equipe' : 'Último da Empresa';
  const trace = { applied_rule: `${rule}${split ? ' (Split)' : ''}`, original_broker_name: owner?.operational_name ?? null,
    attending_broker_name: broker.operational_name };
  if (entry.commission_split !== split) {
    const result = await supabase.from('queue_entries').update({ commission_split: split })
      .eq('id', entry.id).eq('broker_id', broker.id).in('queue_status', ['chamando', 'em_atendimento', 'concluido']);
    check(result.error);
  }
  const existing = entry as ManagedEntry & Partial<typeof trace>;
  if (entry.commission_split !== split || Object.entries(trace).some(([key, value]) => existing[key as keyof typeof trace] !== value)) {
    // Separate statement: the existing split trigger labels every split as
    // inter-company. Only this update writes the exact team/company label.
    const result = await supabase.from('queue_entries').update(trace).eq('id', entry.id).eq('broker_id', broker.id)
      .in('queue_status', ['chamando', 'em_atendimento', 'concluido']);
    check(result.error);
  }
  Object.assign(entry, trace, { commission_split: split });
}

export async function dispatchOperationalEntry(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[], clock: ScheduleClock,
  at: string, engine?: () => Broker | undefined): Promise<boolean> {
  if (entry.queue_status !== 'aguardando') return false;
  let policy = await readReceptionPolicy(entry.id);
  const busy = busyReceptionIds(queue);
  const choice = operationalDispatch(entry, brokers, clock, busy, policy, engine ?? (() =>
    dispatchBroker(brokers, entry.reception_waiting ? 'geral' : entry.queue_type, clock.seconds, busy, null, originalBrokerId(entry)).broker));
  return claimOperationalChoice(entry, brokers, clock, at, choice, policy);
}

/** Execution primitive, also used after an explicit, revalidated return decision. */
export async function claimOperationalChoice(entry: QueueEntry, brokers: Broker[], clock: ScheduleClock, at: string,
  choice: ReturnType<typeof operationalDispatch>, policy?: ReceptionPolicy): Promise<boolean> {
  if (!choice.broker) return false;
  const owner = brokers.find(b => b.id === (policy?.ownerId ?? originalBrokerId(entry)));
  if (choice.rule && !policy) {
    policy = newReceptionPolicy(entry.id, owner?.id ?? null);
    try { await createReceptionPolicy(policy, clock.date, at); }
    catch (error) {
      // A concurrent dispatcher may already have inserted this namespaced row.
      const existing = await readReceptionPolicy(entry.id);
      if (!existing) throw error;
      return false;
    }
  }
  // The existing RPC only permits split=true across companies. Reserve the call
  // through its row locks first, then persist the full commission/trace below.
  const rpcSplit = choice.split && owner?.agency !== choice.broker.agency;
  const claimed = await claimReceptionCall(entry, choice.broker, rpcSplit, at,
    !owner && entry.queue_type === 'geral');
  if (!claimed) return false;
  if (choice.rule) await synchronizeReceptionTrace({ ...entry, broker_id: choice.broker.id,
    queue_status: 'chamando', commission_split: rpcSplit, reception_policy: policy }, brokers);
  return true;
}

/** Execution-only helper. Automatic screen callers use dispatchWaitingWithDecisions. */
export async function dispatchOperationalWaiting(queue: QueueEntry[], brokers: Broker[], clock: ScheduleClock, at: string) {
  const waiting = queue.filter(e => e.reception_waiting && e.queue_status === 'aguardando')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const withPolicy = await Promise.all(waiting.map(async entry => ({ entry, policy: await readReceptionPolicy(entry.id) })));
  // Arrival-priority clients precede regular waiting. An unavailable nominal
  // owner must never block another client's eligible broker.
  withPolicy.sort((a, b) => Number(b.policy?.mode === 'arrival') - Number(a.policy?.mode === 'arrival'));
  let called = false;
  let liveQueue = [...queue];
  let liveBrokers = [...brokers];
  for (const { entry } of withPolicy) {
    if (await dispatchOperationalEntry(entry, liveBrokers, liveQueue, clock, at)) {
      called = true;
      const live = await fetchAll();
      check(live.error); liveQueue = live.queue; liveBrokers = live.brokers;
    }
  }
  return called;
}

async function liveEntry(id: string) {
  const live = await fetchAll(); check(live.error);
  const entry = live.queue.find(e => e.id === id);
  if (!entry) throw new Error('Atendimento não encontrado. Atualize a tela.');
  return { ...live, entry };
}
export async function changeNominalWaiting(id: string, clock: ScheduleClock, at: string) {
  const live = await liveEntry(id);
  const policy = await readReceptionPolicy(id);
  if (live.entry.queue_status !== 'aguardando' || policy?.mode !== 'nominal') return false;
  // Reserve the waiting row so another panel cannot claim the old nominal mode
  // while the customer changes their decision.
  const lock = await supabase.from('queue_entries').update({ queue_status: 'ausente' })
    .eq('id', id).eq('queue_status', 'aguardando').select('id').maybeSingle();
  check(lock.error); if (!lock.data) return false;
  try {
    await updatePolicy({ ...policy, mode: allBrokersAbsent(live.brokers) ? 'arrival' : 'coverage',
      events: [...policy.events, { type: 'changed_mind', at }] });
  } finally {
    const unlocked = await supabase.from('queue_entries').update({ queue_status: 'aguardando', updated_at: at })
      .eq('id', id).eq('queue_status', 'ausente'); check(unlocked.error);
  }
  const fresh = await liveEntry(id);
  await dispatchOperationalEntry(fresh.entry, fresh.brokers, fresh.queue, clock, at);
  return true;
}

export async function refuseInverseCall(id: string, clock: ScheduleClock, at: string, expected?: Pick<QueueEntry, 'broker_id' | 'called_at'>) {
  const live = await liveEntry(id);
  const policy = await readReceptionPolicy(id);
  if (expected && (live.entry.broker_id !== expected.broker_id || live.entry.called_at !== expected.called_at))
    throw new Error('A chamada foi alterada. Atualize a tela antes de recusar.');
  if (!canRefuseInverse({ ...live.entry, reception_policy: policy }, live.brokers, live.queue))
    throw new Error('Recusa permitida apenas ao 1º ou 2º livre da fila direta da empresa, antes de iniciar o atendimento.');
  const broker = live.brokers.find(b => b.id === live.entry.broker_id)!;
  const position = directPosition(broker, live.brokers);
  const freePosition = freeDirectPosition(live.entry, live.brokers, live.queue);
  // Compare-and-set prevents duplicate refusals and a late click after another
  // operator has already confirmed the call. The reserved row is not dispatchable.
  const lock = await supabase.from('queue_entries').update({ queue_status: 'ausente' })
    .eq('id', id).eq('queue_status', 'chamando').eq('broker_id', broker.id)
    .eq('called_at', live.entry.called_at).select('id').maybeSingle();
  check(lock.error); if (!lock.data) return false;
  let recorded = false;
  try {
    const next = { ...(policy ?? newReceptionPolicy(id, null)),
      refusedIds: [...(policy?.refusedIds ?? []), broker.id],
      events: [...(policy?.events ?? []), { type: 'inverse_refusal' as const, brokerId: broker.id, position, freePosition, at }] };
    if (policy) await updatePolicy(next); else await createReceptionPolicy(next, clock.date!, at);
    recorded = true;
    const inverseEnd = Math.max(0, ...live.brokers.filter(b => !b.is_external_partner).map(b => b.inverse_order ?? 0)) + 1;
    const released = await supabase.from('brokers').update({ inverse_order: inverseEnd, attendance_status: 'livre', last_status_update: at })
      .eq('id', broker.id);
    check(released.error);
    const visit = await supabase.from('visits').update({ status: 'aguardando' }).eq('id', live.entry.visit_id); check(visit.error);
    const waiting = await supabase.from('queue_entries').update({ queue_status: 'aguardando', broker_id: null,
      attempts: 0, called_at: null, reception_waiting: true, updated_at: at }).eq('id', id).eq('queue_status', 'ausente');
    check(waiting.error);
  } catch (error) {
    // Restore a retryable call on a failed mutation; surface the failure instead
    // of silently losing the client. The direct queue was never written.
    if (recorded) {
      if (policy) await updatePolicy(policy); else await removeReceptionPolicy(id);
    }
    const restored = await supabase.from('brokers').update({ inverse_order: broker.inverse_order, attendance_status: broker.attendance_status })
      .eq('id', broker.id); check(restored.error);
    const restoredVisit = await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', live.entry.visit_id); check(restoredVisit.error);
    const restoredCall = await supabase.from('queue_entries').update({ queue_status: 'chamando', broker_id: broker.id,
      attempts: live.entry.attempts, called_at: live.entry.called_at, reception_waiting: live.entry.reception_waiting ?? false })
      .eq('id', id).in('queue_status', ['ausente', 'aguardando']); check(restoredCall.error);
    throw error;
  }
  const fresh = await liveEntry(id);
  await dispatchOperationalEntry(fresh.entry, fresh.brokers, fresh.queue, clock, at);
  return true;
}
