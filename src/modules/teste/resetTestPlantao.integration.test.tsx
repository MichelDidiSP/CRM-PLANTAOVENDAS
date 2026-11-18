// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '@/App';
import { dbReady, supabase } from '@/lib/supabase';
import { publishClock } from '@/lib/plantaoClock';
import { isPlantaoClosed, closePlantao } from '@/lib/reports/officialClosing';
import { loadReportRows } from '@/lib/reports/reportStore';

const day = '2044-02-17';
const previousDay = '2044-02-16';
let root: Root;
let container: HTMLDivElement;
async function rows(table: string) { return (await supabase.from(table).select('*')).data!; }
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 200; i++) await Promise.resolve(); });
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(found, text).toBeDefined(); return found!;
}
async function click(text: string) { await settle(() => button(text).click()); }
const dateFilter = (date: string) => ({ date, period: 'day' as const, shift: 'manha' as const });

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${day}T10:00:00Z`));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  localStorage.clear(); publishClock(); await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions', 'plantao_daily_closures', 'incorporadora_direct_leads',
    'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details', 'relatorio_fechamento']) {
    await supabase.from(table).delete().neq('id', '');
  }
  await supabase.from('brokers').insert({ id: 'he-man', operational_name: 'He-Man', agency: 'Casa Nobre', equipe: 'Equipe original',
    is_external_partner: false, presence_status: 'pausa', attendance_status: 'livre', arrived_at: `${day}T08:00:00-03:00`,
    last_status_update: `${day}T08:10:00-03:00`, shift: 'manha', sorteio_order: 3, inverse_order: 4,
    pause_started_at: `${day}T08:10:00-03:00`, pause_scope: `${day}:manha`, pause_direct_snapshot: ['he-man'],
    returning_from_pause: true, only_own_referrals: true, restriction_reason: 'pause', restriction_scope: `${day}:manha` });
  for (const [date, suffix] of [[day, 'today'], [previousDay, 'old']]) {
    const at = `${date}T08:20:00-03:00`;
    await supabase.from('visits').insert({ id: `visit-${suffix}`, customer_name: `Cliente ${suffix}`, phone: suffix === 'today' ? '11911112222' : '11922223333',
      visit_reason: 'Retorno', media_channel: 'Google', status: 'em_atendimento', is_test: true, created_at: at });
    await supabase.from('queue_entries').insert({ id: `queue-${suffix}`, visit_id: `visit-${suffix}`, broker_id: 'he-man',
      queue_status: 'concluido', queue_type: 'geral', shift: 'manha', agency: 'Casa Nobre', created_at: at });
    await supabase.from('incorporadora_direct_leads').insert({ id: `direct-${suffix}`, customer_name: `Direto ${suffix}`, phone: '11944445555',
      visit_reason: 'Primeira visita', media_channel: 'Google', shift: 'manha', is_test: true, created_at: at });
    await supabase.from('plantao_sessions').insert({ id: `schedule_${date}_morning`, plantao_date: date, status: 'ended',
      schedule_data: { viva: [], nobre: ['he-man'], inverse: ['he-man'], firstAgency: 'Casa Nobre' } });
    await supabase.from('pause_audit').insert({ id: `pause-${suffix}`, broker_id: 'he-man', scope: `${date}:manha`, occurred_at: at });
    await supabase.from('relatorio_fechamento').insert({ id: `report-${suffix}`, shift: 'manha', snapshot_data: [], created_at: at });
  }
  await supabase.from('visits').insert({ id: 'real-visit', customer_name: 'Cadastro real', phone: '11955556666',
    is_test: false, visit_reason: 'Primeira visita', status: 'aguardando', created_at: `${day}T08:20:00-03:00` });
  await supabase.from('external_partner_intakes').insert({ id: 'partner-today', partner_name: 'Parceiro', company: 'Externa',
    client_first_name: 'Cliente', manager_status: 'acknowledged', created_at: `${day}T08:20:00-03:00` });
  await supabase.from('external_partner_reservations').insert({ id: 'reservation', intake_id: 'partner-today' });
  await supabase.from('partner_reception_details').insert({ id: 'details', intake_id: 'partner-today', media_channel: 'Google' });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('fecha pelo botão, preserva snapshot nominal e depois limpa o dia pelo TESTE sem perder fatos ou corretores', async () => {
  const roster = (await rows('brokers')).map(({ id, operational_name, agency, equipe }) => ({ id, operational_name, agency, equipe }));
  const previous = Object.fromEntries(await Promise.all(['visits', 'queue_entries', 'incorporadora_direct_leads', 'plantao_sessions', 'pause_audit', 'relatorio_fechamento']
    .map(async table => [table, (await rows(table)).filter(row => row.id.includes('old') || row.plantao_date === previousDay)])));
  await settle(() => root.render(<App />)); await click('TESTE');
  const facts = await loadReportRows(dateFilter(day));
  expect(facts.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  const oldFacts = await loadReportRows(dateFilter(previousDay));
  await click('Fechar Plantão');
  expect(await isPlantaoClosed(day)).toBe(true);
  expect(container.textContent).toContain('Relatório Quantitativo Final');
  expect(container.querySelector('input[type="password"]')).toBeNull();
  const snapshot = (await rows('plantao_daily_closures'))[0];
  expect(snapshot.closed_by).toBe('operacao_stand');
  expect(snapshot.customers).toContainEqual(expect.objectContaining({ name: 'Cliente today', phone: '11911112222', broker: 'He-Man' }));
  expect(snapshot.customers).toContainEqual(expect.objectContaining({ name: 'Direto today', phone: '11944445555', broker: null }));
  expect(JSON.stringify(await closePlantao(day))).not.toContain('11911112222');
  await click('Reiniciar Plantão'); await click('Confirmar reinício');
  expect(await isPlantaoClosed(day)).toBe(false);
  for (const [table, oldRows] of Object.entries(previous)) {
    const result = await rows(table);
    expect(result.filter(row => row.id.includes('today') || row.plantao_date === day), table).toEqual([]);
    expect(result.filter(row => row.id.includes('old') || row.plantao_date === previousDay), table).toEqual(oldRows);
  }
  for (const table of ['external_partner_intakes', 'external_partner_reservations', 'partner_reception_details', 'plantao_daily_closures']) {
    expect(await rows(table), table).toEqual([]);
  }
  expect((await rows('visits')).find(row => row.id === 'real-visit')).toMatchObject({ customer_name: 'Cadastro real', status: 'encerrado' });
  expect((await rows('brokers')).map(({ id, operational_name, agency, equipe }) => ({ id, operational_name, agency, equipe }))).toEqual(roster);
  expect((await rows('brokers'))[0]).toMatchObject({ presence_status: 'ausente', attendance_status: 'livre',
    sorteio_order: null, inverse_order: null, shift: null, pause_started_at: null, pause_scope: null,
    pause_direct_snapshot: [], returning_from_pause: false, only_own_referrals: false });
  expect(await loadReportRows(dateFilter(day))).toEqual(facts);
  expect(await loadReportRows(dateFilter(previousDay))).toEqual(oldFacts);
  expect(container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe('08:30:00');
  expect(container.textContent).not.toContain('Cliente today');
  expect(container.textContent).not.toContain('Direto today');
  expect(container.textContent).not.toContain('Relatório Quantitativo Final');
  expect(button('Fechar Plantão').disabled).toBe(false);
  expect(button('Simular Entrada Rápida').disabled).toBe(false);
});
