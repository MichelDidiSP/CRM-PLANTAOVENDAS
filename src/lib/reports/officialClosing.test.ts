import { expect, it } from 'vitest';
import { supabase } from '../supabase';
import { saveDirectLead } from '../reception/fallbackStore';
import { closePlantao, closingShareLinks, closingText, isPlantaoClosed } from './officialClosing';
import { loadReportRows } from './reportStore';

it('inclui a entrada direta nos fatos e guarda o cadastro apenas no snapshot nominal', async () => {
  const date = '2040-01-21';
  const created_at = date + 'T10:00:00-03:00';
  await saveDirectLead({
    customer_name: 'Cliente Exclusivo', phone: '11912345678', visit_reason: 'Primeira visita',
    media_channel: 'Google / Pesquisa', media_channel_detail: null, created_at, shift: 'manha',
  });
  expect(await isPlantaoClosed(date)).toBe(false);
  const filter = { period: 'day' as const, date, shift: 'manha' as const };
  expect(await loadReportRows(filter)).toEqual([expect.objectContaining({
    company: 'Incorporadora', count: 1, type: 'Primeira Visita', media: 'Google / Pesquisa',
  })]);
  expect(await loadReportRows({ ...filter, scope: 'imobiliaria', company: 'Casa Nobre' })).toEqual([]);
  const visit = await supabase.from('visits').insert({ customer_name: 'Cliente Atendido', phone: '11955555555',
    visit_reason: 'Retorno', media_channel: 'Outros', created_at }).select().single();
  const broker = await supabase.from('brokers').insert({ operational_name: 'Corretora', agency: 'Casa Nobre', equipe: 'Equipe' })
    .select().single();
  await supabase.from('queue_entries').insert({ visit_id: visit.data.id, broker_id: broker.data.id,
    commission_split: true, queue_type: 'geral', queue_status: 'concluido', shift: 'manha', created_at });
  const result = await closePlantao(date);
  expect(await isPlantaoClosed(date)).toBe(true);
  expect(await closePlantao(date)).toEqual(expect.objectContaining({ rows: result.rows, closed_at: result.closed_at }));
  expect(closingText(result)).toContain('Total de registros: 2');
  expect(JSON.stringify(result)).not.toMatch(/Cliente Exclusivo|Cliente Atendido|11912345678|11955555555/);
  const { data } = await supabase.from('plantao_daily_closures').select('customers').eq('date', date).single();
  expect(data.customers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Cliente Exclusivo', phone: '11912345678', media: 'Google / Pesquisa', broker: null }),
    expect.objectContaining({ name: 'Cliente Atendido', phone: '11955555555', media: 'Outros', type: 'Retorno', broker: 'Corretora', commission_split: true }),
  ]));
  const links = closingShareLinks({ ...result, recipients: [
    { role: 'gerencia', whatsapp: '5511999990000', email: null },
    { role: 'diretoria', whatsapp: null, email: 'diretoria@example.com' },
  ] });
  expect(links[0].whatsapp).toMatch(/^https:\/\/wa.me\/5511999990000\?text=/);
  expect(decodeURIComponent(links[1].email ?? '')).toContain('mailto:diretoria@example.com?subject=Relatório Quantitativo Final');
  expect(decodeURIComponent(JSON.stringify(links))).not.toMatch(/Cliente Exclusivo|Cliente Atendido|11912345678|11955555555/);
});
