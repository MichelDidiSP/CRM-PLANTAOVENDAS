// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { dbReady, supabase, type Broker } from '@/lib/supabase';
import { publishClock } from '@/lib/plantaoClock';
import type { ShiftDraw } from '@/lib/queue/shiftSchedule';
import * as scheduleStore from '@/lib/queue/shiftScheduleStore';
import { getCompanyDrawOrder } from '@/lib/queueEngine';

const day = '2040-01-23';
const roster = [
  ['didi', 'Didi', 'Viva Imóveis'], ['mussum', 'Mussum', 'Viva Imóveis'],
  ['he-man', 'He-Man', 'Casa Nobre'], ['esqueleto', 'Esqueleto', 'Casa Nobre'],
].map(([id, operational_name, agency]) => ({
  id, operational_name, agency, equipe: 'Equipe original', is_external_partner: false,
  external_company: null, presence_status: 'ausente', attendance_status: 'livre',
  arrived_at: null, shift: null, sorteio_order: null, inverse_order: null,
  afternoon_reserved: false, returning_from_pause: false,
  created_at: `${day}T08:00:00-03:00`, last_status_update: `${day}T08:00:00-03:00`,
} as Broker));
let root: Root;
let container: HTMLDivElement;

async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 150; i++) await Promise.resolve(); });
}
function buttons(label: string) {
  return [...container.querySelectorAll('button')].filter(b => b.textContent?.trim() === label);
}
async function click(label: string) {
  expect(buttons(label).length, label).toBeGreaterThan(0);
  await settle(() => buttons(label)[0].click());
}
async function time(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Horário virtual"]')!;
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function draw(turn: 'morning' | 'afternoon'): Promise<ShiftDraw | undefined> {
  const result = await supabase.from('plantao_sessions').select('*').eq('id', `schedule_${day}_${turn}`).maybeSingle();
  return result.data?.schedule_data;
}
function publicity(title: string) {
  return [...container.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent?.startsWith(title));
}
function expectQueues(result: ShiftDraw | undefined, title: string) {
  expect(result?.viva.slice().sort()).toEqual(['didi', 'mussum']);
  expect(result?.nobre.slice().sort()).toEqual(['esqueleto', 'he-man']);
  expect(result?.inverse.slice().sort()).toEqual(roster.map(b => b.id).sort());
  const section = publicity(title)!;
  expect(section).toBeDefined();
  expect(section.textContent).toContain(`Ordem das imobiliárias: 1ª ${result!.firstAgency}`);
  expect(section.querySelectorAll('ol')).toHaveLength(3);
  for (const broker of roster) expect(section.textContent).toContain(broker.operational_name);
}

beforeEach(async () => {
  vi.useFakeTimers();
  // Reproduce opening the real application in the afternoon BEFORE enabling TESTE.
  vi.setSystemTime(new Date(`${day}T18:00:00Z`));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock();
  await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions', 'plantao_daily_closures',
    'incorporadora_direct_leads', 'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details']) {
    await supabase.from(table).delete().neq('id', '');
  }
  await supabase.from('brokers').insert(roster);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('sorteio automático pelo fluxo completo do TESTE', () => {
  it.each(['08:46:00', '08:50:00'])('inscreve pela interface e publica as filas ao avançar para %s', async at => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    await settle(() => root.render(<App />));
    await click('TESTE');
    await time('08:30:00');
    await click('Corretor / Gerente');
    expect(buttons('Registrar presença')).toHaveLength(4);
    for (const button of buttons('Registrar presença')) await settle(() => button.click());
    const registered = (await supabase.from('brokers').select('*')).data!;
    expect(registered.every(b => b.presence_status === 'presente' && b.arrived_at === `${day}T11:30:00.000Z`)).toBe(true);
    await click('Recepção');
    await time('08:45:59');
    expect(publicity('Sorteio da manhã')).toBeUndefined();
    random.mockReturnValue(0.9);
    await time(at);
    const morning = await draw('morning');
    expectQueues(morning, 'Sorteio da manhã');
    await click('Auditoria');
    expectQueues(morning, 'Sorteio da manhã');
    await time('08:59:59');
    expect(await draw('morning')).toEqual(morning);
    await time('09:00:00');
    const active = (await supabase.from('plantao_sessions').select('*').eq('id', `schedule_${day}_morning_activate`).single()).data;
    expect(active.schedule_data).toEqual(morning);
    expect(getCompanyDrawOrder()[0]).toBe(morning!.firstAgency);
    for (const broker of (await supabase.from('brokers').select('*')).data!) {
      expect(broker.sorteio_order).toBe((broker.agency === 'Viva Imóveis' ? morning!.viva : morning!.nobre).indexOf(broker.id) + 1);
    }
  });

  it('inscreve na tarde pela interface e publica às 13:46, mantendo a manhã em operação', async () => {
    await settle(() => root.render(<App />)); await click('TESTE');
    await time('13:10:00'); await click('Corretor / Gerente');
    expect(buttons('Inscrever na tarde')).toHaveLength(4);
    for (const button of buttons('Inscrever na tarde')) await settle(() => button.click());
    await click('Recepção'); await time('13:45:59');
    expect(publicity('Sorteio da tarde')).toBeUndefined();
    await time('13:46:00');
    const afternoon = await draw('afternoon');
    expectQueues(afternoon, 'Sorteio da tarde');
    expect(publicity('Sorteio da tarde')?.textContent).toContain('fila da manhã ainda em operação');
    await time('13:59:59'); expect(await draw('afternoon')).toEqual(afternoon);
    await time('14:00:01');
    expect((await supabase.from('brokers').select('*')).data!.every(b => b.shift === 'tarde')).toBe(true);
    expect((await supabase.from('plantao_sessions').select('*').eq('id', `schedule_${day}_activate`).single()).data.schedule_data).toEqual(afternoon);
  });

  it('processa o último salto virtual imediatamente após uma consulta em andamento, sem esperar outro segundo real', async () => {
    vi.setSystemTime(new Date(`${day}T10:00:00Z`)); publishClock();
    await settle(() => root.render(<App />)); await click('TESTE');
    await click('Corretor / Gerente');
    for (const button of buttons('Registrar presença')) await settle(() => button.click());
    await click('Recepção');
    const original = scheduleStore.advanceSchedule;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(scheduleStore, 'advanceSchedule').mockImplementationOnce(async (...args) => {
      await pending; return original(...args);
    });
    await time('08:45:59');
    expect(spy).toHaveBeenCalledTimes(1);
    await time('08:46:00'); await time('08:47:00');
    await settle(() => release());
    expectQueues(await draw('morning'), 'Sorteio da manhã');
    expect(spy.mock.calls.some(([clock]) => clock.seconds === 8 * 3600 + 47 * 60)).toBe(true);
    expect(Date.now()).toBe(Date.parse(`${day}T10:00:00Z`));
  });

  it('dispara pelo relógio real de produção, com TESTE desativado', async () => {
    vi.setSystemTime(new Date(`${day}T11:30:00Z`)); publishClock();
    await settle(() => root.render(<App />)); await click('Corretor / Gerente');
    for (const button of buttons('Registrar presença')) await settle(() => button.click());
    await click('Recepção');
    await settle(() => { vi.setSystemTime(new Date(`${day}T11:45:59Z`)); publishClock(); });
    expect(publicity('Sorteio da manhã')).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.querySelector('#test-module')).toBeNull();
    expectQueues(await draw('morning'), 'Sorteio da manhã');
  });
});
