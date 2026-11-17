// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import RecepcaoPanel from './RecepcaoPanel';
import { SimProvider } from '@/lib/simContext';
import { dbReady, supabase } from '@/lib/supabase';
import { loadReportRows } from '@/lib/reports/reportStore';
import { isPlantaoClosed } from '@/lib/reports/officialClosing';
import { lookupReturn } from '@/lib/reception/intake';

let container: HTMLDivElement;
let root: Root;
const date = '2040-01-23';

function button(text: string) {
  const found = Array.from(container.querySelectorAll('button')).find(element => element.textContent?.trim() === text);
  expect(found, `Botão ${text}`).toBeDefined();
  return found!;
}
async function settle(action: () => void | Promise<void>) {
  await act(async () => {
    await action();
    // Flush the existing asynchronous Supabase mock and schedule updates.
    for (let step = 0; step < 30; step++) await Promise.resolve();
  });
}
async function refresh() {
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(date + 'T12:00:00Z'));
  localStorage.clear();
  localStorage.setItem('plantao_sim_seconds', String(8 * 3600 + 30 * 60));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  await dbReady;
  for (const table of ['queue_entries', 'visits', 'plantao_sessions', 'plantao_daily_closures', 'incorporadora_direct_leads', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details']) {
    await supabase.from(table).delete().neq('id', '');
  }
  await supabase.from('brokers').update({ presence_status: 'ausente', attendance_status: 'livre',
    arrived_at: null, shift: null, sorteio_order: null, inverse_order: null }).neq('id', '');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('barra de simulação na aplicação', () => {
  it('renderiza aberta no topo e controla o relógio virtual, os atalhos e o recolhimento', async () => {
    await settle(() => root.render(<App />));
    const toolbar = container.querySelector('section[aria-label="Modo Simulação / Testes Rápidos"]')!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.compareDocumentPosition(container.querySelector('header')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const toggle = button('Modo Simulação / Testes Rápidos');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controls = toolbar.querySelector('#simulation-controls') as HTMLDivElement;
    expect(controls.hidden).toBe(false);
    const clock = toolbar.querySelector('output')!;
    expect(clock.textContent).toBe('08:30:00');
    const input = toolbar.querySelector('input[type="time"]') as HTMLInputElement;
    await settle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '08:46:00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(clock.textContent).toBe('08:46:00');
    for (const time of ['08:00', '08:46', '09:00', '13:46', '14:00', '19:00']) {
      await settle(() => button(time).click());
      expect(clock.textContent).toBe(time + ':00');
    }
    await settle(() => button('+1 minuto').click());
    expect(clock.textContent).toBe('19:01:00');
    expect(localStorage.getItem('plantao_sim_seconds')).toBe(String(19 * 3600 + 60));
    await settle(() => button('Chamadas de teste · 2 min').click());
    expect(button('Chamadas de teste · 10 s').getAttribute('aria-pressed')).toBe('true');
    await settle(() => toggle.click());
    expect(controls.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await settle(() => toggle.click());
    await settle(() => button('Motor da Fila').click());
    expect(controls.hidden).toBe(false);
    expect(button('Simular Primeira Visita').closest('#simulation-controls')).toBe(controls);
  });

  it('mantém os geradores visíveis e bloqueados até abrir a simulação quando o ambiente não permite testes', async () => {
    const target = document.createElement('div');
    container.appendChild(target);
    const setQuickLog = vi.fn();
    await settle(() => root.render(<SimProvider><RecepcaoPanel brokers={[]} visits={[]} queue={[]}
      allowTestControls={false} testsDisabled={false} simulationTarget={target}
      quickLog={[]} setQuickLog={setQuickLog} /></SimProvider>));
    // The portal destination normally belongs to the toolbar, outside the reception form.
    container.appendChild(target);
    for (const label of ['Primeira Visita', 'Decorado', 'Indicação', 'Retorno']) {
      const generator = button('Simular ' + label);
      expect(target.contains(generator)).toBe(true);
      expect(generator.closest('[hidden]')).toBeNull();
      expect(generator.closest('fieldset')?.disabled).toBe(true);
      await settle(() => generator.click());
    }
    expect(target.textContent).toContain('Abra o ambiente local de simulação');
    expect(setQuickLog).not.toHaveBeenCalled();
  });

  it('gera os quatro tipos com um clique e copia o telefone que identifica o retorno', async () => {
    const { data: brokers } = await supabase.from('brokers').select('*').eq('is_external_partner', false);
    const owner = brokers![0];
    await supabase.from('brokers').update({ presence_status: 'presente', attendance_status: 'livre',
      arrived_at: date + 'T08:15:00-03:00', shift: 'manha' }).eq('id', owner.id);
    await settle(() => root.render(<App />));
    await settle(() => button('Corretor / Gerente').click());
    for (const label of ['Primeira Visita', 'Decorado', 'Indicação', 'Retorno']) {
      await settle(() => button('Simular ' + label).click());
      await refresh();
    }
    const { data: visits } = await supabase.from('visits').select('*').eq('is_test', true);
    expect(visits?.map(visit => visit.visit_reason)).toEqual(['Primeira visita', 'Visita ao Decorado', 'Indicação', 'Retorno']);
    expect(new Set(visits?.map(visit => visit.phone)).size).toBe(4);
    const log = container.querySelector('[aria-label="Telefones de teste"]')!;
    expect(log.querySelectorAll('li')).toHaveLength(4);
    const returned = visits!.find(visit => visit.visit_reason === 'Retorno');
    const copyButton = log.querySelector(`[aria-label="Copiar telefone ${returned.phone}"]`) as HTMLButtonElement;
    await settle(() => copyButton.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(returned.phone);
    expect((await lookupReturn(returned.phone))?.ownerId).toBe(owner.id);
    expect(container.querySelector('main')?.textContent).not.toContain(returned.phone);
  });

  it('permite reset após fechamento e preserva fatos quantitativos e visitas históricas', async () => {
    const historicalDate = '2040-01-22';
    await supabase.from('incorporadora_direct_leads').insert({ customer_name: 'Histórico', phone: '11911112222',
      visit_reason: 'Primeira visita', created_at: historicalDate + 'T10:00:00-03:00', shift: 'manha', is_test: true });
    const { data: owner } = await supabase.from('brokers').select('*').eq('is_external_partner', false).limit(1).single();
    await supabase.from('visits').insert({ id: 'visited-before-reset', customer_name: 'Atendido', phone: '11922223333',
      visit_reason: 'Primeira visita', created_at: date + 'T08:20:00-03:00' });
    await supabase.from('queue_entries').insert({ id: 'served-before-reset', visit_id: 'visited-before-reset', broker_id: owner.id,
      queue_status: 'concluido', queue_type: 'geral', agency: owner.agency, shift: 'manha', created_at: date + 'T08:20:00-03:00' });
    await settle(() => root.render(<App />));
    await settle(() => button('Simular Primeira Visita').click());
    const filter = { period: 'day' as const, date, shift: 'manha' as const };
    await settle(() => button('Fechar Plantão').click());
    await refresh();
    expect(await isPlantaoClosed(date)).toBe(true);
    const before = await loadReportRows(filter);
    const historicalBefore = await loadReportRows({ ...filter, date: historicalDate });
    expect(button('Reiniciar Plantão (Reset de Teste)').disabled).toBe(false);
    await settle(() => button('Reiniciar Plantão (Reset de Teste)').click());
    await settle(() => button('Confirmar reinício').click());
    expect(await isPlantaoClosed(date)).toBe(false);
    expect(button('Fechar Plantão').disabled).toBe(false);
    expect((await supabase.from('queue_entries').select('*')).data).toHaveLength(0);
    expect((await supabase.from('brokers').select('*')).data?.every(broker => broker.presence_status === 'ausente' && broker.attendance_status === 'livre')).toBe(true);
    expect(await loadReportRows(filter)).toEqual(before);
    expect(await loadReportRows({ ...filter, date: historicalDate })).toEqual(historicalBefore);
    expect((await supabase.from('visits').select('*').eq('id', 'visited-before-reset')).data).toHaveLength(1);
    expect(container.querySelector('output[aria-label="Hora virtual"]')?.textContent).toBe('08:30:00');
    expect(button('Simular Primeira Visita').closest('fieldset')?.disabled).toBe(false);
  });
});
