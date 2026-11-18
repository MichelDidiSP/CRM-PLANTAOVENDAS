import { dbReady, supabase } from '@/lib/supabase';
import { getPlantaoTime } from '@/lib/plantaoClock';
import { businessDate } from '@/lib/reports/shiftClosingReport';
import { loadReportRows } from '@/lib/reports/reportStore';
import { resetAfternoonQueues, resetCompanyRotation } from '@/lib/queueEngine';

async function checked(query: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await query;
  if (error) throw new Error(error.message);
}

/** Disposable operational state belongs to TESTE, never to the queue engines. */
export async function resetTestPlantao(day: string, testModeActive: boolean) {
  if (!testModeActive) throw new Error('Ative o módulo TESTE para reiniciar o plantão.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error('Data de teste inválida.');
  await dbReady;
  const at = getPlantaoTime().toISOString();
  if (typeof supabase.rpc === 'function') {
    await checked(supabase.rpc('reset_test_plantao', { day, test_mode: true, at_time: at }));
  } else {
    // The in-memory adapter retains quantitative dimensions before deleting their sources.
    await loadReportRows({ period: 'day', date: day, shift: 'manha' });
    const [visits, queue, direct, partners, pauses, sessions, reports] = await Promise.all(
      ['visits', 'queue_entries', 'incorporadora_direct_leads', 'external_partner_intakes',
        'pause_audit', 'plantao_sessions', 'relatorio_fechamento'].map(table => supabase.from(table).select('*')),
    );
    for (const result of [visits, queue, direct, partners, pauses, sessions, reports]) if (result.error) throw new Error(result.error.message);
    const onDay = (value: string | null | undefined) => Boolean(value && businessDate(value) === day);
    const dayVisits = (visits.data ?? []).filter(row => onDay(row.created_at));
    const visitIds = new Set(dayVisits.map(row => row.id));
    const remove = async (table: string, ids: string[]) => {
      if (ids.length) await checked(supabase.from(table).delete().in('id', ids));
    };
    // Reopen first: the remote transaction uses the same order for closed-day triggers.
    await checked(supabase.from('plantao_daily_closures').delete().eq('date', day));
    await remove('queue_entries', (queue.data ?? []).filter(row => onDay(row.created_at) || visitIds.has(row.visit_id)).map(row => row.id));
    await remove('visits', dayVisits.filter(row => row.is_test).map(row => row.id));
    const realVisits = dayVisits.filter(row => !row.is_test).map(row => row.id);
    if (realVisits.length) await checked(supabase.from('visits').update({ status: 'encerrado', updated_at: at }).in('id', realVisits));
    await remove('incorporadora_direct_leads', (direct.data ?? []).filter(row => row.is_test && onDay(row.created_at)).map(row => row.id));
    const partnerIds = (partners.data ?? []).filter(row => onDay(row.created_at)).map(row => row.id);
    if (partnerIds.length) {
      await checked(supabase.from('external_partner_reservations').delete().in('intake_id', partnerIds));
      await checked(supabase.from('partner_reception_details').delete().in('intake_id', partnerIds));
      await remove('external_partner_intakes', partnerIds);
    }
    await remove('pause_audit', (pauses.data ?? []).filter(row => row.scope?.startsWith(`${day}:`) || onDay(row.occurred_at)).map(row => row.id));
    await remove('plantao_sessions', (sessions.data ?? []).filter(row => row.plantao_date === day || (!row.plantao_date && onDay(row.started_at))).map(row => row.id));
    await remove('relatorio_fechamento', (reports.data ?? []).filter(row => onDay(row.created_at)).map(row => row.id));
    await checked(supabase.from('brokers').update({
      presence_status: 'ausente', attendance_status: 'livre', arrived_at: null, shift: null,
      sorteio_order: null, inverse_order: null, afternoon_enrolled_at: null, afternoon_reserved: false,
      preserve_shift_position: false, leave_after_service: false, returning_from_pause: false, merit_priority_return: false,
      pause_started_at: null, pause_scope: null, pause_exit_index: null, pause_exit_order: null,
      pause_inverse_order: null, pause_direct_snapshot: [], manager_excused: false,
      only_own_referrals: false, restriction_reason: null, restriction_scope: null, last_status_update: at,
    }).neq('id', '00000000-0000-0000-0000-000000000000'));
  }
  resetCompanyRotation(); resetAfternoonQueues();
  try { localStorage.removeItem('schedule_rotation_session'); } catch { /* Storage is optional. */ }
}
