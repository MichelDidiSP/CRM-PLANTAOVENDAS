import { supabase, type QueueEntry, type Broker } from '../supabase';
import { fetchAll } from '../queueEngine';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { originalBrokerId, operationalDispatch, type ReceptionPolicy, type ReturnOffer } from './operationalChoices';
import { busyReceptionIds, isReceptionFree, receptionRoster } from './fallbackOrchestrator';
import { claimOperationalChoice, createReceptionPolicy, dispatchOperationalEntry, newReceptionPolicy, readReceptionPolicy } from './operationalStore';
import { availabilityKey, returnDecision, waitingReturn } from './returnDecision';

function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
async function save(policy: ReceptionPolicy, exists: boolean, clock: ScheduleClock, at: string) {
  if (!exists) return createReceptionPolicy(policy, clock.date, at);
  const result = await supabase.from('plantao_sessions').update({ schedule_data: policy }).eq('id', `reception_${policy.entryId}`);
  check(result.error);
}
function policyFor(entry: QueueEntry) { return newReceptionPolicy(entry.id, originalBrokerId(entry), 'nominal'); }
function sameOffer(policy: ReceptionPolicy, decision: ReturnType<typeof returnDecision>): boolean {
  const offer = policy.returnConfirmation?.offer;
  return decision.kind === 'offer' ? offer?.brokerId === decision.choice.broker?.id && offer?.availability === decision.availability : !offer;
}

/** Reserve only while changing the decision, not while waiting for the client.
 * The offered broker stays free; the installed claim RPC reserves him on acceptance.
 */
async function withWaitingLock<T>(id: string, at: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = await supabase.from('queue_entries').update({ queue_status: 'ausente' })
    .eq('id', id).eq('queue_status', 'aguardando').select('id').maybeSingle();
  check(lock.error); if (!lock.data) return;
  try { return await work(); }
  finally {
    const result = await supabase.from('queue_entries').update({ queue_status: 'aguardando', updated_at: at })
      .eq('id', id).eq('queue_status', 'ausente'); check(result.error);
  }
}
async function freshWaiting(id: string) {
  const live = await fetchAll(); check(live.error);
  const row = live.queue.find(e => e.id === id);
  if (!row) throw new Error('Atendimento não encontrado. Atualize a tela.');
  return { ...live, entry: { ...row, queue_status: 'aguardando' as const } };
}

/** Automatic UI gateway. A true result means a call OR a persisted decision changed. */
export async function dispatchReceptionEntry(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[], clock: ScheduleClock, at: string) {
  if (!waitingReturn(entry)) return dispatchOperationalEntry(entry, brokers, queue, clock, at);
  const existing = await readReceptionPolicy(entry.id);
  const policy = existing ?? policyFor(entry);
  const decision = returnDecision(entry, brokers, queue, clock, policy);
  if (decision.kind === 'original') return claimOperationalChoice(entry, brokers, clock, at, decision.choice, existing);
  if (existing && sameOffer(policy, decision)) return false;
  // Re-read after acquiring the row: a concurrent answer must never be replaced
  // by a monitor that computed its proposal before that answer.
  const result = await withWaitingLock(entry.id, at, async () => {
    const live = await freshWaiting(entry.id);
    const current = await readReceptionPolicy(entry.id);
    const latest = current ?? policyFor(live.entry);
    const next = returnDecision(live.entry, live.brokers, live.queue, clock, latest);
    if (next.kind === 'original') return { live, latest, original: next.choice, changed: false };
    if (current && sameOffer(latest, next)) return { changed: false };
    const offer: ReturnOffer | undefined = next.kind === 'offer' ? {
      id: crypto.randomUUID(), brokerId: next.choice.broker!.id, availability: next.availability, at,
    } : undefined;
    await save({ ...latest, returnConfirmation: { ...latest.returnConfirmation, offer },
      events: offer ? [...latest.events, { type: 'return_offered', brokerId: offer.brokerId, at }] : latest.events }, Boolean(current), clock, at);
    const marked = await supabase.from('queue_entries').update({ reception_waiting: true }).eq('id', entry.id).eq('queue_status', 'ausente');
    check(marked.error);
    return { changed: true };
  });
  if (result && 'original' in result && result.original && result.live)
    return claimOperationalChoice(result.live.entry, result.live.brokers, clock, at, result.original, result.latest);
  return result?.changed ?? false;
}

export async function dispatchWaitingWithDecisions(queue: QueueEntry[], brokers: Broker[], clock: ScheduleClock, at: string) {
  const entries = queue.filter(e => e.queue_status === 'aguardando' && (e.reception_waiting || waitingReturn(e)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const policies = await Promise.all(entries.map(e => readReceptionPolicy(e.id)));
  const order = new Map(entries.map((entry, i) => [entry.id, policies[i]?.mode === 'arrival']));
  entries.sort((a, b) => Number(order.get(b.id)) - Number(order.get(a.id)));
  let changed = false;
  let live = { queue, brokers };
  for (const entry of entries) {
    const fresh = live.queue.find(e => e.id === entry.id);
    if (fresh && await dispatchReceptionEntry(fresh, live.brokers, live.queue, clock, at)) {
      changed = true;
      const refreshed = await fetchAll(); check(refreshed.error); live = refreshed;
    }
  }
  return changed;
}

export async function answerReturnOffer(id: string, offerId: string, accept: boolean, clock: ScheduleClock, at: string) {
  const result = await withWaitingLock(id, at, async () => {
    const live = await freshWaiting(id);
    const policy = await readReceptionPolicy(id);
    const offer = policy?.returnConfirmation?.offer;
    if (!waitingReturn(live.entry) || !policy || !offer || offer.id !== offerId)
      throw new Error('Esta solicitação já foi respondida ou mudou. Atualize a tela.');
    const decision = returnDecision(live.entry, live.brokers, live.queue, clock, policy);
    if (decision.kind === 'original') {
      const next = { ...policy, mode: 'nominal' as const, returnConfirmation: { ...policy.returnConfirmation, offer: undefined } };
      await save(next, true, clock, at);
      return { live, policy: next, choice: decision.choice };
    }
    const broker = live.brokers.find(b => b.id === offer.brokerId);
    if (!broker || decision.kind !== 'offer' || decision.choice.broker?.id !== broker.id || availabilityKey(broker, live.queue) !== offer.availability) {
      await save({ ...policy, returnConfirmation: { ...policy.returnConfirmation, offer: undefined } }, true, clock, at);
      throw new Error('O corretor deixou de estar disponível. O cliente continua aguardando; confira a nova solicitação.');
    }
    const declinedNow = Object.fromEntries(receptionRoster(live.brokers, clock)
      .filter(b => b.id !== policy.ownerId && isReceptionFree(b, busyReceptionIds(live.queue)))
      .map(b => [b.id, availabilityKey(b, live.queue)]));
    const next: ReceptionPolicy = { ...policy, mode: accept ? 'coverage' : 'nominal',
      returnConfirmation: { ...policy.returnConfirmation, offer: undefined,
        declined: accept ? policy.returnConfirmation?.declined : { ...policy.returnConfirmation?.declined, ...declinedNow } },
      events: [...policy.events, { type: accept ? 'return_accepted' : 'return_kept_original', brokerId: broker.id, at }] };
    await save(next, true, clock, at);
    // Bind acceptance to this broker, not to whichever broker later tops the queue.
    const excluded = new Set([...busyReceptionIds(live.queue), ...live.brokers.filter(b => b.id !== broker.id).map(b => b.id)]);
    const choice = accept ? operationalDispatch(live.entry, live.brokers, clock, excluded, next, () => undefined) : undefined;
    return { live, policy: next, choice };
  });
  if (!result) return false;
  if (result.choice) {
    if (!await claimOperationalChoice(result.live.entry, result.live.brokers, clock, at, result.choice, result.policy))
      throw new Error('O corretor ficou indisponível antes da confirmação. O cliente continua na espera.');
  }
  return true;
}
