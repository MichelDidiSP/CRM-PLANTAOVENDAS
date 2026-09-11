import { supabase, type Broker, type QueueEntry, type Visit, type VisitReason, type Agency, type QueueType } from './supabase';

const LATE_LIMIT_SECONDS = 8 * 3600 + 45 * 60 + 59; // 08:45:59

export function secondsSinceMidnight(date: Date): number {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

export function isLateForSort(arrivedAt: string | null): boolean {
  if (!arrivedAt) return true;
  const arrived = new Date(arrivedAt);
  return secondsSinceMidnight(arrived) > LATE_LIMIT_SECONDS;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function formatPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return phone;
}

export function sanitizePhone(input: string): string {
  return input.replace(/\D/g, '');
}

export const AGENCIES: Agency[] = ['Viva Imóveis', 'Casa Nobre'];
export const REASONS: VisitReason[] = ['Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Visita ao Decorado'];

export const QUEUE_TYPES: QueueType[] = ['geral', 'decorado', 'parceria'];

export function interleaveQueue(entries: QueueEntry[], brokers: Broker[]): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

  const viva = waiting.filter((e) => e.agency === 'Viva Imóveis').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));
  const nobre = waiting.filter((e) => e.agency === 'Casa Nobre').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));

  const interleaved: QueueEntry[] = [];
  const maxLen = Math.max(viva.length, nobre.length);
  for (let i = 0; i < maxLen; i++) {
    if (viva[i]) interleaved.push(viva[i]);
    if (nobre[i]) interleaved.push(nobre[i]);
  }

  return [...interleaved, ...sortedReentries];
}

export function reverseInterleaveQueue(entries: QueueEntry[], brokers: Broker[]): QueueEntry[] {
  return [...interleaveQueue(entries, brokers)].reverse();
}

const PRIORITY_REASONS: VisitReason[] = ['Retorno', 'Indicação'];

function sortKey(entries: QueueEntry[], brokers: Broker[], entry: QueueEntry): number {
  const visit = entries.find((e) => e.id === entry.id)?.visit;
  const broker = brokers.find((b) => b.id === entry.broker_id);

  if (broker && isLateForSort(broker.arrived_at)) return 999_999_000;

  const hasReferredBroker = visit?.referred_broker_id != null;
  const isPriority = visit != null && PRIORITY_REASONS.includes(visit.visit_reason) && hasReferredBroker;
  const priorityOffset = isPriority ? 0 : 500_000_000;

  if (visit) return priorityOffset + new Date(visit.created_at).getTime();
  return priorityOffset + new Date(entry.created_at).getTime();
}

export function nextBrokerFromInverseQueue(brokers: Broker[], sortedQueue: QueueEntry[]): Broker | undefined {
  const reversed = [...sortedQueue].reverse();
  for (const entry of reversed) {
    if (entry.broker_id) {
      const broker = brokers.find((b) => b.id === entry.broker_id);
      if (broker && !broker.is_external_partner && broker.presence_status === 'presente' && broker.attendance_status === 'livre') {
        return broker;
      }
    }
  }
  return brokers.find(
    (b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre',
  );
}

export async function fetchAll() {
  const [brokersRes, visitsRes, queueRes] = await Promise.all([
    supabase.from('brokers').select('*').order('created_at', { ascending: true }),
    supabase.from('visits').select('*').order('created_at', { ascending: true }),
    supabase.from('queue_entries').select('*, visit:visits(*), broker:brokers(*)').order('created_at', { ascending: true }),
  ]);

  return {
    brokers: (brokersRes.data ?? []) as Broker[],
    visits: (visitsRes.data ?? []) as Visit[],
    queue: (queueRes.data ?? []) as QueueEntry[],
    error: brokersRes.error || visitsRes.error || queueRes.error,
  };
}
