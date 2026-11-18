// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { remote } = vi.hoisted(() => ({ remote: { enabled: true } }));
vi.mock('@/lib/supabase', async () => {
  const { createMockClient } = await import('@/lib/mockClient');
  const client = createMockClient();
  return { dbReady: Promise.resolve(true), supabase: {
    ...client, from: vi.fn(client.from), get rpc() { return remote.enabled ? vi.fn() : undefined; },
  } };
});
import { supabase, type Visit } from '@/lib/supabase';
import { SimProvider } from '@/lib/simContext';
import { publishClock } from '@/lib/plantaoClock';
import { createVirtualClock } from './virtualClock';
import { loadTestDirectLeads } from './testDirectLeads';
import TestCustomers from './TestCustomers';
import TestModule from './TestModule';

const day = '2046-04-10';
const nextDay = '2046-04-11';
const first = { id: 'direct-first', customer_name: 'Cliente da Incorporadora', phone: '11911110001', created_at: `${day}T03:00:00Z`, test_date: day };
const late = { id: 'direct-late', customer_name: 'Cliente às 23:59', phone: '11911110002', created_at: `${nextDay}T02:59:59Z`, test_date: day };
const next = { id: 'direct-next', customer_name: 'Cliente do outro dia', phone: '11911110003', created_at: `${nextDay}T03:00:00Z`, test_date: nextDay };
const from = vi.mocked(supabase.from);
let container: HTMLDivElement;
let root: Root;
let clock: ReturnType<typeof createVirtualClock>;
let stopClock: () => void;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 100; i++) await Promise.resolve(); });
}
function render(visits: Visit[] = []) {
  return settle(() => root.render(<SimProvider><TestCustomers visits={visits} queue={[]} brokers={[]} /></SimProvider>));
}
function pendingRead(promise: Promise<unknown>) {
  return { select: () => ({ eq: () => promise }) } as unknown as ReturnType<typeof supabase.from>;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${day}T10:00:00Z`));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  remote.enabled = true; localStorage.clear(); publishClock();
  for (const table of ['test_incorporadora_direct_leads', 'incorporadora_direct_leads']) {
    await supabase.from(table).delete().neq('id', '');
  }
  await supabase.from('test_incorporadora_direct_leads').insert([first, late, next]);
  from.mockClear();
  clock = createVirtualClock(); stopClock = clock.start();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => { root.unmount(); stopClock(); }); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('lê a projeção do dia somente ao abrir TESTE e mostra nome e telefone em texto, sem copiar', async () => {
  await settle(() => root.render(<SimProvider><TestModule visits={[]} queue={[]} brokers={[]} closed dbConnected
    onChanged={async () => {}} runMaintenance={work => work()} /></SimProvider>));
  expect(from).not.toHaveBeenCalled();
  const toggle = container.querySelector('button')!;
  await settle(() => toggle.click());
  const panel = container.querySelector('[aria-label="Clientes Inseridos no Teste"]')!;
  expect(from).toHaveBeenCalledWith('test_incorporadora_direct_leads');
  expect(from).not.toHaveBeenCalledWith('incorporadora_direct_leads');
  expect(panel.textContent).toContain(first.customer_name); expect(panel.textContent).toContain(first.phone);
  expect(panel.textContent).toContain(late.phone); expect(panel.textContent).not.toContain(next.phone);
  expect(panel.textContent).toContain('Sem corretor — Incorporadora');
  expect(panel.querySelector('button')).toBeNull(); expect(panel.querySelector('[role="alert"]')).toBeNull();
  await settle(() => toggle.click());
  expect(container.textContent).not.toContain(first.phone);
});

it('acompanha a data virtual e os limites de meia-noite de São Paulo', async () => {
  const visits = [{ id: 'visit-today', customer_name: 'Visita de hoje', phone: '11922220001', created_at: first.created_at, is_test: true },
    { id: 'visit-next', customer_name: 'Visita de amanhã', phone: '11922220002', created_at: next.created_at, is_test: true }] as Visit[];
  await render(visits);
  expect(container.textContent).toContain(late.phone); expect(container.textContent).toContain('Visita de hoje');
  expect(container.textContent).not.toContain('Visita de amanhã');
  await settle(() => clock.setDate(nextDay));
  expect(container.textContent).toContain(next.phone); expect(container.textContent).toContain('Visita de amanhã');
  expect(container.textContent).not.toContain(first.phone); expect(container.textContent).not.toContain(late.phone);
  expect(container.textContent).not.toContain('Visita de hoje');
});

it('ignora a resposta atrasada do dia anterior depois de mudar a data', async () => {
  let complete!: (result: unknown) => void;
  from.mockImplementationOnce(() => pendingRead(new Promise(resolve => { complete = resolve; })));
  await render();
  await settle(() => clock.setDate(nextDay));
  expect(container.textContent).toContain(next.phone);
  await settle(() => complete({ data: [first], error: null }));
  expect(container.textContent).toContain(next.phone); expect(container.textContent).not.toContain(first.phone);
});

it('mantém o erro real visível e recupera a lista no próximo carregamento', async () => {
  from.mockImplementationOnce(() => pendingRead(Promise.resolve({ data: null, error: { message: 'View indisponível' } })));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível carregar');
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).toContain(first.phone);
});

it('trata rejeição de rede e não conserva nomes e telefones de uma leitura anterior', async () => {
  await render(); expect(container.textContent).toContain(first.phone);
  from.mockImplementationOnce(() => pendingRead(Promise.reject(new Error('Rede indisponível'))));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível carregar');
  expect(container.textContent).not.toContain(first.phone);
});

it('atualiza o quadro para vazio após a limpeza do dia', async () => {
  await render();
  await supabase.from('test_incorporadora_direct_leads').delete().eq('test_date', day);
  await render();
  expect(container.textContent).toContain('Nenhum cliente inserido no teste.');
  expect(container.textContent).not.toContain(first.phone); expect(container.textContent).not.toContain(next.phone);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('preserva a contingência local com os mesmos filtros de teste e dia', async () => {
  remote.enabled = false;
  await supabase.from('incorporadora_direct_leads').insert([
    { ...first, is_test: true }, { ...late, is_test: true }, { ...next, is_test: true },
    { ...first, id: 'real', customer_name: 'Cliente real', is_test: false },
  ]);
  expect((await loadTestDirectLeads(day)).map(lead => lead.id)).toEqual([first.id, late.id]);
  expect(await loadTestDirectLeads('2046-04-12')).toEqual([]);
});
