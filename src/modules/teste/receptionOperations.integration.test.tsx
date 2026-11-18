// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import RecepcaoPanel from '@/components/RecepcaoPanel';
import ReceptionAuditPanel from '@/components/ReceptionAuditPanel';
import { SimProvider } from '@/lib/simContext';
import { installPlantaoClock, publishClock } from '@/lib/plantaoClock';
import { supabase, dbReady } from '@/lib/supabase';
import { fetchAll } from '@/lib/queueEngine';
import { attachReceptionPolicies, changeNominalWaiting, createReceptionPolicy, dispatchOperationalWaiting,
  newReceptionPolicy, readReceptionPolicy, refuseInverseCall } from '@/lib/reception/operationalStore';
import { lookupReceptionReturn } from '@/lib/reception/returnLookup';
import { person, customer, waiting, receptionAt as at, receptionDay as day, receptionClock as clock } from './receptionFixtures';

let root: Root; let container: HTMLDivElement; let uninstall: (() => void) | undefined;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 220; i++) await Promise.resolve(); });
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeDefined(); await settle(() => button!.click());
}
async function input(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  expect(el, selector).not.toBeNull();
  await settle(() => {
    Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function answer(yes: boolean) { await settle(() => container.querySelectorAll<HTMLInputElement>('input[name="absence-wait"]')[yes ? 0 : 1].click()); }
async function currentQueue() { return (await fetchAll()).queue; }
async function seedCall(position = 1) {
  const brokers = [person('Didi', { sorteio_order: 10, inverse_order: 1, attendance_status: 'em_mesa' }),
    person('Mussum', { sorteio_order: 20, inverse_order: 3 }), person('He-Man', { agency: 'Casa Nobre', sorteio_order: 1, inverse_order: 2 })];
  if (position === 2) brokers[0].sorteio_order = 25;
  if (position === 3) brokers.push(person('Dedé', { sorteio_order: 5 }));
  if (position === 3) brokers[0].sorteio_order = 30;
  await supabase.from('brokers').insert(brokers);
  await supabase.from('visits').insert(customer({ visit_reason: 'Visita ao Decorado', phone: position === 2 ? null : '11987654321', referred_broker_id: null, status: 'aguardando_chamada' }));
  const { visit: _, ...entry } = waiting({ queue_type: 'decorado', queue_status: 'chamando', broker_id: 'Didi', attempts: 1, called_at: at, reception_waiting: false });
  await supabase.from('queue_entries').insert(entry);
}
function ReceptionHarness() {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAll>>>();
  async function load() {
    const live = await fetchAll();
    const sessions = await supabase.from('plantao_sessions').select('*').eq('plantao_date', day);
    setData({ ...live, queue: attachReceptionPolicies(live.queue, sessions.data ?? []) });
  }
  useEffect(() => { void load(); }, []);
  return <SimProvider>{data && <><RecepcaoPanel {...data} onChanged={load} /><ReceptionAuditPanel {...data} /></>}</SimProvider>;
}
async function renderReception() {
  uninstall = installPlantaoClock({ now: () => Date.parse(at) });
  await settle(() => root.render(<ReceptionHarness />));
}
async function seedWaiting(mode: 'arrival' | 'nominal', ownerId: string | null = 'Didi') {
  await supabase.from('visits').insert(customer({ referred_broker_id: ownerId, visit_reason: ownerId ? 'Retorno' : 'Primeira visita' }));
  const { visit: _, ...entry } = waiting();
  await createReceptionPolicy(newReceptionPolicy(entry.id, ownerId, mode, at), day, at);
  await supabase.from('queue_entries').insert(entry);
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock(); await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions', 'plantao_daily_closures',
    'incorporadora_direct_leads', 'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details'])
    await supabase.from(table).delete().neq('id', '');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); uninstall?.(); uninstall = undefined; container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('recepção: telefone, espera e recusa pela interface real', () => {
  it('telefone com DDD reconhece o primeiro dono em visitas TESTE e elimina o seletor manual', async () => {
    await supabase.from('brokers').insert([person('Didi'), person('He-Man', { agency: 'Casa Nobre' })]);
    await supabase.from('visits').insert(customer({ id: 'historical', referred_broker_id: null, status: 'encerrado', is_test: true }));
    const { visit: _, ...entry } = waiting({ id: 'historical-q', visit_id: 'historical', queue_status: 'concluido', broker_id: 'Didi' });
    await supabase.from('queue_entries').insert(entry);
    await renderReception();
    await input('[placeholder="Nome completo"]', 'Maria Retornou');
    await input('input[type="tel"]', '11987654321');
    expect(container.textContent).toContain('Retorno identificado. Corretor original: Didi');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Motivo da visita"]')!.value).toBe('Retorno');
    expect(container.querySelector('[aria-label="Corretor original"]')).toBeNull();
    await click('Cadastrar visita');
    const created = (await currentQueue()).find(e => e.id !== 'historical-q')!;
    expect(created).toMatchObject({ broker_id: 'Didi', queue_status: 'chamando', commission_split: false,
      visit: { visit_reason: 'Retorno', referred_broker_id: 'Didi', is_test: true } });
    expect(container.textContent).not.toContain('Selecione o corretor original');
    expect(container.textContent).not.toContain('11987654321');
  });
  it('produção ignora visitas de teste; telefone desconhecido mantém o fallback manual', async () => {
    await supabase.from('brokers').insert(person('Didi'));
    await supabase.from('visits').insert(customer({ is_test: true }));
    expect(await lookupReceptionReturn('(11) 98765-4321', false)).toBeNull();
    expect(await lookupReceptionReturn('(11) 98765-4321', true)).toMatchObject({ ownerId: 'Didi' });
    await renderReception(); await input('input[type="tel"]', '11999998888');
    await input('[aria-label="Motivo da visita"]', 'Retorno');
    expect(container.querySelector('[aria-label="Corretor original"]')).not.toBeNull();
    await input('[aria-label="Corretor original"]', 'Didi');
    await input('[placeholder="Nome completo"]', 'Novo Retorno'); await click('Cadastrar visita');
    expect((await currentQueue())[0].visit?.referred_broker_id).toBe('Didi');
  });
  it('sair do relógio TESTE remove a identificação automática derivada apenas de visita fictícia', async () => {
    await supabase.from('brokers').insert(person('Didi')); await supabase.from('visits').insert(customer({ is_test: true }));
    await renderReception(); await input('input[type="tel"]', '11987654321');
    expect(container.textContent).toContain('Retorno identificado');
    await settle(() => uninstall?.()); uninstall = undefined;
    expect(container.textContent).not.toContain('Retorno identificado');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Motivo da visita"]')!.value).toBe('Primeira visita');
  });
  it('trocar rapidamente o telefone limpa a identificação antiga', async () => {
    await supabase.from('brokers').insert(person('Didi'));
    await supabase.from('visits').insert(customer({ is_test: true }));
    await renderReception(); await input('input[type="tel"]', '11987654321');
    expect(container.textContent).toContain('Retorno identificado');
    await input('input[type="tel"]', '11999998888');
    expect(container.textContent).not.toContain('Retorno identificado');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Motivo da visita"]')!.value).toBe('Primeira visita');
  });
  it.each(['Primeira visita', 'Visita ao Decorado', 'Sem telefone'])('cliente novo %s aguarda o primeiro corretor com 100%%', async reason => {
    await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente', arrived_at: null }), person('He-Man', { agency: 'Casa Nobre', presence_status: 'ausente', arrived_at: null })]);
    await renderReception(); await input('[placeholder="Nome completo"]', 'Cliente Novo');
    if (reason !== 'Sem telefone') { await input('input[type="tel"]', '11988887777'); await input('[aria-label="Motivo da visita"]', reason); }
    else await settle(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(container.textContent).toContain('Deseja aguardar o primeiro corretor chegar?');
    await answer(true); await click('Cadastrar visita');
    expect((await currentQueue())[0].queue_status).toBe('aguardando');
    await supabase.from('brokers').update({ presence_status: 'presente', arrived_at: at }).eq('id', 'He-Man');
    const live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue())[0]).toMatchObject({ broker_id: 'He-Man', commission_split: false, queue_status: 'chamando' });
  });
  it('novo cliente que não aguarda vai somente para a Incorporadora', async () => {
    await supabase.from('brokers').insert(person('Didi', { presence_status: 'ausente' }));
    await renderReception(); await input('[placeholder="Nome completo"]', 'Cliente Incorporadora');
    await input('input[type="tel"]', '11988887777'); await answer(false); await click('Cadastrar visita');
    expect(await currentQueue()).toHaveLength(0);
    expect((await supabase.from('incorporadora_direct_leads').select('*')).data).toEqual([expect.objectContaining({
      customer_name: 'Cliente Incorporadora', phone: '11988887777', is_test: true, visit_reason: 'Primeira visita' })]);
  });
  it('retorno que não aguarda o original entra na prioridade com Split, sem virar lead direto', async () => {
    await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente' }), person('He-Man', { agency: 'Casa Nobre', presence_status: 'ausente' })]);
    await supabase.from('visits').insert(customer({ id: 'old', is_test: true }));
    await renderReception(); await input('[placeholder="Nome completo"]', 'Cliente Retorno');
    await input('input[type="tel"]', '11987654321');
    expect(container.textContent).toContain('Deseja aguardar o corretor original (Didi)?');
    await answer(false); await click('Cadastrar visita');
    await supabase.from('brokers').update({ presence_status: 'presente' }).eq('id', 'He-Man');
    const live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue())[0]).toMatchObject({ broker_id: 'He-Man', commission_split: true });
    expect((await supabase.from('incorporadora_direct_leads').select('*')).data).toHaveLength(0);
  });
  it.each(['equipe', 'empresa', 'outra empresa'])('mudança de opinião no botão alcança %s imediatamente e sobrevive à remontagem', async level => {
    await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente' }), person('Mussum', { sorteio_order: 2 }),
      person('Dedé', { equipe: 'B', sorteio_order: 10 }), person('He-Man', { agency: 'Casa Nobre', sorteio_order: 20 })]);
    if (level !== 'equipe') await supabase.from('brokers').update({ presence_status: 'pausa' }).eq('id', 'Mussum');
    if (level === 'outra empresa') await supabase.from('brokers').update({ presence_status: 'ausente' }).eq('id', 'Dedé');
    await seedWaiting('nominal'); await renderReception();
    await click('Mudou de ideia / Atender com outro corretor');
    expect((await currentQueue())[0]).toMatchObject({ broker_id: level === 'equipe' ? 'Mussum' : level === 'empresa' ? 'Dedé' : 'He-Man', commission_split: true,
      applied_rule: level === 'equipe' ? 'Último da Equipe (Split)' : level === 'empresa' ? 'Último da Empresa (Split)' : 'Transbordo Interempresas (Split)' });
    expect((await readReceptionPolicy('queue'))?.mode).toBe('coverage');
    await settle(() => root.render(<div />)); await settle(() => root.render(<ReceptionHarness />));
    expect(container.textContent).toContain('Cliente desistiu da espera nominal');
  });
  it('mudança de opinião sem presentes converte para primeira chegada com Split', async () => {
    await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente' }), person('Mussum', { presence_status: 'ausente' })]);
    await seedWaiting('nominal'); await changeNominalWaiting('queue', clock, at);
    expect((await readReceptionPolicy('queue'))?.mode).toBe('arrival');
    await supabase.from('brokers').update({ presence_status: 'presente' }).eq('id', 'Mussum');
    const live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue())[0]).toMatchObject({ broker_id: 'Mussum', commission_split: true });
  });
  it('espera de chegada tem prioridade sobre a espera geral mais antiga', async () => {
    await supabase.from('brokers').insert(person('He-Man', { agency: 'Casa Nobre' }));
    await seedWaiting('arrival', null);
    await supabase.from('visits').insert(customer({ id: 'older-visit', referred_broker_id: null, visit_reason: 'Primeira visita' }));
    const { visit: _, ...older } = waiting({ id: 'older-q', visit_id: 'older-visit', created_at: '2040-01-23T11:00:00Z' });
    await supabase.from('queue_entries').insert(older);
    const live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue()).find(e => e.id === 'queue')).toMatchObject({ broker_id: 'He-Man', queue_status: 'chamando' });
    expect((await currentQueue()).find(e => e.id === 'older-q')).toMatchObject({ broker_id: null, queue_status: 'aguardando' });
  });
  it('espera nominal não bloqueia outro cliente e não desvia do dono', async () => {
    await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente' }), person('He-Man', { agency: 'Casa Nobre' })]);
    await seedWaiting('nominal');
    const extraVisit = customer({ id: 'new-visit', referred_broker_id: null, visit_reason: 'Primeira visita' });
    await supabase.from('visits').insert(extraVisit);
    const { visit: _, ...extra } = waiting({ id: 'new-q', visit_id: extraVisit.id, created_at: '2040-01-23T11:31:00Z' });
    await supabase.from('queue_entries').insert(extra);
    let live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue()).find(e => e.id === 'queue')?.broker_id).toBeNull();
    expect((await currentQueue()).find(e => e.id === 'new-q')?.broker_id).toBe('He-Man');
    await supabase.from('brokers').update({ presence_status: 'presente' }).eq('id', 'Didi');
    live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue()).find(e => e.id === 'queue')).toMatchObject({ broker_id: 'Didi', commission_split: false });
  });
  it.each([1, 2])('recusa do %iº na interface preserva toda a fila direta e chama o próximo da inversa com Auditoria', async position => {
    await seedCall(position); const before = (await fetchAll()).brokers.map(b => [b.id, b.sorteio_order]);
    await renderReception(); await click('Recusar (Ir para o Fim da Fila Inversa)');
    const live = await fetchAll();
    expect(live.brokers.map(b => [b.id, b.sorteio_order])).toEqual(before);
    expect(live.brokers.find(b => b.id === 'Didi')).toMatchObject({ inverse_order: 4, attendance_status: 'livre' });
    expect(live.queue[0]).toMatchObject({ broker_id: 'He-Man', queue_status: 'chamando' });
    expect(container.textContent).toContain(`Didi: recusou a Fila Inversa; ${position}ª posição direta preservada`);
  });
  it('3º da empresa não vê o botão e a orquestração também rejeita a recusa', async () => {
    await seedCall(3); await renderReception();
    expect(container.textContent).not.toContain('Recusar (Ir para o Fim da Fila Inversa)');
    await expect(refuseInverseCall('queue', clock, at)).rejects.toThrow('1º ou 2º');
    expect((await currentQueue())[0].broker_id).toBe('Didi');
  });
  it.each([true, false])('indicação específica com todos ausentes respeita aguardar=%s', async wait => {
    await supabase.from('brokers').insert(person('Didi', { presence_status: 'ausente' }));
    await renderReception(); await input('[placeholder="Nome completo"]', 'Cliente Indicação');
    await input('input[type="tel"]', '11988887777'); await input('[aria-label="Motivo da visita"]', 'Indicação');
    await input('[placeholder="Digite o nome do corretor…"]', 'Didi');
    const option = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('DidiAusente'))!;
    await settle(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(container.textContent).toContain('Deseja aguardar o corretor original (Didi)?');
    await answer(wait); await click('Cadastrar visita');
    const entry = (await currentQueue())[0];
    expect(entry.visit).toMatchObject({ referred_broker_id: 'Didi', visit_reason: 'Indicação' });
    expect((await readReceptionPolicy(entry.id))?.mode).toBe(wait ? 'nominal' : 'arrival');
  });
  it('recusa atrasada não recusa por engano o próximo corretor já chamado', async () => {
    await seedCall(); const oldCall = (await currentQueue())[0];
    await refuseInverseCall(oldCall.id, clock, at, oldCall);
    await expect(refuseInverseCall(oldCall.id, clock, at, oldCall)).rejects.toThrow('chamada foi alterada');
    expect((await currentQueue())[0].broker_id).toBe('He-Man');
    expect((await readReceptionPolicy(oldCall.id))?.events.filter(e => e.type === 'inverse_refusal')).toHaveLength(1);
  });
  it('recusa sem próximo livre mantém o cliente aguardando e retoma quando outro fica livre', async () => {
    await seedCall(); await supabase.from('brokers').update({ attendance_status: 'em_mesa' }).in('id', ['Mussum', 'He-Man']);
    await refuseInverseCall('queue', clock, at);
    expect((await currentQueue())[0]).toMatchObject({ queue_status: 'aguardando', broker_id: null });
    await supabase.from('brokers').update({ attendance_status: 'livre' }).eq('id', 'Mussum');
    const live = await fetchAll(); await dispatchOperationalWaiting(live.queue, live.brokers, clock, at);
    expect((await currentQueue())[0]).toMatchObject({ queue_status: 'chamando', broker_id: 'Mussum' });
  });
  it('aplicação completa chama a espera de chegada ao registrar presença pelo módulo Corretor', async () => {
    await supabase.from('brokers').insert(person('He-Man', { agency: 'Casa Nobre', presence_status: 'ausente', arrived_at: null, sorteio_order: null, inverse_order: null }));
    await settle(() => root.render(<App />)); await click('TESTE');
    await input('[placeholder="Nome completo"]', 'Cliente Prioritário'); await input('input[type="tel"]', '11988887777');
    await answer(true); await click('Cadastrar visita');
    await click('Corretor / Gerente'); await click('Registrar presença');
    await settle(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect((await currentQueue())[0]).toMatchObject({ broker_id: 'He-Man', queue_status: 'chamando', commission_split: false });
  });
});
