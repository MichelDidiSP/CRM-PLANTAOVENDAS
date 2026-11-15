import { supabase, dbReady } from '../supabase';
import { scopeRows, attendanceType, businessDate, normalizedMedia, periodBounds, type ReportFilter, type ReportRow, type ReportShift } from './shiftClosingReport';
// Simulator cache retains only quantitative dimensions and technical event IDs.
const cache = new Map<string, ReportRow>();
export async function loadReportRows(filter: ReportFilter): Promise<ReportRow[]> {
  if (filter.scope === 'imobiliaria' && !filter.company?.trim()) return [];
  await dbReady;
  const { start, end } = periodBounds(filter);
  if (typeof supabase.rpc === 'function') {
    const rows: ReportRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.rpc('quantitative_report_rows', { from_date: start, to_date: end, company_filter: filter.scope === 'imobiliaria' ? filter.company!.trim() : null }).range(offset, offset + 999);
      if (error) throw error;
      const page = data ?? [];
      rows.push(...page.map((r: Record<string, unknown>) => ({ date: String(r.report_date), shift: r.report_shift as ReportShift, company: String(r.company), team: String(r.team), type: r.attendance_type as ReportRow['type'], media: String(r.media_channel), count: Number(r.total) })));
      if (page.length < 1000) return scopeRows(rows,filter);
    }
  }
  // Separate column projections deliberately exclude all customer names and phones.
  const [queue, visits, brokers, partners, sessions] = await Promise.all([
    supabase.from('queue_entries').select('id,visit_id,broker_id,agency,queue_type,queue_status,shift,created_at'),
    supabase.from('visits').select('id,visit_reason,media_channel,created_at'),
    supabase.from('brokers').select('id,agency,equipe'),
    supabase.from('external_partner_intakes').select('id,created_at,manager_status,company'),
    supabase.from('plantao_sessions').select('id,plantao_date'),
  ]);
  for (const result of [queue,visits,brokers,partners,sessions]) if (result.error) throw result.error;
  for (const entry of queue.data ?? []) {
    if (!['em_atendimento','concluido'].includes(entry.queue_status)) continue;
    const visit = visits.data?.find(v=>v.id===entry.visit_id);
    const broker = brokers.data?.find(b=>b.id===entry.broker_id);
    const key = `queue:${entry.id}`;
    const previous = cache.get(key);
    cache.set(key, { date: previous?.date ?? businessDate(visit?.created_at ?? entry.created_at), shift: entry.shift ?? 'manha', company: previous?.company ?? broker?.agency ?? entry.agency ?? 'Empresa não informada', team: previous?.team ?? broker?.equipe ?? 'Sem Equipe', type: previous?.type ?? attendanceType(visit?.visit_reason,entry.queue_type), media: previous?.media ?? normalizedMedia(visit?.media_channel), count:1 });
  }
  for (const partner of partners.data ?? []) {
    if (partner.manager_status !== 'acknowledged') continue;
    const date = businessDate(partner.created_at);
    const time = new Date(partner.created_at).toLocaleTimeString('sv-SE',{timeZone:'America/Sao_Paulo'});
    const afternoon = sessions.data?.some(s=>s.id===`schedule_${date}_afternoon`);
    const key = `partner:${partner.id}`;
    if (!cache.has(key)) cache.set(key,{date,shift: afternoon && time >= '14:00:01' ? 'tarde':'manha',company:partner.company?.trim() || 'Autônomo',team:'Parcerias',type:'Parceria Externa',media:'Outros',count:1});
  }
  return scopeRows([...cache.values()].filter(r=>r.date>=start && r.date<=end),filter);
}
