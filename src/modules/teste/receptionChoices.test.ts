import { describe, it, expect } from 'vitest';
import { absenceDecision, allBrokersAbsent, canRefuseInverse, directPosition, operationalDispatch } from '@/lib/reception/operationalChoices';
import { newReceptionPolicy } from '@/lib/reception/operationalStore';
import { customer, person, waiting, receptionClock as clock, receptionAt as at } from './receptionFixtures';

const owner = person('Didi', { presence_status: 'ausente' });
const team = person('Mussum', { sorteio_order: 2, inverse_order: 2 });
const company = person('Dedé', { equipe: 'B', sorteio_order: 4, inverse_order: 3 });
const other = person('He-Man', { agency: 'Casa Nobre', sorteio_order: 9, inverse_order: 4 });
const roster = [owner, team, company, other];
function resolve(mode: 'arrival' | 'nominal' | 'coverage', people = roster, ownerId: string | null = owner.id, busy = new Set<string>()) {
  return operationalDispatch(waiting(), people, clock, busy, newReceptionPolicy('queue', ownerId, mode, at), () => other);
}
describe('decisões de recepção separadas dos motores congelados', () => {
  it.each([[null, true, 'arrival'], [null, false, 'direct'], ['Didi', true, 'nominal'], ['Didi', false, 'arrival']] as const)
    ('decisão original=%s aguardar=%s → %s', (id, wait, expected) => expect(absenceDecision(id, wait)).toBe(expected));
  it('pausa ou corretor ocupado não equivale a todos ausentes', () => {
    expect(allBrokersAbsent([owner])).toBe(true);
    expect(allBrokersAbsent([owner, person('Pausa', { presence_status: 'pausa' })])).toBe(false);
    expect(allBrokersAbsent([owner, person('Ocupado', { attendance_status: 'em_mesa' })])).toBe(false);
  });
  it('espera nominal ignora outro corretor livre até o original chegar', () => {
    expect(resolve('nominal').broker).toBeUndefined();
    expect(resolve('nominal', [{ ...owner, presence_status: 'presente' }, other])).toMatchObject({ broker: { id: 'Didi' }, split: false });
  });
  it('espera prioritária escolhe a primeira chegada, independente de empresa e ordem do sorteio', () => {
    const first = { ...other, arrived_at: '2040-01-23T11:00:00.000Z' };
    expect(resolve('arrival', [owner, team, first], null)).toMatchObject({ broker: first, split: false });
    expect(resolve('arrival', [owner, team, first])).toMatchObject({ broker: first, split: true });
  });
  it.each([
    ['equipe', roster, 'Mussum', 'Último da Equipe (Split)'],
    ['empresa', [owner, { ...team, presence_status: 'pausa' }, company, other], 'Dedé', 'Último da Empresa (Split)'],
    ['outra empresa', [owner, { ...team, attendance_status: 'em_mesa' }, { ...company, presence_status: 'ausente' }, other], 'He-Man', 'Transbordo Interempresas (Split)'],
  ] as const)('mudança de opinião percorre %s sem aceitar atalho do motor', (_, people, id, rule) => {
    expect(resolve('coverage', [...people])).toMatchObject({ broker: { id }, split: true, rule });
  });
  it('seleciona o último livre da equipe e depois o último da outra empresa', () => {
    expect(resolve('coverage', [owner, team, person('Zacarias', { sorteio_order: 8 }), company, other]).broker?.id).toBe('Zacarias');
    expect(resolve('coverage', [owner, { ...other, sorteio_order: 2 }, person('Esqueleto', { agency: 'Casa Nobre', sorteio_order: 3 })]).broker?.id).toBe('Esqueleto');
  });
  it('ignora ausente, pausa, ocupado, parceiro e broker já chamado', () => {
    const people = [owner, { ...team, presence_status: 'pausa' as const }, { ...company, attendance_status: 'em_atendimento' as const },
      person('Parceiro', { is_external_partner: true }), other];
    expect(resolve('coverage', people, owner.id, new Set([other.id])).broker).toBeUndefined();
  });
  it('atende o original presente sem Split no retorno normal', () => {
    expect(operationalDispatch(waiting(), [{ ...owner, presence_status: 'presente' }, team], clock, new Set(), undefined, () => team))
      .toMatchObject({ broker: { id: owner.id }, split: false });
  });
  it.each([1, 2, 3, 4])('recusa considera posição %i na empresa, não a posição global', position => {
    const people = [person('A', { sorteio_order: 10 }), person('B', { sorteio_order: 20 }), person('C', { sorteio_order: 40 }), person('D', { sorteio_order: 80 }), other];
    const broker = people[position - 1];
    const entry = waiting({ queue_type: 'decorado', queue_status: 'chamando', broker_id: broker.id,
      visit: customer({ visit_reason: 'Visita ao Decorado', referred_broker_id: null }) });
    expect(directPosition(broker, people)).toBe(position);
    expect(canRefuseInverse(entry, people)).toBe(position <= 2);
  });
  it('não permite recusa de retorno, de atendimento iniciado ou de espera prioritária', () => {
    const call = waiting({ queue_type: 'decorado', queue_status: 'chamando', broker_id: team.id });
    expect(canRefuseInverse(call, roster)).toBe(false);
    const noOwner = { ...call, visit: customer({ referred_broker_id: null, visit_reason: 'Visita ao Decorado' }) };
    expect(canRefuseInverse({ ...noOwner, queue_status: 'em_atendimento' }, roster)).toBe(false);
    expect(canRefuseInverse({ ...noOwner, reception_policy: newReceptionPolicy(call.id, null, 'arrival') }, roster)).toBe(false);
  });
});
