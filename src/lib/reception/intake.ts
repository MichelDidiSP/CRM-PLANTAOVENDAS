import { supabase, type Visit, type QueueEntry, type Broker, type VisitReason } from '../supabase';
export const normalizePhone = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');
export const firstName = (value?: string | null) => value?.trim().split(/\s+/)[0] || '—';
export function maskPhone(value: string) {
  const d = normalizePhone(value).slice(0, 11);
  if (d.length < 3) return d ? `(${d}` : '';
  const split = d.length > 10 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, split)}${d.length > split ? '-' + d.slice(split) : ''}`;
}
export function completePhone(value: string) {
  const d = normalizePhone(value);
  return d.length === (d[2] === '9' ? 11 : 10);
}
export function visitOwner(visits: Visit[], entries: QueueEntry[], phone: string) {
  if (!completePhone(phone)) return null;
  const matches = visits.filter(v => normalizePhone(v.phone) === normalizePhone(phone)).sort((a,b) => a.created_at.localeCompare(b.created_at));
  for (const visit of matches) {
    const served = entries.filter(e => e.visit_id === visit.id && e.broker_id && ['em_atendimento', 'concluido'].includes(e.queue_status)).sort((a,b) => a.created_at.localeCompare(b.created_at))[0];
    const assigned = entries.find(e => e.visit_id === visit.id && e.broker_id && e.queue_status === 'chamando');
    const ownerId = visit.referred_broker_id || served?.broker_id || assigned?.broker_id;
    if (ownerId) return { visit, ownerId };
  }
  return null;
}
export async function lookupReturn(phone: string) {
  const digits = normalizePhone(phone);
  if (!completePhone(digits)) return null;
  const { data, error } = await supabase.from('visits').select('*').eq('phone', digits).order('created_at', { ascending: true });
  if (error) throw error;
  if (!data?.length) return null;
  const history = await supabase.from('queue_entries').select('*').in('visit_id', data.map((v: Visit) => v.id));
  if (history.error) throw history.error;
  return visitOwner(data, history.data ?? [], digits);
}
export function intakeRoute(phone: string, declined: boolean, reason: VisitReason, ownerId: string | null, previous: Awaited<ReturnType<typeof lookupReturn>>) {
  const digits = declined ? '' : normalizePhone(phone);
  if (!digits) return { phone: null, visit_reason: 'Visita ao Decorado' as VisitReason, referred_broker_id: null, queue_type: 'decorado' };
  if (!completePhone(digits)) throw new Error('Complete o telefone com DDD ou marque que o cliente não forneceu telefone.');
  return { phone: digits, visit_reason: previous ? 'Retorno' as VisitReason : reason, referred_broker_id: previous?.ownerId ?? ownerId, queue_type: reason === 'Visita ao Decorado' && !previous ? 'decorado' : 'geral' };
}
export function attendanceTrace(entry: QueueEntry | undefined, brokers: Broker[]) {
  if (!entry) return 'Atendente: aguardando definição';
  const visit = entry.visit as (Visit & { original_referred_broker_id?: string | null; pre_opening_assignee?: string }) | undefined;
  const owner = brokers.find(b => b.id === (visit?.original_referred_broker_id ?? visit?.referred_broker_id));
  const actual = brokers.find(b => b.id === entry.broker_id);
  const trace = entry as QueueEntry & { original_broker_name?: string; attending_broker_name?: string; applied_rule?: string };
  const original = trace.original_broker_name || owner?.operational_name;
  const attended = trace.attending_broker_name || actual?.operational_name;
  const serving = ['em_atendimento','concluido'].includes(entry.queue_status);
  const label = serving ? 'Corretor que atendeu' : 'Corretor designado';
  if (!original) return `${label}: ${attended ?? 'aguardando definição'}`;
  const rule = trace.applied_rule || (actual && owner && actual.id !== owner.id ? (visit?.pre_opening_assignee === actual.id ? 'Primeiro inscrito da Empresa (pré-plantão)' : actual.agency === owner.agency && actual.equipe && actual.equipe === owner.equipe ? 'Último da Equipe' : 'Último da Empresa') : actual ? 'Corretor próprio' : 'Aguardando definição');
  return `${entry.visit?.visit_reason ?? ''} · Corretor original: ${original} · ${label}: ${attended ?? 'aguardando definição'} · ${rule}`;
}
export const recentVisits = (visits: Visit[]) => [...visits].sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0,5);
