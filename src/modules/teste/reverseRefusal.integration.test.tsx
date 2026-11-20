// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilaPanel from '@/components/FilaPanel';
import ReceptionAuditPanel from '@/components/ReceptionAuditPanel';
import { SimProvider } from '@/lib/simContext';
import { installPlantaoClock } from '@/lib/plantaoClock';
import { dbReady, supabase } from '@/lib/supabase';
import { fetchAll } from '@/lib/queueEngine';
import { canRefuseInverse, freeDirectPosition } from '@/lib/reception/operationalChoices';
import type { ScheduledBroker } from '@/lib/queue/shiftSchedule';
import { attachReceptionPolicies, readReceptionPolicy } from '@/lib/reception/operationalStore';
import { person, customer, waiting, receptionDay as day } from './receptionFixtures';

const at = `${day}T13:00:00.000Z`;
const label = 'Recusar (Ir para o Fim da Fila Reversa)';
let root: Root; let container: HTMLDivElement; let stop: () => void;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 200; i++) await Promise.resolve(); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeDefined(); await settle(() => button!.click());
}
function Harness() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAll>>>();
  async function load() {
    const live = await fetchAll();
    const sessions = await supabase.from('plantao_sessions').select('*');
    setData({ ...live, queue: attachReceptionPolicies(live.queue, sessions.data ?? []) });
  }
  useEffect(() => { void load(); }, []);
  return <SimProvider>{data && <><FilaPanel {...data} allQueue={data.queue} onChanged={load} />
    <ReceptionAuditPanel {...data} /></>}</SimProvider>;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions']) await supabase.from(table).delete().neq('id', '');
  stop = installPlantaoClock({ now: () => Date.parse(at) });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); stop(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('recusa na tela em que a chamada reversa é feita', () => {
  it.each(['Decorado', 'Sem Telefone'])('%s: chama o 3º cadastrado/1º livre e recusa sem tocar na direta ou nos ponteiros', async kind => {
    const brokers = [person('1', { sorteio_order: 10, inverse_order: 4, attendance_status: 'em_atendimento' }),
      person('2', { sorteio_order: 20, inverse_order: 3, attendance_status: 'em_atendimento' }),
      person('3', { sorteio_order: 30, inverse_order: 1 }), person('4', { sorteio_order: 40, inverse_order: 2 })];
    await supabase.from('brokers').insert(brokers);
    await supabase.from('visits').insert(customer({ referred_broker_id: null, visit_reason: 'Visita ao Decorado',
      phone: kind === 'Sem Telefone' ? null : '11987654321' }));
    const { visit: _, ...entry } = waiting({ queue_type: 'decorado', reception_waiting: false });
    await supabase.from('queue_entries').insert(entry);
    localStorage.setItem('plantao_company_pointers', '{"Viva Imóveis":{"index":2,"owedId":"1"}}');
    localStorage.setItem('plantao_company_rotation_index', '1');
    const pointers = [localStorage.getItem('plantao_company_pointers'), localStorage.getItem('plantao_company_rotation_index')];
    await settle(() => root.render(<Harness />));
    await click('Chamar do decorado');
    expect((await fetchAll()).queue[0]).toMatchObject({ broker_id: '3', queue_status: 'chamando' });
    expect(container.textContent).toContain(label);
    await click(label);
    const live = await fetchAll();
    expect(live.queue[0]).toMatchObject({ broker_id: '4', queue_status: 'chamando' });
    expect(live.brokers.map(b => [b.id, b.sorteio_order])).toEqual(brokers.map(b => [b.id, b.sorteio_order]));
    expect(live.brokers.find(b => b.id === '3')).toMatchObject({ inverse_order: 5, attendance_status: 'livre' });
    expect(live.brokers.filter(b => b.id !== '3').map(b => [b.id, b.inverse_order]))
      .toEqual(brokers.filter(b => b.id !== '3').map(b => [b.id, b.inverse_order]));
    expect([localStorage.getItem('plantao_company_pointers'), localStorage.getItem('plantao_company_rotation_index')]).toEqual(pointers);
    expect((await readReceptionPolicy(entry.id))!.events[0]).toMatchObject({ type: 'inverse_refusal', position: 3, freePosition: 1 });
    expect(container.textContent).toContain('3ª posição direta preservada');
  });
  it('faz verificação pura na ordem atual, sem incluir outra empresa, pausa, restrição ou saída após atendimento', () => {
    const brokers = [person('encerrando', { sorteio_order: 1, leave_after_service: true } as Partial<ScheduledBroker>),
      person('pausado', { sorteio_order: 2, presence_status: 'pausa' }),
      person('restrito', { sorteio_order: 3, attendance_status: 'apenas_indicacao' }),
      person('outra', { agency: 'Casa Nobre', sorteio_order: 1 }),
      person('primeiro', { sorteio_order: 40 }), person('candidato', { sorteio_order: 50, attendance_status: 'em_mesa' })];
    const call = waiting({ queue_type: 'decorado', queue_status: 'chamando', broker_id: 'candidato',
      visit: customer({ referred_broker_id: null }) });
    const before = JSON.stringify([brokers, call]);
    expect(freeDirectPosition(call, brokers, [call])).toBe(2);
    expect(canRefuseInverse(call, brokers, [call])).toBe(true);
    expect(JSON.stringify([brokers, call])).toBe(before);
    expect(canRefuseInverse(call, [...brokers, person('novo-livre', { sorteio_order: 4 })], [call])).toBe(false);
  });
});
