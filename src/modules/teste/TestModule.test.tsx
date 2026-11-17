// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { SimProvider, useSim } from '@/lib/simContext';
import { getPlantaoTime, plantaoClockParts, publishClock, afterPlantaoDelay } from '@/lib/plantaoClock';
import { dbReady, supabase, type Broker, type QueueEntry } from '@/lib/supabase';
import { getScheduleClock, scheduleAt } from '@/lib/queue/shiftSchedule';
import { enrollAfternoon } from '@/lib/queue/shiftScheduleStore';
import { actOnPause, enforcePauses } from '@/lib/queue/pauseAndPartnersStore';
import { pauseElapsed, type PauseBroker } from '@/lib/queue/pauseAndPartners';
import { dispatchBroker } from '@/lib/queueEngine';
import { isPlantaoClosed } from '@/lib/reports/officialClosing';
import { loadReportRows } from '@/lib/reports/reportStore';
import { createVirtualClock } from './virtualClock';
import ChamadasPanel from '@/components/ChamadasPanel';

const day = '2040-01-23';
let container: HTMLDivElement;
let root: Root;
let stopClock: (() => void) | undefined;
const makeBroker = (id: string, name: string, agency: Broker['agency'], order: number): Broker => ({
  id, operational_name: name, agency, equipe: 'Equipe original', is_external_partner: false, external_company: null,
  presence_status: 'presente', attendance_status: 'livre', arrived_at: `${day}T08:${order === 1 ? '10' : '20'}:00-03:00`,
  last_status_update: `${day}T08:00:00-03:00`, created_at: `${day}T08:00:00-03:00`, shift: 'manha',
  sorteio_order: order, inverse_order: order, afternoon_reserved: false, returning_from_pause: false,
} as Broker);
const originalBrokers = [makeBroker('didi', 'Didi', 'Viva Imóveis', 1), makeBroker('mussum', 'Mussum', 'Viva Imóveis', 2),
  makeBroker('he-man', 'He-Man', 'Casa Nobre', 1), makeBroker('esqueleto', 'Esqueleto', 'Casa Nobre', 2)];
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let step = 0; step < 100; step++) await Promise.resolve(); });
}
function button(text: string) {
  const found = Array.from(container.querySelectorAll('button')).find(element => element.textContent?.trim() === text);
  expect(found, `Botão ${text}`).toBeDefined(); return found!;
}
async function setInput(input: HTMLInputElement, value: string) {
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function time(value: string) { await setInput(container.querySelector('input[type="time"]')!, value); }
async function refresh() { await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); }
async function start() { await settle(() => root.render(<App />)); await settle(() => button('TESTE').click()); }
async function brokers() { return (await supabase.from('brokers').select('*')).data as Broker[]; }
function clockAt() { return { at: getPlantaoTime().toISOString(), shift: scheduleAt({ seconds: plantaoClockParts(getPlantaoTime()).simSeconds, date: day, singleShift: false }).shift }; }

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${day}T10:00:00Z`));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  localStorage.clear(); publishClock();
  await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'incorporadora_direct_leads', 'plantao_sessions', 'plantao_daily_closures', 'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details']) {
    await supabase.from(table).delete().neq('id', '');
  }
  await supabase.from('brokers').insert(originalBrokers);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); stopClock?.(); }); stopClock = undefined;
  container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('módulo TESTE isolado', () => {
  it('usa o relógio real por padrão, só exibe ferramentas em TESTE e volta ao real ao sair', async () => {
    localStorage.setItem('plantao_sim_seconds', '30000'); localStorage.setItem('plantao_test_mode', 'true');
    await settle(() => root.render(<App />));
    expect(container.querySelector('input[type="time"]')).toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('07:00:00');
    expect(container.textContent).not.toContain('Simular Entrada Rápida');
    const names = (await brokers()).map(broker => broker.operational_name);
    await settle(() => button('TESTE').click());
    expect(container.querySelector('output')?.textContent).toBe('08:30:00');
    const module = container.querySelector('#test-module')!;
    expect(module.contains(button('Simular Entrada Rápida'))).toBe(true);
    expect(module.contains(button('Reiniciar Plantão'))).toBe(true);
    await settle(() => button('+1 min').click());
    expect(container.querySelector('output')?.textContent).toBe('08:31:00');
    await settle(() => button('Chamadas: 2 minutos').click());
    expect(button('Chamadas: 10 segundos').getAttribute('aria-pressed')).toBe('true');
    await time('23:59:59');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getPlantaoTime().toISOString()).toBe('2040-01-24T03:00:01.000Z');
    await settle(() => button('TESTE').click());
    expect(container.querySelector('#test-module')).toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('07:00:02');
    expect((await brokers()).map(broker => broker.operational_name)).toEqual(names);
    await settle(() => button('TESTE').click());
    expect(getPlantaoTime().toISOString()).toBe('2040-01-24T03:00:01.000Z');
  });

  it('funciona com relógio real quando o módulo TESTE não é montado', async () => {
    function Probe() { const clock = useSim(); return <p>{clock.clockDisplay} · {clock.callDuration}</p>; }
    await settle(() => root.render(<SimProvider><Probe /></SimProvider>));
    expect(container.textContent).toBe('07:00:00 · 120');
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(container.textContent).toBe('07:01:00 · 120');
  });

  it.each([false, true])('publica sorteio às 08:46 e mantém chegada até 08:59:59 (integral=%s)', async (integral) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await start();
    if (integral) await settle(() => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    await time('08:45:59'); expect(container.textContent).not.toContain('Ordem das imobiliárias:');
    await time('08:46:00');
    expect(container.textContent).toContain('Ordem das imobiliárias:');
    expect(container.textContent).toContain('Sorteio da manhã — ordem de chegada até 08:59:59');
    const draw = (await supabase.from('plantao_sessions').select('*').eq('id', `schedule_${day}_morning`).single()).data.schedule_data;
    expect(draw.viva).toEqual(['mussum', 'didi']);
    expect(draw.nobre).toEqual(['esqueleto', 'he-man']);
    await time('08:59:59');
    expect(dispatchBroker(await brokers(), 'geral', getScheduleClock()!.seconds, new Set(), null, null).source).toBe('pre_opening');
    await time('09:00:00');
    expect(scheduleAt(getScheduleClock()!).preOpening).toBe(false);
    expect(dispatchBroker(await brokers(), 'geral', getScheduleClock()!.seconds, new Set(), null, null).source).not.toBe('pre_opening');
    if (integral) { await time('13:46:00'); expect(container.textContent).not.toContain('Sorteio da tarde'); }
  });

  it('publica a tarde às 13:46 sem antecipar a virada congelada das 14:00:01', async () => {
    await start(); await time('13:10:00');
    await settle(async () => { for (const broker of originalBrokers) await enrollAfternoon(broker.id, getScheduleClock()!); });
    await time('13:45:59'); expect(container.textContent).not.toContain('Sorteio da tarde —');
    await time('13:46:00'); expect(container.textContent).toContain('Sorteio da tarde — fila da manhã ainda em operação');
    expect(container.textContent?.match(/Ordem das imobiliárias:/g)).toHaveLength(2);
    await time('14:00:00'); expect(scheduleAt(getScheduleClock()!).shift).toBe('manha');
    await time('14:00:01'); expect(scheduleAt(getScheduleClock()!).shift).toBe('tarde');
    expect((await brokers()).every(broker => broker.shift === 'tarde')).toBe(true);
  });

  it.each([['09:30:00', false], ['09:30:01', true], ['14:30:00', false], ['14:30:01', true]] as const)(
    'aplica o corte oficial ao horário virtual %s', async (at, restricted) => {
      const clock = createVirtualClock(); stopClock = clock.start(); clock.setTime(at);
      await supabase.from('brokers').update({ presence_status: 'ausente', arrived_at: null, shift: null }).eq('id', 'didi');
      await actOnPause('didi', 'checkin', clockAt());
      expect(Boolean(((await brokers()).find(broker => broker.id === 'didi')! as PauseBroker).only_own_referrals)).toBe(restricted);
    });

  it('conta 120 minutos contínuos de pausa pelo relógio virtual sem reiniciar ao pausar novamente', async () => {
    const clock = createVirtualClock(); stopClock = clock.start(); clock.setTime('09:10:00');
    await actOnPause('didi', 'pause', clockAt());
    clock.setTime('09:20:00'); await actOnPause('didi', 'pause', clockAt());
    clock.setTime('11:10:00'); await enforcePauses(clockAt());
    let broker = (await brokers()).find(b => b.id === 'didi')! as PauseBroker;
    expect(pauseElapsed(broker, clockAt().at)).toBe(120 * 60000);
    expect(broker.only_own_referrals).not.toBe(true);
    clock.setTime('11:10:01'); await enforcePauses(clockAt());
    broker = (await brokers()).find(b => b.id === 'didi')! as PauseBroker;
    expect(broker.only_own_referrals).toBe(true);
    expect((await supabase.from('pause_audit').select('*')).data).toHaveLength(1);
  });

  it('gera pela rotina original e mostra dados completos só no TESTE, com o corretor efetivo', async () => {
    await start(); await settle(() => button('Simular Entrada Rápida').click());
    const visit = (await supabase.from('visits').select('*').eq('is_test', true).single()).data;
    let entry = (await supabase.from('queue_entries').select('*').eq('visit_id', visit.id).single()).data;
    const expected = dispatchBroker(originalBrokers, 'geral', getScheduleClock()!.seconds, new Set(), null, null).broker!;
    expect(entry.broker_id).toBe(expected.id); expect(entry.queue_status).toBe('chamando');
    const table = () => container.querySelector('[aria-label="Clientes Inseridos no Teste"]')!;
    expect(table().textContent).toContain(visit.customer_name); expect(table().textContent).toContain(visit.phone);
    expect(table().textContent).toContain('Ainda não atendido'); expect(table().querySelector('button')).toBeNull();
    expect(container.querySelector('main')!.textContent).not.toContain(visit.phone);
    await settle(() => button('Motor da Fila').click()); await settle(() => button('Confirmar presença').click()); await refresh();
    expect(table().textContent).toContain(expected.operational_name);
    entry = (await supabase.from('queue_entries').select('*').eq('visit_id', visit.id).single()).data;
    expect(entry.updated_at).toBe(`${day}T11:30:00.000Z`);
    await settle(() => button('Recepção').click());
    await setInput(container.querySelector('input[type="tel"]')!, visit.phone);
    const returnSelect = container.querySelector('main select[disabled]') as HTMLSelectElement;
    expect(returnSelect.value).toBe('Retorno');
    await settle(() => button('TESTE').click()); expect(container.textContent).not.toContain(visit.phone);
  });

  it('o cronômetro da TV acompanha saltos do relógio e atrasos de rechamada usam a mesma fonte', async () => {
    const clock = createVirtualClock(); stopClock = clock.start(); clock.setTime('10:00:00');
    const entry = { id: 'timer', visit_id: 'timer-visit', broker_id: 'didi', queue_status: 'chamando', queue_type: 'geral',
      attempts: 1, called_at: getPlantaoTime().toISOString(), created_at: getPlantaoTime().toISOString(), agency: 'Viva Imóveis', shift: 'manha' } as QueueEntry;
    await supabase.from('visits').insert({ id: 'timer-visit', customer_name: 'Teste TV', phone: '11912345678' });
    await supabase.from('queue_entries').insert(entry);
    await settle(() => root.render(<SimProvider><ChamadasPanel queue={[entry]} brokers={originalBrokers} /></SimProvider>));
    expect(container.textContent).toContain('02:00');
    await settle(() => clock.setTime('10:01:59')); expect(container.textContent).toContain('00:01');
    await settle(() => clock.setTime('10:02:00'));
    expect((await supabase.from('queue_entries').select('*').eq('id', 'timer').single()).data.queue_status).toBe('aguardando');
    expect(((await brokers()).find(b => b.id === 'didi') as PauseBroker).pause_started_at).toBe(`${day}T13:02:00.000Z`);
    const callback = vi.fn(); const cancel = afterPlantaoDelay(callback, 60000);
    await settle(() => clock.setTime('10:02:59')); expect(callback).not.toHaveBeenCalled();
    await settle(() => clock.setTime('10:03:00')); expect(callback).toHaveBeenCalledOnce(); cancel();
    expect(container.textContent).not.toContain('11912345678');
  });

  it('reinicia pelo módulo após fechar, sem substituir corretores nem apagar fatos históricos', async () => {
    await start(); await settle(() => button('Simular Entrada Rápida').click());
    await settle(() => button('Motor da Fila').click()); await settle(() => button('Confirmar presença').click()); await refresh();
    const filter = { period: 'day' as const, date: day, shift: 'manha' as const };
    const facts = await loadReportRows(filter);
    await settle(() => button('Recepção').click()); await settle(() => button('Fechar Plantão').click()); await refresh();
    expect(await isPlantaoClosed(day)).toBe(true);
    await settle(() => button('Reiniciar Plantão').click()); await settle(() => button('Confirmar reinício').click());
    expect(await isPlantaoClosed(day)).toBe(false);
    expect((await supabase.from('queue_entries').select('*')).data).toHaveLength(0);
    expect((await brokers()).map(b => b.operational_name)).toEqual(originalBrokers.map(b => b.operational_name));
    expect((await brokers()).every(b => b.presence_status === 'ausente' && b.attendance_status === 'livre')).toBe(true);
    expect(await loadReportRows(filter)).toEqual(facts);
    expect(container.querySelector('output')?.textContent).toBe('08:30:00');
  });
});
