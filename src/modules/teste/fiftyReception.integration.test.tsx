// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import RecepcaoPanel from '@/components/RecepcaoPanel';
import FilaPanel from '@/components/FilaPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import ReceptionAuditPanel from '@/components/ReceptionAuditPanel';
import { SimProvider } from '@/lib/simContext';
import { installPlantaoClock, publishClock } from '@/lib/plantaoClock';
import { supabase, dbReady, type Broker } from '@/lib/supabase';
import { fetchAll } from '@/lib/queueEngine';
import { attachReceptionPolicies, createReceptionPolicy, newReceptionPolicy, readReceptionPolicy, refuseInverseCall } from '@/lib/reception/operationalStore';
import { answerReturnOffer, dispatchWaitingWithDecisions } from '@/lib/reception/returnDecisionStore';
import { person, customer, waiting, receptionAt as at, receptionDay as day, receptionClock as clock } from './receptionFixtures';

let root: Root; let container: HTMLDivElement; let uninstall: (() => void) | undefined;
async function settle(work: () => unknown) {
  await act(async () => { await work(); for (let i = 0; i < 300; i++) await Promise.resolve(); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  expect(button, label).toBeDefined(); await settle(() => button!.click());
}
async function input(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(selector)!;
  expect(el, selector).not.toBeNull();
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function queueEntry(id = 'queue') { return (await fetchAll()).queue.find(e => e.id === id)!; }
async function monitor() {
  const live = await fetchAll(); await dispatchWaitingWithDecisions(live.queue, live.brokers, clock, at);
}
async function seedReturn(mode?: 'nominal' | 'arrival' | 'coverage') {
  await supabase.from('visits').insert(customer({ is_test: true }));
  const { visit: _, ...entry } = waiting(); await supabase.from('queue_entries').insert(entry);
  if (mode) await createReceptionPolicy(newReceptionPolicy(entry.id, 'Didi', mode, at), day, at);
}
async function roster(alternative: 'equipe' | 'empresa' | 'outra' = 'equipe', ownerStatus: Partial<Broker> = { presence_status: 'ausente' }) {
  await supabase.from('brokers').insert([person('Didi', ownerStatus), person('Disponível', {
    agency: alternative === 'outra' ? 'Casa Nobre' : 'Viva Imóveis', equipe: alternative === 'equipe' ? 'A' : 'B', sorteio_order: 3,
  })]);
}
function Harness({ view = 'recepcao' }: { view?: 'recepcao' | 'fila' }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchAll>>>();
  async function load() {
    await monitor();
    const live = await fetchAll();
    const sessions = await supabase.from('plantao_sessions').select('*').eq('plantao_date', day);
    setData({ ...live, queue: attachReceptionPolicies(live.queue, sessions.data ?? []) });
  }
  useEffect(() => { void load(); }, []);
  return <SimProvider>{data && <>{view === 'recepcao' ? <RecepcaoPanel {...data} onChanged={load} /> :
    <FilaPanel brokers={data.brokers} queue={data.queue} allQueue={data.queue} onChanged={load} />}<ReceptionAuditPanel {...data} /></>}</SimProvider>;
}
async function render(view: 'recepcao' | 'fila' = 'recepcao') {
  uninstall ??= installPlantaoClock({ now: () => Date.parse(at) });
  await settle(() => root.render(<Harness view={view} />));
}
async function remount() { await settle(() => root.render(<div />)); await render(); }

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock(); await dbReady;
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions', 'plantao_daily_closures', 'incorporadora_direct_leads',
    'pause_audit', 'external_partner_intakes', 'external_partner_reservations', 'partner_reception_details']) await supabase.from(table).delete().neq('id', '');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await settle(() => root.unmount()); uninstall?.(); uninstall = undefined; container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('homologação: nome automático, livres e decisão Fifty', () => {
  it('telefone preenche nome completo e original, habilitando envio sem digitar o nome', async () => {
    await supabase.from('brokers').insert(person('Didi'));
    await supabase.from('visits').insert(customer({ id: 'history', is_test: true, status: 'encerrado' }));
    await render(); await input('input[type="tel"]', '11987654321');
    expect(container.querySelector<HTMLInputElement>('[placeholder="Nome completo"]')!.value).toBe('Maria Cliente Completo');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Motivo da visita"]')!.value).toBe('Retorno');
    expect(container.textContent).toContain('Corretor original: Didi');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false); await click('Cadastrar visita');
    const entry = (await fetchAll()).queue[0];
    expect(entry).toMatchObject({ broker_id: 'Didi', commission_split: false, queue_status: 'chamando', visit: { customer_name: 'Maria Cliente Completo', visit_reason: 'Retorno' } });
    expect(container.textContent).not.toContain('Informe o nome do cliente');
  });
  it('permite complementar nome preenchido e não carrega esse nome para telefone desconhecido', async () => {
    await supabase.from('brokers').insert(person('Didi'));
    await supabase.from('visits').insert(customer({ id: 'history', customer_name: 'Maria', is_test: true }));
    await render(); await input('input[type="tel"]', '11987654321');
    await input('[placeholder="Nome completo"]', 'Maria Nome Complementado'); await click('Cadastrar visita');
    expect((await fetchAll()).queue[0].visit?.customer_name).toBe('Maria Nome Complementado');
    await input('input[type="tel"]', '11987654321'); await input('input[type="tel"]', '11988887777');
    expect(container.querySelector<HTMLInputElement>('[placeholder="Nome completo"]')!.value).toBe('');
  });
  it.each(['equipe', 'empresa', 'outra'] as const)('propõe Fifty para substituto da %s e só despacha ao aceitar', async level => {
    await roster(level); await seedReturn('nominal'); await render();
    expect(await queueEntry()).toMatchObject({ queue_status: 'aguardando', broker_id: null });
    expect(container.textContent).toContain('Corretor Disponível ficou disponível. O cliente Maria deseja ser atendido agora (com Fifty)');
    expect(container.textContent).toContain('corretor original (Didi)');
    expect((await fetchAll()).brokers.find(b => b.id === 'Disponível')?.attendance_status).toBe('livre');
    await click('Atender Agora (Com Fifty)');
    expect(await queueEntry()).toMatchObject({ broker_id: 'Disponível', queue_status: 'chamando', commission_split: true });
    expect(container.textContent).toContain('Fifty'); expect(container.textContent).not.toMatch(/\bSplit\b/);
  });
  it.each(['arrival', 'coverage'] as const)('não usa a autorização genérica anterior do modo %s para saltar a nova decisão', async mode => {
    await roster(); await seedReturn(mode); await monitor(); await monitor();
    expect(await queueEntry()).toMatchObject({ broker_id: null, queue_status: 'aguardando' });
    expect((await readReceptionPolicy('queue'))?.returnConfirmation?.offer?.brokerId).toBe('Disponível');
  });
  it('continuar aguardando libera a fila normal imediatamente e não repete a mesma proposta', async () => {
    await roster(); await seedReturn('nominal'); await render();
    // A normal waiting client arrives while the return decision is on screen.
    await supabase.from('visits').insert(customer({ id: 'normal-v', visit_reason: 'Primeira visita', referred_broker_id: null }));
    const { visit: _, ...normal } = waiting({ id: 'normal-q', visit_id: 'normal-v' });
    await supabase.from('queue_entries').insert(normal);
    await click('Continuar Aguardando Original');
    expect(await queueEntry()).toMatchObject({ queue_status: 'aguardando', broker_id: null });
    expect((await readReceptionPolicy('queue'))?.mode).toBe('nominal');
    expect(await queueEntry('normal-q')).toMatchObject({ broker_id: 'Disponível', queue_status: 'chamando' });
    expect(container.textContent).not.toContain('Atender Agora (Com Fifty)');
  });
  it('decisão e recusa da proposta sobrevivem a remontagem, sem reservar o corretor', async () => {
    await roster(); await seedReturn('nominal'); await render();
    const id = (await readReceptionPolicy('queue'))!.returnConfirmation!.offer!.id;
    await remount();
    expect((await readReceptionPolicy('queue'))!.returnConfirmation!.offer!.id).toBe(id);
    await click('Continuar Aguardando Original'); await remount();
    expect(container.textContent).not.toContain('Atender Agora (Com Fifty)');
    expect((await fetchAll()).brokers.find(b => b.id === 'Disponível')?.attendance_status).toBe('livre');
  });
  it('faz nova proposta após outro atendimento terminar, mesmo sem avançar o relógio TESTE', async () => {
    await roster(); await seedReturn('nominal'); await render(); await click('Continuar Aguardando Original');
    const { visit: _, ...served } = waiting({ id: 'finished', broker_id: 'Disponível', queue_status: 'concluido' });
    await supabase.from('queue_entries').insert(served); await remount();
    expect(container.textContent).toContain('Atender Agora (Com Fifty)');
    expect(await queueEntry()).toMatchObject({ broker_id: null, queue_status: 'aguardando' });
  });
  it.each(['nominal', 'arrival', 'coverage'] as const)('a chegada do original no modo %s encerra a espera diretamente com 100%%', async mode => {
    await roster(); await seedReturn(mode); await monitor();
    await supabase.from('brokers').update({ presence_status: 'presente' }).eq('id', 'Didi'); await render();
    expect(await queueEntry()).toMatchObject({ broker_id: 'Didi', queue_status: 'chamando', commission_split: false });
    expect(container.textContent).not.toContain('Atender Agora (Com Fifty)');
  });
  it('original ocupado que fica livre também é chamado diretamente, mesmo com substituto disponível', async () => {
    await roster('equipe', { attendance_status: 'em_atendimento' }); await seedReturn(); await monitor();
    expect(await queueEntry()).toMatchObject({ broker_id: null });
    await supabase.from('brokers').update({ attendance_status: 'livre' }).eq('id', 'Didi'); await monitor();
    expect(await queueEntry()).toMatchObject({ broker_id: 'Didi', commission_split: false });
  });
  it('confirmação antiga não atribui a um corretor ocupado nem troca silenciosamente o indicado', async () => {
    await roster(); await seedReturn('nominal'); await monitor();
    const offer = (await readReceptionPolicy('queue'))!.returnConfirmation!.offer!;
    await supabase.from('brokers').update({ presence_status: 'pausa' }).eq('id', 'Disponível');
    await supabase.from('brokers').insert(person('Outro disponível'));
    await expect(answerReturnOffer('queue', offer.id, true, clock, at)).rejects.toThrow('deixou de estar disponível');
    expect(await queueEntry()).toMatchObject({ queue_status: 'aguardando', broker_id: null });
    await monitor(); expect((await readReceptionPolicy('queue'))!.returnConfirmation!.offer!.brokerId).toBe('Outro disponível');
  });
  it('não aceita duas vezes a mesma proposta nem cria duas chamadas', async () => {
    await roster(); await seedReturn('nominal'); await monitor();
    const offer = (await readReceptionPolicy('queue'))!.returnConfirmation!.offer!;
    const results = await Promise.all([answerReturnOffer('queue', offer.id, true, clock, at), answerReturnOffer('queue', offer.id, true, clock, at)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await fetchAll()).queue.filter(e => e.queue_status === 'chamando')).toHaveLength(1);
    expect((await readReceptionPolicy('queue'))!.events.filter(e => e.type === 'return_accepted')).toHaveLength(1);
  });
  it('oferta aceita continua vinculada ao corretor mostrado após outro de maior prioridade chegar', async () => {
    await roster('outra'); await seedReturn('nominal'); await monitor();
    const offer = (await readReceptionPolicy('queue'))!.returnConfirmation!.offer!;
    await supabase.from('brokers').insert(person('Equipe recém-chegada', { sorteio_order: 8 }));
    await answerReturnOffer('queue', offer.id, true, clock, at);
    expect(await queueEntry()).toMatchObject({ broker_id: 'Disponível', commission_split: true });
  });
  it.each(['Visita ao Decorado', 'Sem telefone'])('habilita recusa para o 3º cadastrado que é o 1º livre: %s', reason => {
    return (async () => {
      const brokers = [person('Ocupado 1', { sorteio_order: 1, attendance_status: 'em_atendimento' }),
        person('Ocupado 2', { sorteio_order: 2, attendance_status: 'em_atendimento' }),
        person('Candidato 3', { sorteio_order: 3, inverse_order: 1, attendance_status: 'em_mesa' }),
        person('Pausa 4', { sorteio_order: 4, presence_status: 'pausa' }),
        person('Próximo', { agency: 'Casa Nobre', inverse_order: 2 })];
      await supabase.from('brokers').insert(brokers);
      await supabase.from('visits').insert(customer({ visit_reason: 'Visita ao Decorado', phone: reason === 'Sem telefone' ? null : '11987654321', referred_broker_id: null }));
      const { visit: _, ...call } = waiting({ broker_id: 'Candidato 3', queue_type: 'decorado', queue_status: 'chamando', called_at: at });
      await supabase.from('queue_entries').insert(call); await render();
      await click('Recusar (Ir para o Fim da Fila Inversa)');
      const live = await fetchAll();
      expect(live.brokers.map(b => [b.id, b.sorteio_order])).toEqual(brokers.map(b => [b.id, b.sorteio_order]));
      expect(await queueEntry()).toMatchObject({ broker_id: 'Próximo', queue_status: 'chamando' });
      expect((await readReceptionPolicy('queue'))!.events[0]).toMatchObject({ type: 'inverse_refusal', position: 3, freePosition: 1 });
      expect(container.textContent).toContain('3ª posição direta preservada');
    })();
  });
  it('revalida os livres no clique e nega recusa se o candidato passou a ser o 3º livre', async () => {
    await supabase.from('brokers').insert([person('1', { sorteio_order: 1, attendance_status: 'em_atendimento' }),
      person('2', { sorteio_order: 2, attendance_status: 'em_atendimento' }), person('3', { sorteio_order: 3, attendance_status: 'em_mesa' })]);
    await supabase.from('visits').insert(customer({ referred_broker_id: null, visit_reason: 'Visita ao Decorado' }));
    const { visit: _, ...call } = waiting({ broker_id: '3', queue_type: 'decorado', queue_status: 'chamando', called_at: at });
    await supabase.from('queue_entries').insert(call); await render();
    expect(container.textContent).toContain('Recusar (Ir para o Fim da Fila Inversa)');
    await supabase.from('brokers').update({ attendance_status: 'livre' }).in('id', ['1', '2']);
    await expect(refuseInverseCall('queue', clock, at, call)).rejects.toThrow('1º ou 2º livre');
    expect(await queueEntry()).toMatchObject({ broker_id: '3', queue_status: 'chamando' });
  });
  it('a Fila de Espera mostra os mesmos dois botões e respeita a confirmação', async () => {
    await roster(); await seedReturn('nominal'); await render('fila');
    expect(container.textContent).toContain('Continuar Aguardando Original');
    await click('Atender Agora (Com Fifty)'); expect(await queueEntry()).toMatchObject({ broker_id: 'Disponível', commission_split: true });
    expect(container.textContent).not.toMatch(/\bSplit\b/);
  });
  it('reconvocação da TV também pede decisão antes de chamar outro corretor', async () => {
    await roster('outra', { attendance_status: 'em_mesa' }); await seedReturn('nominal');
    await supabase.from('queue_entries').update({ queue_status: 'chamando', broker_id: 'Didi', called_at: at, attempts: 1 }).eq('id', 'queue');
    uninstall = installPlantaoClock({ now: () => Date.now(), callDuration: 10 });
    const live = await fetchAll();
    await settle(() => root.render(<SimProvider><ChamadasPanel queue={live.queue} brokers={live.brokers} /></SimProvider>));
    await settle(async () => { await vi.advanceTimersByTimeAsync(12000); publishClock(); });
    await settle(async () => { await vi.advanceTimersByTimeAsync(2000); publishClock(); });
    expect(await queueEntry()).toMatchObject({ queue_status: 'aguardando', broker_id: null });
    expect((await readReceptionPolicy('queue'))?.returnConfirmation?.offer?.brokerId).toBe('Disponível');
    expect((await fetchAll()).brokers.find(b => b.id === 'Disponível')?.attendance_status).toBe('livre');
  });
  it('aplicação completa detecta presença pelo relógio TESTE e oferece Fifty antes de chamar', async () => {
    await roster(); await supabase.from('brokers').update({ presence_status: 'ausente', arrived_at: null }).eq('id', 'Disponível');
    await seedReturn('nominal'); await settle(() => root.render(<App />)); await click('TESTE');
    await supabase.from('brokers').update({ presence_status: 'presente', arrived_at: at }).eq('id', 'Disponível');
    await input('[aria-label="Horário virtual"]', '08:31:00');
    expect(await queueEntry()).toMatchObject({ broker_id: null, queue_status: 'aguardando' });
    expect(container.textContent).toContain('Atender Agora (Com Fifty)');
    await click('Atender Agora (Com Fifty)'); expect(await queueEntry()).toMatchObject({ broker_id: 'Disponível', commission_split: true });
  });
});
