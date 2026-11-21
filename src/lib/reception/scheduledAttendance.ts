import { supabase, type Broker, type QueueEntry } from '../supabase';
import { completePhone, normalizePhone } from './intake';
import { busyReceptionIds, isReceptionFree, receptionRoster } from './fallbackOrchestrator';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { claimReceptionCall } from './fallbackStore';
import { concludeAttendance } from '../queueEngine';

export const SCHEDULED_REASON = 'Atendimento Agendado' as const;
export function scheduledRoute(phone: string, time: string, brokerId: string | null) {
  const digits = normalizePhone(phone);
  if (!completePhone(digits)) throw new Error('Complete o telefone com DDD para o Atendimento Agendado.');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Confira o horário agendado.');
  return { phone: digits, visit_reason: SCHEDULED_REASON, referred_broker_id: null, queue_type: 'geral' as const,
    scheduled_time: time || null, designated_broker_id: brokerId || null };
}
export function designatedScheduledBroker(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[], clock: ScheduleClock) {
  const id = entry.visit?.designated_broker_id;
  return receptionRoster(brokers, clock).find(b => b.id === id && isReceptionFree(b, busyReceptionIds(queue)));
}
/** A designation is not an indication: no original owner, Fifty or protected turn. */
export async function dispatchDesignatedAppointment(entry: QueueEntry, brokers: Broker[], queue: QueueEntry[], clock: ScheduleClock, at: string) {
  if (entry.queue_status !== 'aguardando') return false;
  const broker = designatedScheduledBroker(entry, brokers, queue, clock);
  if (!broker) return false;
  const called = await claimReceptionCall(entry, broker, false, at, true);
  if (called) {
    const result = await supabase.from('queue_entries').update({ applied_rule: 'Atendimento Agendado · Fila Direta' })
      .eq('id', entry.id).eq('broker_id', broker.id).eq('queue_status', 'chamando');
    if (result.error) throw new Error(result.error.message);
  }
  return called;
}
/** Feed the frozen completion motor the existing ordinary-visit semantics. */
export async function concludePlantaoAttendance(entry: QueueEntry, at: string) {
  if (entry.visit?.visit_reason !== SCHEDULED_REASON) return concludeAttendance(entry, at);
  const live = await supabase.from('queue_entries').select('queue_status').eq('id', entry.id).single();
  if (live.error) throw new Error(live.error.message);
  if (live.data?.queue_status === 'concluido') return;
  return concludeAttendance({ ...entry, visit: { ...entry.visit, visit_reason: 'Primeira visita' } }, at);
}
