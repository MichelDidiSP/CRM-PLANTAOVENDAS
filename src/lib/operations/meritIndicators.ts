import { dbReady, supabase, type QueueEntry } from '../supabase';

export const MERIT_INDICATORS = ['indicacao', 'retorno', 'reserva', 'pasta_documentos'] as const;
export type MeritIndicator = typeof MERIT_INDICATORS[number];
export type MeritEvent = { source_key: string; broker_id: string; indicator: MeritIndicator; occurred_at: string; is_test: boolean };
const check = (error: { message: string } | null) => { if (error) throw new Error(error.message); };

/** A reception event is valid only after attendance starts; the original owner receives credit. */
export function receptionMeritEvent(entry: QueueEntry): MeritEvent | null {
  if (!['em_atendimento', 'concluido'].includes(entry.queue_status) || !entry.broker_id || !entry.visit) return null;
  const reason = entry.visit.visit_reason;
  const indicator = reason === 'Retorno' ? 'retorno' : reason.startsWith('Indicação') ? 'indicacao' : null;
  if (!indicator) return null;
  return { source_key: `queue:${entry.id}`, broker_id: entry.visit.referred_broker_id || entry.broker_id,
    indicator, occurred_at: entry.updated_at || entry.called_at || entry.created_at, is_test: entry.visit.is_test === true };
}
async function writeMockEvent(event: MeritEvent, validateDuplicate = false) {
  const existing = await supabase.from('merit_indicator_events').select('*').eq('source_key', event.source_key).eq('indicator', event.indicator).maybeSingle();
  check(existing.error);
  if (existing.data) {
    if (validateDuplicate && (existing.data.broker_id !== event.broker_id || existing.data.occurred_at !== event.occurred_at || existing.data.is_test !== event.is_test))
      throw new Error('Este evento já foi registrado com outros dados.');
    return;
  }
  const result = await supabase.from('merit_indicator_events').insert(event); check(result.error);
}
// Serialize each event key in the memory adapter as the SQL UNIQUE constraint does.
const pendingEvents = new Map<string, Promise<void>>();
async function insertMockEvent(event: MeritEvent, validateDuplicate = false) {
  const key = JSON.stringify([event.indicator, event.source_key]);
  const previous = pendingEvents.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => writeMockEvent(event, validateDuplicate));
  pendingEvents.set(key, task);
  try { await task; } finally { if (pendingEvents.get(key) === task) pendingEvents.delete(key); }
}
export async function synchronizeMeritIndicators(queue: QueueEntry[]) {
  await dbReady;
  // PostgreSQL records these atomically in the attendance transition trigger.
  if (typeof supabase.rpc === 'function') return;
  for (const entry of queue) { const event = receptionMeritEvent(entry); if (event) await insertMockEvent(event); }
}
/** Integration contract for Vendas. No scoring, ranking or queue mutations. */
export async function recordSalesMeritEvent(event: MeritEvent & { indicator: 'reserva' | 'pasta_documentos' }) {
  if (!['reserva', 'pasta_documentos'].includes(event.indicator) || !event.source_key.trim() || !event.broker_id || !Number.isFinite(Date.parse(event.occurred_at)))
    throw new Error('Informe corretor, indicador, identificador do evento e data válidos.');
  await dbReady;
  if (typeof supabase.rpc === 'function') {
    const result = await supabase.rpc('record_sales_merit_event', { event }); check(result.error); return;
  }
  const broker = await supabase.from('brokers').select('id,is_external_partner').eq('id', event.broker_id).maybeSingle(); check(broker.error);
  if (!broker.data || broker.data.is_external_partner) throw new Error('Corretor interno não encontrado.');
  await insertMockEvent({ ...event, source_key: event.source_key.trim() }, true);
}
export async function meritIndicatorCounts(brokerId: string, from: string, until: string, includeTests = false): Promise<Record<MeritIndicator, number>> {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)) || Date.parse(from) >= Date.parse(until)) throw new Error('Janela de indicadores inválida.');
  await dbReady;
  if (typeof supabase.rpc === 'function') {
    const result = await supabase.rpc('merit_indicator_counts', { broker: brokerId, from_at: from, until_at: until, include_tests: includeTests });
    check(result.error); return result.data;
  }
  const events = await supabase.from('merit_indicator_events').select('*').eq('broker_id', brokerId); check(events.error);
  const counts = Object.fromEntries(MERIT_INDICATORS.map(kind => [kind, 0])) as Record<MeritIndicator, number>;
  for (const row of (events.data ?? []) as MeritEvent[]) if ((includeTests || !row.is_test) && Date.parse(row.occurred_at) >= Date.parse(from) && Date.parse(row.occurred_at) < Date.parse(until)) counts[row.indicator]++;
  return counts;
}
