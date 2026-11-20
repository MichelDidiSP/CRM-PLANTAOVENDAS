// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import ReceptionActions from '@/components/ReceptionActions';
import { SimProvider } from '@/lib/simContext';
import { publishClock } from '@/lib/plantaoClock';
import { person, customer, waiting, receptionAt as at } from './receptionFixtures';

let container: HTMLDivElement; let root: Root;
const label = 'Recusar (Ir para o Fim da Fila Reversa)';
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it.each([
  ['Decorado', 'livre'], ['Decorado', 'em_mesa'], ['Sem Telefone', 'livre'], ['Sem Telefone', 'em_mesa'],
] as const)('exibe recusa para o 3º cadastrado/1º livre: %s, reserva %s', async (kind, attendance_status) => {
  const brokers = [person('3', { sorteio_order: 30, attendance_status }),
    person('2', { sorteio_order: 20, attendance_status: 'em_atendimento' }),
    person('1', { sorteio_order: 10, attendance_status: 'em_atendimento' }),
    person('outra empresa', { agency: 'Casa Nobre', sorteio_order: 1 })];
  const call = waiting({ broker_id: '3', queue_type: 'decorado', queue_status: 'chamando',
    visit: customer({ referred_broker_id: null, visit_reason: 'Visita ao Decorado', phone: kind === 'Sem Telefone' ? null : '11987654321' }) });
  const queue = [call];
  const before = JSON.stringify({ brokers, queue });
  localStorage.setItem('plantao_company_pointers', 'preservado');
  localStorage.setItem('plantao_company_rotation_index', '1');
  await act(async () => root.render(<SimProvider><ReceptionActions brokers={brokers} queue={queue} inverseQueueName="Reversa" /></SimProvider>));
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === label);
  expect(button).toBeDefined(); expect(button?.disabled).toBe(false);
  expect(JSON.stringify({ brokers, queue })).toBe(before);
  expect(localStorage.getItem('plantao_company_pointers')).toBe('preservado');
  expect(localStorage.getItem('plantao_company_rotation_index')).toBe('1');
});

it('permite o 2º livre, ignora pausa e oculta a recusa quando passa a ser o 3º livre', async () => {
  const brokers = [person('1', { sorteio_order: 1, presence_status: 'pausa' }), person('2', { sorteio_order: 2 }),
    person('3', { sorteio_order: 3, attendance_status: 'em_mesa' })];
  const call = waiting({ broker_id: '3', queue_type: 'decorado', queue_status: 'chamando',
    visit: customer({ referred_broker_id: null, phone: null }) });
  const render = () => act(async () => root.render(<SimProvider><ReceptionActions brokers={brokers} queue={[call]} inverseQueueName="Reversa" /></SimProvider>));
  await render(); expect(container.textContent).toContain(label);
  brokers[0] = { ...brokers[0], presence_status: 'presente' };
  await render(); expect(container.textContent).not.toContain(label);
});
