// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import RecepcaoPanel from '@/components/RecepcaoPanel';
import FilaPanel from '@/components/FilaPanel';
import { SimProvider } from '@/lib/simContext';
import { installPlantaoClock, publishClock } from '@/lib/plantaoClock';
import { dbReady, supabase } from '@/lib/supabase';
import { fetchAll, resetCompanyRotation } from '@/lib/queueEngine';
import { publishDayExtension } from '@/lib/operations/dayExtension';
import { isPlantaoClosed } from '@/lib/reports/officialClosing';
import { synchronizeMeritIndicators } from '@/lib/operations/meritIndicators';
import { person, customer, receptionDay as day, receptionAt as at } from './receptionFixtures';
let root: Root; let container: HTMLDivElement; let uninstall: (()=>void) | undefined;
let reload: ()=>Promise<void>;
async function settle(work: ()=>unknown) { await act(async()=>{ await work(); for(let i=0;i<500;i++) await Promise.resolve(); }); }
async function click(label: string) {
  const b=[...container.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);
  expect(b,label).toBeDefined(); await settle(()=>b!.click());
}
async function input(selector: string,value: string) {
  const el=container.querySelector<HTMLInputElement|HTMLSelectElement>(selector)!; expect(el,selector).not.toBeNull();
  await settle(()=>{
    Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  });
}
async function time(value:string) { await input('[aria-label="Horário virtual"]',value); }
function Harness() {
  const [data,setData]=useState<Awaited<ReturnType<typeof fetchAll>>>();
  reload=async()=>{ const next=await fetchAll(); await synchronizeMeritIndicators(next.queue); setData(next); };
  useEffect(()=>{ void reload(); },[]);
  return <SimProvider>{data&&<><RecepcaoPanel {...data} onChanged={reload}/><FilaPanel {...data} allQueue={data.queue} onChanged={reload}/></>}</SimProvider>;
}
beforeEach(async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date(at));vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  localStorage.clear();publishClock();publishDayExtension(day,false);resetCompanyRotation();await dbReady;
  for(const table of ['brokers','visits','queue_entries','plantao_sessions','plantao_daily_closures','incorporadora_direct_leads','merit_indicator_events',
    'pause_audit','external_partner_intakes','external_partner_reservations','partner_reception_details']) await supabase.from(table).delete().neq('id','');
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{
  await settle(()=>root.unmount());uninstall?.();uninstall=undefined;publishDayExtension(day,false);container.remove();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();
});
describe('fechamento pelo relógio ativo na aplicação completa',()=>{
  it('fecha imediatamente às 21h no TESTE, mostra relatório e mantém snapshot único',async()=>{
    await settle(()=>root.render(<App/>));await click('TESTE');await time('20:59:59');
    expect(await isPlantaoClosed(day)).toBe(false);await time('21:00:00');
    expect(await isPlantaoClosed(day)).toBe(true);expect(container.textContent).toContain('Relatório Quantitativo Final');
    expect(container.textContent).not.toContain('Não foi possível');await time('21:05:00');
    expect((await supabase.from('plantao_daily_closures').select('*')).data).toHaveLength(1);
    expect((await supabase.from('plantao_daily_closures').select('*').single()).data.closed_by).toBe('fechamento_automatico_21h');
  });
  it('o relógio real também fecha sem abrir TESTE',async()=>{
    vi.setSystemTime(new Date(`${day}T20:59:59-03:00`));publishClock();await settle(()=>root.render(<App/>));
    expect(await isPlantaoClosed(day)).toBe(false);
    await settle(()=>{vi.setSystemTime(new Date(`${day}T21:00:00-03:00`));publishClock();});
    expect(await isPlantaoClosed(day)).toBe(true);expect(container.textContent).toContain('Relatório Quantitativo Final');
    expect(container.querySelector('#test-module')).toBeNull();
  });
  it('chave Caixa impede fechamento, permite cadastrar às 22h e encerra manualmente',async()=>{
    await settle(()=>root.render(<App/>));await click('TESTE');await time('20:30:00');
    const toggle=[...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i=>i.parentElement?.textContent?.includes('Dia de Assinatura Caixa'))!;
    expect(toggle.checked).toBe(false);await settle(()=>toggle.click());await time('22:00:00');
    expect(await isPlantaoClosed(day)).toBe(false);expect(container.textContent).toContain('Plantão estendido — Dia de Assinatura Caixa ativo');
    await input('input[type="tel"]','11977776666');await input('[placeholder="Nome completo"]','Cliente da Caixa');
    // No broker has arrived: preserve the original direct-lead option.
    await settle(()=>container.querySelectorAll<HTMLInputElement>('[name="absence-wait"]')[1].click());await click('Cadastrar visita');
    expect((await supabase.from('incorporadora_direct_leads').select('*')).data).toHaveLength(1);
    expect((await supabase.from('incorporadora_direct_leads').select('*').single()).data.created_at).toBe('2040-01-24T01:00:00.000Z');
    vi.spyOn(window,'confirm').mockReturnValue(true);await click('Fechar Plantão');
    expect(await isPlantaoClosed(day)).toBe(true);expect(container.textContent).toContain('Relatório Quantitativo Final');
    expect((await supabase.from('plantao_daily_closures').select('*').single()).data.closed_by).toBe('operacao_stand');
  });
});
describe('Recepção integrada ao atendimento agendado',()=>{
  async function render() {
    uninstall=installPlantaoClock({now:()=>Date.parse(at)});
    await supabase.from('brokers').insert([person('Didi',{sorteio_order:1,inverse_order:2}),person('Mussum',{sorteio_order:2,inverse_order:1})]);
    await settle(()=>root.render(<Harness/>));
    await input('input[type="tel"]','11976543210');await input('[placeholder="Nome completo"]','Cliente Agendado');
    await input('[aria-label="Motivo da visita"]','Atendimento Agendado');
  }
  it('sem designação chama próximo da direta, confirma, conclui e consome uma vez',async()=>{
    await render();await click('Cadastrar visita');await click('Chamar agora');
    let data=await fetchAll();expect(data.queue[0]).toMatchObject({broker_id:'Didi',visit:{visit_reason:'Atendimento Agendado',scheduled_time:null,designated_broker_id:null}});
    expect(Boolean(data.queue[0].commission_split)).toBe(false);await settle(()=>reload());await click('Confirmar presença');await settle(()=>reload());await click('Concluir');
    data=await fetchAll();expect(data.brokers.find(b=>b.id==='Didi')?.sorteio_order).toBe(Date.parse(at));
    expect(data.brokers.map(b=>b.inverse_order)).toEqual([2,1]);
    expect(data.queue[0].queue_status).toBe('concluido');
    expect((await supabase.from('merit_indicator_events').select('*')).data).toHaveLength(0);
  });
  it('registra horário e corretor designado sem chamar outro que esteja livre',async()=>{
    await render();await supabase.from('brokers').update({presence_status:'ausente'}).eq('id','Mussum');await settle(()=>reload());
    await input('[aria-label="Horário Agendado"]','10:30');await input('[aria-label="Corretor Designado"]','Mussum');
    await click('Cadastrar visita');const data=await fetchAll();
    expect(data.queue[0]).toMatchObject({queue_status:'aguardando',reception_waiting:true,
      visit:{scheduled_time:'10:30',designated_broker_id:'Mussum',referred_broker_id:null}});
    expect(data.queue[0].broker_id).toBeFalsy();expect(data.brokers.find(b=>b.id==='Didi')?.attendance_status).toBe('livre');
    expect(container.textContent).toContain('corretor designado');
  });
  it('permite agendamento explícito de telefone conhecido sem perder a identificação automática de retorno',async()=>{
    await supabase.from('visits').insert(customer({phone:'11976543210',status:'encerrado'}));
    uninstall=installPlantaoClock({now:()=>Date.parse(at)});await supabase.from('brokers').insert(person('Didi'));
    await settle(()=>root.render(<Harness/>));await input('input[type="tel"]','11976543210');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Motivo da visita"]')?.value).toBe('Retorno');
    await click('Registrar como Atendimento Agendado');await click('Cadastrar visita');
    expect((await fetchAll()).queue[0].visit).toMatchObject({visit_reason:'Atendimento Agendado',referred_broker_id:null,customer_name:'Maria Cliente Completo'});
  });
});
