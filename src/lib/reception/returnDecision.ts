import type { Broker, QueueEntry } from '../supabase';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { busyReceptionIds, isReceptionFree, receptionRoster } from './fallbackOrchestrator';
import { operationalDispatch, originalBrokerId, type ReceptionPolicy } from './operationalChoices';

export function waitingReturn(entry: QueueEntry): boolean {
  return entry.queue_status === 'aguardando' && entry.visit?.visit_reason === 'Retorno' && Boolean(originalBrokerId(entry));
}
/** A free interval can change even while the TESTE clock is stopped. */
export function availabilityKey(broker: Broker, queue: QueueEntry[]): string {
  return JSON.stringify([broker.arrived_at, broker.last_status_update,
    queue.filter(e => e.broker_id === broker.id).map(e => [e.id, e.queue_status, e.called_at]).sort()]);
}
export function returnDecision(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[], clock: ScheduleClock, policy: ReceptionPolicy) {
  const busy = busyReceptionIds(queue.filter(e => e.id !== entry.id));
  const original = operationalDispatch(entry, brokers, clock, busy, { ...policy, mode: 'nominal' }, () => undefined);
  if (original.broker) return { kind: 'original' as const, choice: original };
  const free = receptionRoster(brokers, clock).filter(b => b.id !== policy.ownerId && isReceptionFree(b, busy));
  const declined = policy.returnConfirmation?.declined ?? {};
  const available = free.filter(b => declined[b.id] !== availabilityKey(b, queue));
  const pending = policy.returnConfirmation?.offer;
  const offered = available.find(b => b.id === pending?.brokerId && availabilityKey(b, queue) === pending.availability);
  // Keep a still-valid offer stable. Acceptance must refer to the broker the
  // receptionist actually showed to the client, even if a new broker arrives.
  const excluded = new Set([...busy, ...brokers.filter(b => b.id !== policy.ownerId &&
    !(offered ? b.id === offered.id : available.some(a => a.id === b.id))).map(b => b.id)]);
  const choice = operationalDispatch(entry, brokers, clock, excluded,
    { ...policy, mode: policy.mode === 'arrival' ? 'arrival' : 'coverage' }, () => undefined);
  return choice.broker ? { kind: 'offer' as const, choice, availability: availabilityKey(choice.broker, queue) }
    : { kind: 'wait' as const };
}
