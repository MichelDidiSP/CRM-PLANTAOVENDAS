import { getPlantaoTime } from '@/lib/plantaoClock';
import { dbReady, supabase } from '../supabase';
import { loadReportRows } from './reportStore';
import { businessDate, shiftClosingReport, type ReportRow } from './shiftClosingReport';

export type ClosingSummary = {
  date: string;
  closed_at: string;
  rows: ReportRow[];
  recipients: { role: 'gerencia' | 'diretoria'; whatsapp: string | null; email: string | null }[];
};

export function closingText(summary: ClosingSummary) {
  const report = shiftClosingReport(summary.rows, { period: 'day', date: summary.date, shift: 'manha' });
  return [
    `Relatório Quantitativo Final — ${summary.date.split('-').reverse().join('/')}`,
    `Total de registros: ${report.total}`,
    ...report.companies.map(row => `${row.label}: ${row.count}`),
    'Tipos de visita',
    ...report.types.filter(row => row.count > 0).map(row => `${row.label}: ${row.count}`),
    'Origem por canal de mídia',
    ...report.media.map(row => `${row.label}: ${row.count}`),
  ].join('\n');
}

export function closingShareLinks(summary: ClosingSummary) {
  const message = closingText(summary);
  return summary.recipients.map(recipient => ({
    role: recipient.role,
    whatsapp: recipient.whatsapp
      ? `https://wa.me/${recipient.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(message)}` : null,
    email: recipient.email
      ? `mailto:${encodeURIComponent(recipient.email)}?subject=${encodeURIComponent(message.split('\n')[0])}&body=${encodeURIComponent(message)}` : null,
  }));
}

export async function isPlantaoClosed(date: string) {
  await dbReady;
  const result = typeof supabase.rpc === 'function'
    ? await supabase.rpc('is_plantao_closed', { day: date })
    : await supabase.from('plantao_daily_closures').select('date').eq('date', date).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return Boolean(result.data);
}

export async function closePlantao(date: string, operationId = 'operacao_stand'): Promise<ClosingSummary> {
  await dbReady;
  if (typeof supabase.rpc === 'function') {
    const { data, error } = await supabase.rpc('close_plantao_operation', { day: date, at_time: getPlantaoTime().toISOString() });
    if (error) throw new Error(error.message);
    return data as ClosingSummary;
  }
  const saved = await supabase.from('plantao_daily_closures').select('*').eq('date', date).maybeSingle();
  if (saved.error) throw new Error(saved.error.message);
  if (saved.data) {
    const { date: savedDate, closed_at, rows, recipients } = saved.data;
    return { date: savedDate, closed_at, rows, recipients } as ClosingSummary;
  }
  const [facts, queue, direct, partners, reservations, partnerDetails] = await Promise.all([
    loadReportRows({ period: 'day', date, shift: 'manha' }),
    supabase.from('queue_entries').select('*, visit:visits(*), broker:brokers(*)'),
    supabase.from('incorporadora_direct_leads').select('*'),
    supabase.from('external_partner_intakes').select('*').eq('manager_status', 'acknowledged'),
    supabase.from('external_partner_reservations').select('*'),
    supabase.from('partner_reception_details').select('*'),
  ]);
  for (const result of [queue, direct, partners, reservations]) {
    if (result.error) throw new Error(result.error.message);
  }
  const customers = [
    ...(queue.data ?? []).flatMap(entry => entry.visit && ['em_atendimento', 'concluido'].includes(entry.queue_status)
      && businessDate(entry.visit.created_at) === date ? [{
        name: entry.visit.customer_name, phone: entry.visit.phone, media: entry.visit.media_channel,
        type: entry.visit.visit_reason, broker: entry.attending_broker_name ?? entry.broker?.operational_name,
        broker_id: entry.broker_id, commission_split: Boolean(entry.commission_split),
        ...(entry.visit.visit_reason === 'Atendimento Agendado' ? { scheduled_time: entry.visit.scheduled_time ?? null, designated_broker_id: entry.visit.designated_broker_id ?? null } : {}),
      }] : []),
    ...(direct.data ?? []).filter(row => businessDate(row.created_at) === date).map(row => ({
      name: row.customer_name, phone: row.phone, media: row.media_channel, type: row.visit_reason, broker: null,
      ...(row.visit_reason === 'Atendimento Agendado' ? { scheduled_time: row.scheduled_time ?? null, designated_broker_id: null } : {}),
    })),
    ...(partners.data ?? []).filter(row => businessDate(row.created_at) === date).map(row => {
      const reservation = (reservations.data ?? []).find(item => item.intake_id === row.id);
      const intakeDetails = (partnerDetails.data ?? []).find(item => item.intake_id === row.id);
      return { name: reservation?.customer_full_name ?? intakeDetails?.customer_name ?? row.client_first_name,
        phone: reservation?.customer_phone ?? intakeDetails?.phone ?? null, media: intakeDetails?.media_channel ?? null, type: 'Parceria', broker: row.partner_name };
    }),
  ];
  const summary: ClosingSummary = { date, closed_at: getPlantaoTime().toISOString(), rows: facts, recipients: [] };
  const result = await supabase.from('plantao_daily_closures').insert({ ...summary, closed_by: operationId, customers });
  if (result.error) throw new Error(result.error.message);
  await supabase.from('plantao_sessions').update({ status: 'ended', ended_at: summary.closed_at })
    .eq('plantao_date', date).eq('status', 'active');
  return summary;
}
