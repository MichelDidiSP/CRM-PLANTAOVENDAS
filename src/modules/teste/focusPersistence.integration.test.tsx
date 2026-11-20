// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { getPlantaoTime, isVirtualClockActive, publishClock } from '@/lib/plantaoClock';
import { dbReady, supabase } from '@/lib/supabase';
import * as queueEngine from '@/lib/queueEngine';
import * as closing from '@/lib/reports/officialClosing';
import { person, customer, waiting, receptionDay as day, receptionAt as at } from './receptionFixtures';

let root: Root; let container: HTMLDivElement;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 300; i++) await Promise.resolve(); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeDefined(); await settle(() => button!.click());
}
async function seed(id = 'Inicial') {
  await supabase.from('visits').insert(customer({ id, customer_name: id, referred_broker_id: null, visit_reason: 'Primeira visita', is_test: true }));
  const { visit: _, ...entry } = waiting({ id: `q-${id}`, visit_id: id, reception_waiting: false });
  await supabase.from('queue_entries').insert(entry);
}
async function visibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
}
function persistedTest() {
  localStorage.setItem('plantao_test_enabled', 'true');
  localStorage.setItem('plantao_test_timestamp', String(Date.parse(at)));
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); sessionStorage.clear(); publishClock(); await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions', 'plantao_daily_closures', 'incorporadora_direct_leads',
    'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details']) await supabase.from(table).delete().neq('id', '');
  await supabase.from('brokers').insert(person('Didi'));
  await seed(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('estado TESTE e reidratação no foco', () => {
  it('persiste abertura, horário e chamadas rápidas; remonta antes de consultar qualquer dia real', async () => {
    await settle(() => root.render(<App />)); await click('TESTE'); await click('+1 min'); await click('Chamadas: 2 minutos');
    expect(localStorage.getItem('plantao_test_enabled')).toBe('true');
    await settle(() => root.render(<div />));
    vi.setSystemTime(new Date('2041-02-15T22:00:00Z')); publishClock();
    const loadDay = vi.spyOn(closing, 'isPlantaoClosed');
    await settle(() => root.render(<App />));
    expect(container.querySelector('#test-module')).not.toBeNull();
    expect(isVirtualClockActive()).toBe(true);
    expect(container.querySelector('output')?.textContent).toBe('08:31:00');
    expect(container.textContent).toContain('Chamadas: 10 segundos');
    expect(loadDay).toHaveBeenCalled(); expect(loadDay.mock.calls.every(([date]) => date === day)).toBe(true);
    await click('TESTE');
    expect(localStorage.getItem('plantao_test_enabled')).toBe('false'); expect(isVirtualClockActive()).toBe(false);
    await settle(() => root.render(<div />)); await settle(() => root.render(<App />));
    expect(container.querySelector('#test-module')).toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('19:00:00');
  });
  it.each(['focus', 'visibilitychange'] as const)('%s mantém TESTE e sincroniza imediatamente filas e presença sem esperar o polling', async event => {
    vi.setSystemTime(new Date('2041-02-15T22:00:00Z'));
    await supabase.from('brokers').update({ presence_status: 'ausente' }).eq('id', 'Didi');
    persistedTest(); await settle(() => root.render(<App />)); await click('Motor da Fila');
    expect(container.textContent).toContain('Inicial');
    await visibility('hidden');
    await supabase.from('brokers').update({ attendance_status: 'em_mesa', presence_status: 'presente' }).eq('id', 'Didi');
    await seed('Chegou');
    await supabase.from('queue_entries').update({ broker_id: 'Didi', queue_status: 'chamando', called_at: at }).eq('id', 'q-Chegou');
    expect(container.querySelector('main')?.textContent).not.toContain('Chegou');
    if (event === 'focus') await settle(() => window.dispatchEvent(new Event('focus'))); else await visibility('visible');
    expect(container.querySelector('#test-module')).not.toBeNull(); expect(isVirtualClockActive()).toBe(true);
    expect(container.querySelector('output')?.textContent).toBe('08:30:00');
    expect(container.querySelector('main')?.textContent).toContain('Chegou');
    expect(container.querySelector('main')?.textContent).toContain('Didi');
    expect(container.querySelector('main')?.textContent).toContain('Inicial');
    await click('Corretor / Gerente');
    const card = [...container.querySelectorAll('main [class]')].find(el => el.querySelector('h3')?.textContent === 'Didi');
    const statusButtons = [...card!.querySelectorAll('button')];
    expect(statusButtons.find(b => b.textContent === 'Chamado')!.classList.contains('bg-sky-500')).toBe(true);
    expect(statusButtons.find(b => b.textContent === 'Registrar presença')!.classList.contains('bg-emerald-500')).toBe(true);
    expect(getPlantaoTime().toISOString()).toBe(at);
  });
  it.each(['focus', 'visibilitychange'] as const)('modo real também atualiza por %s e mantém a tela durante erro de conexão', async event => {
    const resume = () => event === 'focus' ? settle(() => window.dispatchEvent(new Event('focus'))) : visibility('visible');
    await settle(() => root.render(<App />)); await click('Motor da Fila');
    await seed('Novo');
    const original = queueEngine.fetchAll;
    vi.spyOn(queueEngine, 'fetchAll').mockImplementationOnce(async () => ({ ...(await original()), error: { message: 'offline' } as never }));
    await resume();
    expect(container.querySelector('main')?.textContent).toContain('Inicial');
    expect(container.textContent).toContain('Não foi possível conectar');
    await resume();
    expect(container.querySelector('main')?.textContent).toContain('Novo');
    expect(container.textContent).not.toContain('Não foi possível conectar');
    expect(container.querySelector('#test-module')).toBeNull(); expect(isVirtualClockActive()).toBe(false);
  });
  it('resposta atrasada anterior ao foco não apaga o estado recém-recarregado', async () => {
    persistedTest(); await settle(() => root.render(<App />)); await click('Motor da Fila');
    const stale = await queueEngine.fetchAll();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(queueEngine, 'fetchAll').mockImplementationOnce(async () => { await blocked; return stale; });
    await settle(() => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('main')?.textContent).toContain('Inicial');
    await seed('Atualizado'); await visibility('visible');
    expect(container.querySelector('main')?.textContent).toContain('Atualizado');
    await settle(() => release());
    expect(container.querySelector('main')?.textContent).toContain('Atualizado');
    expect(container.querySelector('#test-module')).not.toBeNull(); expect(isVirtualClockActive()).toBe(true);
  });
  it('uma consulta lenta concluída atualiza a tela mesmo com outra consulta ainda pendente', async () => {
    persistedTest(); await settle(() => root.render(<App />)); await click('Motor da Fila');
    await seed('Lento');
    const live = await queueEngine.fetchAll();
    let first!: () => void; let second!: () => void;
    const firstWait = new Promise<void>(resolve => { first = resolve; });
    const secondWait = new Promise<void>(resolve => { second = resolve; });
    vi.spyOn(queueEngine, 'fetchAll').mockImplementationOnce(async () => { await firstWait; return live; })
      .mockImplementationOnce(async () => { await secondWait; return live; });
    await settle(() => window.dispatchEvent(new Event('focus'))); await visibility('visible');
    await settle(() => first());
    expect(container.querySelector('main')?.textContent).toContain('Lento');
    await settle(() => second());
    expect(container.querySelector('main')?.textContent).toContain('Lento');
  });
});
