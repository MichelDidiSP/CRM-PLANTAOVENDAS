import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { dbReady, supabase } from '@/lib/supabase';
import { person, customer, waiting, receptionDay as day, receptionAt as at, receptionClock as clock } from './receptionFixtures';
import { automaticClosingDue, dispatchClock, publishDayExtension } from '@/lib/operations/dayExtension';
import { closeAt21, loadDayExtension, setDayExtension } from '@/lib/operations/dayStore';
import { installPlantaoClock } from '@/lib/plantaoClock';
import { closePlantao, isPlantaoClosed } from '@/lib/reports/officialClosing';
import { scheduledRoute, designatedScheduledBroker, concludePlantaoAttendance } from '@/lib/reception/scheduledAttendance';
import { dispatchReceptionEntry } from '@/lib/reception/returnDecisionStore';
import { fetchAll } from '@/lib/queueEngine';
import { loadReportRows } from '@/lib/reports/reportStore';
import { reportCsv, shiftClosingReport } from '@/lib/reports/shiftClosingReport';
import { MERIT_INDICATORS, meritIndicatorCounts, receptionMeritEvent, recordSalesMeritEvent, synchronizeMeritIndicators } from '@/lib/operations/meritIndicators';
import { resetTestPlantao } from './resetTestPlantao';

let uninstall: (() => void) | undefined;
function time(hour: string) { uninstall?.(); uninstall = installPlantaoClock({ now: () => Date.parse(`${day}T${hour}-03:00`) }); }
beforeEach(async () => {
  await dbReady; publishDayExtension(day, false); time('08:30:00');
  for (const table of ['brokers','visits','queue_entries','plantao_sessions','plantao_daily_closures','incorporadora_direct_leads','merit_indicator_events'])
    await supabase.from(table).delete().neq('id','');
});
afterEach(() => { uninstall?.(); publishDayExtension(day, false); });
async function appointment() {
  await supabase.from('brokers').insert([person('Didi',{ sorteio_order:1, inverse_order:2 }),person('Mussum',{ sorteio_order:2, inverse_order:1 })]);
  await supabase.from('visits').insert(customer({ ...scheduledRoute('11987654321','10:30','Didi') }));
  const {visit:_, ...entry} = waiting(); await supabase.from('queue_entries').insert(entry);
  return (await fetchAll()).queue[0];
}
describe('operação final — relógio e fechamento oficial', () => {
  it.each([['20:59:59',false],['21:00:00',true],['23:17:00',true]] as const)('fecha em %s somente quando devido', async (hour, due) => {
    time(hour); const result = await closeAt21(day,false);
    expect(Boolean(result)).toBe(due); expect(await isPlantaoClosed(day)).toBe(due);
    if(due) expect((await supabase.from('plantao_daily_closures').select('*').single()).data.closed_by).toBe('fechamento_automatico_21h');
  });
  it('não repete snapshot e não fecha dia diferente do relógio ativo', async () => {
    time('21:00:00'); const first = await closeAt21(day,false); time('22:00:00');
    expect(await closeAt21(day,false)).toEqual(first); expect(await closeAt21(day,true)).toBeNull();
    expect(await closeAt21('2040-01-24',false)).toBeNull();
    expect((await supabase.from('plantao_daily_closures').select('*')).data).toHaveLength(1);
  });
  it('persiste a exceção, mantém despacho aberto e permite fechamento manual', async () => {
    expect(await loadDayExtension(day)).toBe(false); await setDayExtension(day,true);
    publishDayExtension(day,false); expect(await loadDayExtension(day)).toBe(true);
    time('22:35:00'); expect(await closeAt21(day,false)).toBeNull();
    expect(dispatchClock({...clock,seconds:22*3600+35*60})).toEqual({...clock,seconds:21*3600-1});
    await closePlantao(day); expect(await isPlantaoClosed(day)).toBe(true);
    expect((await supabase.from('plantao_daily_closures').select('*').single()).data.closed_by).toBe('operacao_stand');
  });
  it('desativar a exceção após 21h permite fechamento imediato', async () => {
    await setDayExtension(day,true); time('21:01:00'); expect(await closeAt21(day,false)).toBeNull();
    await setDayExtension(day,false); expect(await closeAt21(day,false)).not.toBeNull();
  });
  it('a projeção é exclusiva do despacho e não modifica o relógio recebido', () => {
    const original = {...clock, seconds:22*3600};
    expect(dispatchClock(original,false)).toBe(original); expect(dispatchClock(clock,true)).toBe(clock);
    expect(dispatchClock(original,true).seconds).toBe(21*3600-1); expect(original.seconds).toBe(22*3600);
    expect(automaticClosingDue(21*3600,false,true)).toBe(false);
  });
  it('reinício de TESTE remove a extensão do dia sem apagar indicadores históricos', async () => {
    await setDayExtension(day,true);
    await supabase.from('merit_indicator_events').insert({source_key:'old',indicator:'retorno',broker_id:'Didi',occurred_at:at,is_test:true});
    await resetTestPlantao(day,true); expect(await loadDayExtension(day)).toBe(false);
    expect((await supabase.from('merit_indicator_events').select('*')).data).toHaveLength(1);
  });
});
describe('Atendimento Agendado', () => {
  it('normaliza telefone e mantém horário e designação opcionais, sem proprietário de retorno', () => {
    expect(scheduledRoute('(11) 98765-4321','','')).toMatchObject({phone:'11987654321',queue_type:'geral',referred_broker_id:null,scheduled_time:null,designated_broker_id:null});
    expect(() => scheduledRoute('11','',null)).toThrow('DDD');
    expect(() => scheduledRoute('11987654321','25:00',null)).toThrow('horário');
  });
  it.each([{presence_status:'ausente'},{presence_status:'pausa'},{attendance_status:'em_atendimento'},{attendance_status:'em_mesa'}] as const)('aguarda o designado indisponível: %j', async state => {
    const entry = await appointment(); await supabase.from('brokers').update(state).eq('id','Didi');
    const data = await fetchAll(); expect(designatedScheduledBroker(entry,data.brokers,data.queue,clock)).toBeUndefined();
    expect(await dispatchReceptionEntry(entry,data.brokers,data.queue,clock,at)).toBe(false);
    expect((await fetchAll()).queue[0].broker_id).toBeNull();
  });
  it('consome a vez do designado uma única vez na conclusão e preserva inversa e outros corretores', async () => {
    const entry = await appointment(); const data = await fetchAll();
    expect(await dispatchReceptionEntry(entry,data.brokers,data.queue,clock,at)).toBe(true);
    let live = await fetchAll(); expect(live.queue[0]).toMatchObject({queue_status:'chamando',broker_id:'Didi',commission_split:false});
    expect(live.brokers.map(b=>b.sorteio_order)).toEqual([1,2]);
    await supabase.from('queue_entries').update({queue_status:'em_atendimento',updated_at:at}).eq('id','queue');
    live = await fetchAll(); await concludePlantaoAttendance(live.queue[0],at);
    const after = await fetchAll(); expect(after.brokers[0].sorteio_order).toBe(Date.parse(at));
    expect(after.brokers.map(b=>b.inverse_order)).toEqual([2,1]); expect(after.brokers[1].sorteio_order).toBe(2);
    await concludePlantaoAttendance(live.queue[0],`${day}T12:00:00Z`);
    expect((await fetchAll()).brokers[0].sorteio_order).toBe(Date.parse(at));
    expect((await fetchAll()).visits[0].visit_reason).toBe('Atendimento Agendado');
  });
  it.each(['shift','day','week'] as const)('categoria própria no relatório de %s e snapshot completo', async period => {
    await appointment(); await supabase.from('queue_entries').update({broker_id:'Didi',queue_status:'concluido'}).eq('id','queue');
    const filter = {period,date:day,shift:'manha' as const}; const rows = await loadReportRows(filter);
    const report = shiftClosingReport(rows,filter); expect(report.total).toBe(1);
    expect(report.types.find(t=>t.label==='Atendimento Agendado')?.count).toBe(1);
    expect(report.companies[0].types['Primeira Visita']).toBe(0); expect(reportCsv(report)).toContain('Atendimento Agendado');
    await closePlantao(day); const saved=(await supabase.from('plantao_daily_closures').select('*').single()).data;
    expect(saved.customers[0]).toMatchObject({name:'Maria Cliente Completo',phone:'11987654321',scheduled_time:'10:30',designated_broker_id:'Didi',type:'Atendimento Agendado'});
  });
});
describe('indicadores datados, sem ranking', () => {
  it.each(['aguardando','chamando','ausente'] as const)('não pontua atendimento não iniciado: %s', queue_status => {
    expect(receptionMeritEvent(waiting({queue_status,broker_id:'Didi'}))).toBeNull();
  });
  it.each(['Retorno','Indicação','Indicação Presente','Indicação Ausente'] as const)('registra %s para o original uma vez, mesmo em Fifty', async visit_reason => {
    const entry = waiting({queue_status:'em_atendimento',broker_id:'Mussum',commission_split:true,visit:customer({visit_reason}),updated_at:at});
    await Promise.all([synchronizeMeritIndicators([entry]),synchronizeMeritIndicators([entry])]);
    await synchronizeMeritIndicators([{...entry,queue_status:'concluido',updated_at:`${day}T14:00:00Z`}]);
    expect((await supabase.from('merit_indicator_events').select('*')).data).toHaveLength(1);
    expect((await supabase.from('merit_indicator_events').select('*')).data![0]).toMatchObject({broker_id:'Didi',occurred_at:at,indicator:visit_reason==='Retorno'?'retorno':'indicacao'});
  });
  it('quatro contadores, janela móvel exclusiva no fim e TESTE separado', async () => {
    await supabase.from('brokers').insert(person('Didi'));
    await synchronizeMeritIndicators([waiting({queue_status:'em_atendimento',broker_id:'Didi',visit:customer({visit_reason:'Retorno'})}),
      waiting({id:'indication',queue_status:'concluido',broker_id:'Didi',visit:customer({visit_reason:'Indicação'})})]);
    for(const indicator of ['reserva','pasta_documentos'] as const) {
      const event={indicator,source_key:'vendas:1',broker_id:'Didi',occurred_at:at,is_test:false};
      await Promise.all([recordSalesMeritEvent(event),recordSalesMeritEvent(event)]);
    }
    await recordSalesMeritEvent({indicator:'reserva',source_key:'test',broker_id:'Didi',occurred_at:at,is_test:true});
    const end=`${day}T12:00:00Z`;
    expect(await meritIndicatorCounts('Didi',at,end)).toEqual({indicacao:1,retorno:1,reserva:1,pasta_documentos:1});
    expect((await meritIndicatorCounts('Didi',at,end,true)).reserva).toBe(2);
    expect(Object.keys(await meritIndicatorCounts('Didi',`${day}T10:00:00Z`,at))).toEqual([...MERIT_INDICATORS]);
    expect(Object.values(await meritIndicatorCounts('Didi',`${day}T10:00:00Z`,at))).toEqual([0,0,0,0]);
    await expect(meritIndicatorCounts('Didi',end,at)).rejects.toThrow('Janela');
    await expect(recordSalesMeritEvent({indicator:'reserva',source_key:'vendas:1',broker_id:'Didi',occurred_at:end,is_test:false})).rejects.toThrow('outros dados');
    expect((await fetchAll()).brokers[0].sorteio_order).toBe(1);
  });
  it('rejeita data inválida e corretor externo no contrato do futuro módulo de vendas', async () => {
    const event={indicator:'reserva' as const,source_key:'vendas:1',broker_id:'externo',occurred_at:'inválida',is_test:false};
    await expect(recordSalesMeritEvent(event)).rejects.toThrow('válidos');
    await supabase.from('brokers').insert(person('externo',{is_external_partner:true}));
    await expect(recordSalesMeritEvent({...event,occurred_at:at})).rejects.toThrow('interno');
  });
});
