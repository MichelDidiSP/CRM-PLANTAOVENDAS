import type { Broker, QueueEntry, Visit } from '@/lib/supabase';
export const receptionDay = '2040-01-23';
export const receptionAt = `${receptionDay}T11:30:00.000Z`;
export const receptionClock = { seconds: 8 * 3600 + 30 * 60, singleShift: false, date: receptionDay };
export function person(id: string, patch: Partial<Broker> = {}): Broker {
  return { id, operational_name: id, agency: 'Viva Imóveis', equipe: 'A', presence_status: 'presente', attendance_status: 'livre',
    arrived_at: receptionAt, last_status_update: receptionAt, is_external_partner: false, external_company: null,
    sorteio_order: 1, inverse_order: 1, shift: 'manha', afternoon_reserved: false, returning_from_pause: false,
    created_at: receptionAt, ...patch };
}
export function customer(patch: Partial<Visit> = {}): Visit {
  return { id: 'visit', customer_name: 'Maria Cliente Completo', phone: '11987654321', visit_reason: 'Retorno',
    referred_broker_id: 'Didi', status: 'aguardando', created_at: receptionAt, updated_at: receptionAt, ...patch };
}
export function waiting(patch: Partial<QueueEntry> = {}): QueueEntry {
  return { id: 'queue', visit_id: 'visit', broker_id: null, agency: 'Viva Imóveis', queue_status: 'aguardando', attempts: 0,
    called_at: null, reentry_at: null, queue_type: 'geral', reception_waiting: true, sorteio_session: null,
    shift: 'manha', created_at: receptionAt, updated_at: receptionAt, visit: customer(), ...patch };
}
