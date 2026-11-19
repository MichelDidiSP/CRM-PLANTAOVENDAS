import type { Broker, QueueEntry } from '../supabase';
import { reverseCoverage } from '../queue/coreDistribution';
import { onlyOwn } from '../queue/pauseAndPartners';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { isReceptionFree, receptionRoster, resolveReceptionDispatch } from './fallbackOrchestrator';

export type WaitingMode = 'arrival' | 'nominal' | 'coverage';
export type ReceptionEvent = { at: string; type: 'waiting' | 'changed_mind' | 'inverse_refusal' | 'return_offered' | 'return_accepted' | 'return_kept_original'; brokerId?: string; position?: number; freePosition?: number };
export type ReturnOffer = { id: string; brokerId: string; availability: string; at: string };
/** Stored separately from the frozen engines, in the existing session JSON column. */
export type ReceptionPolicy = {
  kind: 'reception_v1'; entryId: string; mode?: WaitingMode; ownerId: string | null;
  refusedIds: string[]; events: ReceptionEvent[];
  returnConfirmation?: { offer?: ReturnOffer; declined?: Record<string, string> };
};
export type ManagedEntry = QueueEntry & { reception_policy?: ReceptionPolicy };

export function originalBrokerId(entry: QueueEntry): string | null {
  return (entry.visit as typeof entry.visit & { original_referred_broker_id?: string })?.original_referred_broker_id
    ?? entry.visit?.referred_broker_id ?? null;
}
export function allBrokersAbsent(brokers: Broker[]): boolean {
  return brokers.filter(b => !b.is_external_partner).every(b => b.presence_status === 'ausente');
}
export function absenceDecision(ownerId: string | null, wait: boolean): WaitingMode | 'direct' {
  return ownerId ? (wait ? 'nominal' : 'arrival') : (wait ? 'arrival' : 'direct');
}

export function directPosition(broker: Broker, brokers: Broker[]): number {
  const line = brokers.filter(b => !b.is_external_partner && !onlyOwn(b) && b.agency === broker.agency && b.sorteio_order != null)
    .sort((a, b) => a.sorteio_order! - b.sorteio_order! || a.id.localeCompare(b.id));
  return line.findIndex(b => b.id === broker.id) + 1;
}
export function freeDirectPosition(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[] = []): number {
  const candidate = brokers.find(b => b.id === entry.broker_id);
  if (!candidate || entry.queue_status !== 'chamando' || candidate.presence_status !== 'presente' ||
    !['livre', 'em_mesa'].includes(candidate.attendance_status)) return 0;
  const busy = new Set(queue.filter(e => e.id !== entry.id && ['chamando', 'em_atendimento'].includes(e.queue_status))
    .map(e => e.broker_id));
  // The candidate is em_mesa only because of THIS pending call. Include him at
  // his unchanged direct rank, excluding all other busy/paused/absent brokers.
  return directPosition(candidate, brokers.filter(b => b.presence_status === 'presente' &&
    b.shift === candidate.shift && !busy.has(b.id) &&
    (b.id === candidate.id || b.attendance_status === 'livre')));
}
export function canRefuseInverse(entry: ManagedEntry, brokers: Broker[], queue: QueueEntry[] = []): boolean {
  const broker = brokers.find(b => b.id === entry.broker_id);
  if (!broker || entry.queue_status !== 'chamando' || entry.queue_type !== 'decorado' ||
    originalBrokerId(entry) || entry.reception_policy?.mode || entry.reception_policy?.refusedIds.includes(broker.id)) return false;
  return [1, 2].includes(freeDirectPosition(entry, brokers, queue));
}

export function operationalDispatch(entry: QueueEntry, brokers: Broker[], clock: ScheduleClock,
  busy: Set<string>, policy: ReceptionPolicy | undefined, runEngine: () => Broker | undefined) {
  const ownerId = policy ? policy.ownerId : originalBrokerId(entry);
  const owner = brokers.find(b => b.id === ownerId);
  const roster = receptionRoster(brokers, clock);
  const available = roster.filter(b => isReceptionFree(b, busy) && !policy?.refusedIds.includes(b.id));
  const ownerFree = owner && roster.some(b => b.id === owner.id) && owner.presence_status === 'presente' &&
    !busy.has(owner.id) && (owner.attendance_status === 'livre' || onlyOwn(owner) && owner.attendance_status === 'apenas_indicacao');
  let broker: Broker | undefined;
  let rule: string | undefined;
  if (policy?.mode === 'nominal') {
    broker = ownerFree ? owner : undefined;
    rule = 'Espera nominal · Corretor próprio';
  } else if (policy?.mode === 'arrival') {
    broker = [...available].sort((a, b) => (a.arrived_at ?? '\uffff').localeCompare(b.arrived_at ?? '\uffff') || a.id.localeCompare(b.id))[0];
    rule = 'Espera prioritária · Primeiro corretor a chegar';
  } else if (owner && !owner.is_external_partner && owner.agency !== 'Externo') {
    // The explicit change of mind always asks for another broker. It must not
    // reuse the pre-opening shortcut that bypasses team/company reverse order.
    const reverse = available.filter(b => b.id !== owner.id).sort((a, b) =>
      (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0) ||
      (b.arrived_at ?? '').localeCompare(a.arrived_at ?? '') || b.id.localeCompare(a.id));
    broker = policy?.mode !== 'coverage' && ownerFree ? owner :
      reverseCoverage(reverse, owner, busy) ?? reverse.find(b => b.agency !== owner.agency);
    rule = broker?.id === owner.id ? 'Corretor próprio' : broker?.agency !== owner.agency ? 'Transbordo Interempresas' :
      broker?.equipe === owner.equipe ? 'Último da Equipe' : 'Último da Empresa';
  } else if (policy?.refusedIds.length) {
    broker = [...available].sort((a, b) => (a.inverse_order ?? Infinity) - (b.inverse_order ?? Infinity) || a.id.localeCompare(b.id))[0];
    rule = 'Fila Inversa';
  } else {
    const result = resolveReceptionDispatch(entry, brokers, clock, busy, runEngine);
    return { ...result, rule: undefined };
  }
  const split = Boolean(ownerId && broker && ownerId !== broker.id);
  return { broker, split, rule: broker ? `${rule}${split ? ' (Split)' : ''}` : undefined };
}
