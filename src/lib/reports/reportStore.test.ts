import { it, expect } from 'vitest';
import { supabase } from '../supabase';
import { loadReportRows } from './reportStore';
import { shiftClosingReport } from './shiftClosingReport';
it('captures only actual services, preserves attribution and history, and moves shifts without duplication', async()=>{
 const date='2040-01-15', id='quant-report-test';
 const filter={period:'day' as const,date,shift:'manha' as const};
 await supabase.from('brokers').insert({id,agency:'Casa Nobre',equipe:'Original',operational_name:'Broker secret'});
 await supabase.from('visits').insert({id,created_at:date+'T10:00:00-03:00',visit_reason:'Retorno',media_channel:'Google',customer_name:'CLIENT SECRET',phone:'11999999999'});
 await supabase.from('queue_entries').insert({id,visit_id:id,broker_id:id,created_at:date+'T10:00:00-03:00',queue_status:'chamando',shift:'manha',agency:'Viva Imóveis',queue_type:'geral'});
 try {
  expect(shiftClosingReport(await loadReportRows(filter),filter).total).toBe(0);
  await supabase.from('queue_entries').update({queue_status:'em_atendimento'}).eq('id',id);
  let rows=await loadReportRows(filter);expect(shiftClosingReport(rows,filter).total).toBe(1);
  expect(rows[0]).toMatchObject({company:'Casa Nobre',team:'Original',type:'Retorno',media:'Google / Pesquisa'});
  for(const secret of ['CLIENT SECRET','11999999999','Broker secret',id])expect(JSON.stringify(rows)).not.toContain(secret);
  await supabase.from('brokers').update({agency:'Viva Imóveis',equipe:'Changed'}).eq('id',id);
  await supabase.from('queue_entries').update({queue_status:'concluido',shift:'tarde'}).eq('id',id);
  rows=await loadReportRows(filter);
  expect(rows[0]).toMatchObject({company:'Casa Nobre',team:'Original',shift:'tarde'});
  expect(shiftClosingReport(rows,{...filter,period:'shift'}).total).toBe(0);
  expect(shiftClosingReport(rows,{...filter,period:'shift',shift:'tarde'}).total).toBe(1);
  await supabase.from('queue_entries').delete().eq('id',id);
  expect(shiftClosingReport(await loadReportRows(filter),filter).total).toBe(1);
 } finally { await supabase.from('queue_entries').delete().eq('id',id);await supabase.from('visits').delete().eq('id',id);await supabase.from('brokers').delete().eq('id',id); }
});
it('counts an acknowledged external intake once, with no personal details or effect on queue order',async()=>{
 const id='quant-partner-test',date='2040-01-16'; const filter={period:'day' as const,date,shift:'manha' as const};
 const before=(await supabase.from('brokers').select('*')).data;
 await supabase.from('plantao_sessions').insert({id:`schedule_${date}_afternoon`,plantao_date:date});
 await supabase.from('external_partner_intakes').insert({id,created_at:date+'T15:00:00-03:00',manager_status:'pending',company:'Imobiliária Parceira',partner_name:'PARTNER SECRET',client_first_name:'CLIENT SECRET'});
 try {
  expect(shiftClosingReport(await loadReportRows(filter),filter).total).toBe(0);
  await supabase.from('external_partner_intakes').update({manager_status:'acknowledged'}).eq('id',id);
  await loadReportRows(filter);
  const rows=await loadReportRows(filter);expect(shiftClosingReport(rows,filter).total).toBe(1);
  expect(rows[0]).toMatchObject({shift:'tarde',company:'Imobiliária Parceira',type:'Parceria Externa',media:'Outros'});
  expect(JSON.stringify(rows)).not.toContain('SECRET');
  expect((await supabase.from('brokers').select('*')).data).toEqual(before);
 } finally { await supabase.from('external_partner_intakes').delete().eq('id',id);await supabase.from('plantao_sessions').delete().eq('id',`schedule_${date}_afternoon`); }
});
