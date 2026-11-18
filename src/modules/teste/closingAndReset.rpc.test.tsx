// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { rpc, getSession, signIn } = vi.hoisted(() => ({ rpc: vi.fn(), getSession: vi.fn(), signIn: vi.fn() }));
vi.mock('@/lib/supabase', async () => {
  const { createMockClient } = await import('@/lib/mockClient');
  return { dbReady: Promise.resolve(true), supabase: {
    ...createMockClient(), rpc, auth: { getSession, signInWithPassword: signIn },
  } };
});
import OfficialClosingPanel from '@/components/OfficialClosingPanel';
import { SimProvider } from '@/lib/simContext';
import { publishClock } from '@/lib/plantaoClock';
import TestModule from './TestModule';
import { resetTestPlantao } from './resetTestPlantao';

const day = '2043-02-17';
const summary = { date: day, closed_at: `${day}T11:30:00Z`, rows: [
  { date: day, shift: 'manha', company: 'Casa Nobre', team: 'Equipe', type: 'Retorno', media: 'Google / Pesquisa', count: 2 },
], recipients: [
  { role: 'gerencia', whatsapp: '5511999991111', email: 'gerencia@example.com' },
  { role: 'diretoria', whatsapp: '5511999992222', email: 'diretoria@example.com' },
] };
let container: HTMLDivElement;
let root: Root;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 100; i++) await Promise.resolve(); });
}
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  expect(found, label).toBeDefined(); return found!;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${day}T10:00:00Z`));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('VITE_PLANTAO_TEST_DATABASE', '');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  localStorage.clear(); publishClock(); rpc.mockReset();
  getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  signIn.mockReset().mockResolvedValue({ error: new Error('Não há operador cadastrado') });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it('fecha diretamente no banco remoto, sem sessão, e exibe o relatório e os quatro links de envio', async () => {
  rpc.mockResolvedValue({ data: summary, error: null });
  const onClosed = vi.fn();
  await settle(() => root.render(<OfficialClosingPanel date={day} closed={false} onClosed={onClosed} />));
  await settle(() => button('Fechar Plantão').click());
  expect(getSession).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled();
  expect(container.querySelector('form,input[type="email"],input[type="password"]')).toBeNull();
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith('close_plantao_operation', { day, at_time: `${day}T10:00:00.000Z` });
  expect(onClosed).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Relatório Quantitativo Final');
  expect(container.textContent).toContain('Total de registros: 2');
  expect(container.querySelectorAll('a[href^="https://wa.me/"]')).toHaveLength(2);
  expect(container.querySelectorAll('a[href^="mailto:"]')).toHaveLength(2);
});

it('consulta o fechamento existente sem solicitar login', async () => {
  rpc.mockResolvedValue({ data: summary, error: null });
  await settle(() => root.render(<OfficialClosingPanel date={day} closed onClosed={() => {}} />));
  await settle(() => button('Consultar fechamento').click());
  expect(window.confirm).not.toHaveBeenCalled();
  expect(getSession).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Total de registros: 2');
});

it('mantém erro de banco visível e permite repetir o fechamento sem autenticação', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: 'Falha ao gravar snapshot' } })
    .mockResolvedValueOnce({ data: summary, error: null });
  const onClosed = vi.fn();
  await settle(() => root.render(<OfficialClosingPanel date={day} closed={false} onClosed={onClosed} />));
  await settle(() => button('Fechar Plantão').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Falha ao gravar snapshot');
  expect(onClosed).not.toHaveBeenCalled();
  await settle(() => button('Fechar Plantão').click());
  expect(onClosed).toHaveBeenCalledOnce(); expect(signIn).not.toHaveBeenCalled();
});

async function mountTest() {
  await settle(() => root.render(<SimProvider><TestModule brokers={[]} visits={[]} queue={[]} closed dbConnected
    onChanged={async () => {}} runMaintenance={work => work()} /></SimProvider>));
}
it('habilita o reset no TESTE em banco remoto sem variável de ambiente e envia uma única transação', async () => {
  rpc.mockResolvedValue({ data: null, error: null });
  await mountTest();
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Reiniciar Plantão')).toBe(false);
  await settle(() => button('TESTE').click());
  expect(button('Reiniciar Plantão').disabled).toBe(false);
  await settle(() => button('+1 min').click());
  await settle(() => button('Reiniciar Plantão').click());
  await settle(() => button('Confirmar reinício').click());
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith('reset_test_plantao', { day, test_mode: true, at_time: `${day}T11:31:00.000Z` });
  expect(container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe('08:30:00');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('não anuncia sucesso nem volta o relógio quando a transação de reset falha', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'Falha na transação de reset' } });
  await mountTest(); await settle(() => button('TESTE').click());
  await settle(() => button('+1 min').click());
  await settle(() => button('Reiniciar Plantão').click()); await settle(() => button('Confirmar reinício').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Falha na transação de reset');
  expect(container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe('08:31:00');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});

it('recusa o reset fora do modo TESTE antes de acessar o banco', async () => {
  await expect(resetTestPlantao(day, false)).rejects.toThrow('Ative o módulo TESTE');
  expect(rpc).not.toHaveBeenCalled();
});
