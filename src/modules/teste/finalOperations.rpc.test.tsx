// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/lib/supabase',async()=>{const {createMockClient}=await import('@/lib/mockClient');return {dbReady:Promise.resolve(true),supabase:{...createMockClient(),rpc}};});
import { supabase } from '@/lib/supabase';
import { closeAt21, setDayExtension } from '@/lib/operations/dayStore';
import { isDayExtended, publishDayExtension } from '@/lib/operations/dayExtension';
import { recordSalesMeritEvent, meritIndicatorCounts } from '@/lib/operations/meritIndicators';
import OfficialClosingPanel from '@/components/OfficialClosingPanel';
import type { ClosingSummary } from '@/lib/reports/officialClosing';
const day='2040-01-23';const at='2040-01-24T00:00:00.000Z';
beforeEach(async()=>{ vi.useFakeTimers();vi.setSystemTime(new Date(at));rpc.mockReset();publishDayExtension(day,false);await supabase.from('plantao_sessions').delete().neq('id',''); });
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();publishDayExtension(day,false);});
it('envia a data e hora reais do relógio ativo para a transação de fechamento automático',async()=>{
  rpc.mockResolvedValue({data:{date:day,closed_at:at,rows:[],recipients:[]},error:null});
  const summary=await closeAt21(day,false);
  expect(summary?.date).toBe(day);expect(rpc).toHaveBeenCalledOnce();expect(rpc).toHaveBeenCalledWith('close_plantao_automatically',{day,at_time:at});
});
it('respeita veto concorrente da transação e propaga erro sem inventar snapshot',async()=>{
  rpc.mockResolvedValueOnce({data:null,error:null});expect(await closeAt21(day,false)).toBeNull();
  rpc.mockResolvedValueOnce({data:null,error:{message:'Falha no snapshot'}});await expect(closeAt21(day,false)).rejects.toThrow('Falha no snapshot');
});
it('só publica a chave Caixa depois que o banco confirma sua gravação',async()=>{
  rpc.mockResolvedValueOnce({error:{message:'Sem conexão'}});await expect(setDayExtension(day,true)).rejects.toThrow('Sem conexão');expect(isDayExtended(day)).toBe(false);
  rpc.mockResolvedValueOnce({error:null});await setDayExtension(day,true);expect(isDayExtended(day)).toBe(true);
  expect(rpc).toHaveBeenLastCalledWith('set_plantao_day_extension',{day,enabled:true,at_time:at});
});
it('contrato remoto de vendas grava eventos datados e consulta janela com TESTE excluído',async()=>{
  const event={source_key:'reserva:9',broker_id:'broker',indicator:'reserva' as const,occurred_at:at,is_test:false};
  rpc.mockResolvedValue({data:null,error:null});await recordSalesMeritEvent(event);expect(rpc).toHaveBeenCalledWith('record_sales_merit_event',{event});
  rpc.mockResolvedValue({data:{indicacao:1,retorno:2,reserva:3,pasta_documentos:4},error:null});
  expect(await meritIndicatorCounts('broker','2040-01-01T00:00:00Z',at)).toEqual({indicacao:1,retorno:2,reserva:3,pasta_documentos:4});
  expect(rpc).toHaveBeenLastCalledWith('merit_indicator_counts',{broker:'broker',from_at:'2040-01-01T00:00:00Z',until_at:at,include_tests:false});
});
it('resultado automático mostra imediatamente relatório e quatro links, sem novo clique ou login',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const summary:ClosingSummary={date:day,closed_at:at,rows:[{date:day,shift:'tarde',company:'Casa Nobre',team:'Equipe',type:'Atendimento Agendado',media:'Outros',count:2}],recipients:[
    {role:'gerencia',whatsapp:'5511999991111',email:'gerencia@example.com'},{role:'diretoria',whatsapp:'5511999992222',email:'diretoria@example.com'}]};
  const host=document.createElement('div');const root=createRoot(host);
  try{
    await act(async()=>root.render(<OfficialClosingPanel date={day} closed automaticSummary={summary} onClosed={()=>{}}/>));
    expect(host.textContent).toContain('Relatório Quantitativo Final');expect(host.textContent).toContain('Atendimento Agendado: 2');
    expect(host.querySelectorAll('a[href^="https://wa.me/"]')).toHaveLength(2);expect(host.querySelectorAll('a[href^="mailto:"]')).toHaveLength(2);
    expect(host.querySelector('input[type="password"]')).toBeNull();expect(rpc).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());}
});
