import { describe, expect, it } from 'vitest';
import { canRefuseInverse, freeDirectPosition } from '@/lib/reception/operationalChoices';
import { newReceptionPolicy } from '@/lib/reception/operationalStore';
import { availabilityKey, returnDecision } from '@/lib/reception/returnDecision';
import { commissionLabel } from '@/lib/reception/commissionLabels';
import { person, customer, waiting, receptionClock as clock } from './receptionFixtures';

const owner = person('Didi', { presence_status: 'ausente' });
const other = person('He-Man', { agency: 'Casa Nobre' });
const entry = waiting();
const policy = newReceptionPolicy(entry.id, owner.id, 'nominal');
describe('decisão de retorno e posições livres', () => {
  it.each(['em_atendimento', 'em_mesa', 'decorado'] as const)('ignora predecessores %s e reconhece o 3º como 1º livre', status => {
    const brokers = [person('1', { sorteio_order: 1, attendance_status: status }), person('2', { sorteio_order: 2, presence_status: 'pausa' }),
      person('3', { sorteio_order: 3, attendance_status: 'em_mesa' })];
    const call = waiting({ broker_id: '3', queue_status: 'chamando', queue_type: 'decorado', visit: customer({ phone: null, referred_broker_id: null }) });
    expect(freeDirectPosition(call, brokers)).toBe(1);
    expect(canRefuseInverse(call, brokers)).toBe(true);
  });
  it('habilita o 2º livre mesmo sendo o 4º da fila direta cadastrada', () => {
    const brokers = [person('1', { sorteio_order: 1, attendance_status: 'em_atendimento' }), person('2', { sorteio_order: 2, presence_status: 'pausa' }),
      person('3', { sorteio_order: 3 }), person('4', { sorteio_order: 4, attendance_status: 'em_mesa' })];
    const call = waiting({ broker_id: '4', queue_status: 'chamando', queue_type: 'decorado', visit: customer({ referred_broker_id: null }) });
    expect(freeDirectPosition(call, brokers)).toBe(2); expect(canRefuseInverse(call, brokers)).toBe(true);
  });
  it('não confunde o 3º livre com o 3º da lista cadastrada e não permite recusar após iniciar', () => {
    const brokers = [1, 2, 3].map(n => person(String(n), { sorteio_order: n }));
    const call = waiting({ broker_id: '3', queue_status: 'chamando', queue_type: 'decorado', visit: customer({ referred_broker_id: null }) });
    expect(freeDirectPosition(call, brokers)).toBe(3);
    expect(canRefuseInverse(call, brokers)).toBe(false);
    expect(canRefuseInverse({ ...call, queue_status: 'em_atendimento' }, brokers.slice(2))).toBe(false);
  });
  it('exclui chamada concorrente mesmo com status livre desatualizado no cadastro', () => {
    const brokers = [person('1'), person('2', { sorteio_order: 2, attendance_status: 'em_mesa' })];
    const call = waiting({ broker_id: '2', queue_status: 'chamando', queue_type: 'decorado', visit: customer({ referred_broker_id: null }) });
    const concurrent = waiting({ id: 'other', broker_id: '1', queue_status: 'chamando' });
    expect(freeDirectPosition(call, brokers, [call, concurrent])).toBe(1);
    expect(freeDirectPosition(call, brokers, [call, { ...concurrent, broker_id: '2' }])).toBe(0);
  });
  it.each(['nominal', 'arrival', 'coverage'] as const)('original disponível tem prioridade no modo %s, sem Fifty', mode => {
    const result = returnDecision(entry, [{ ...owner, presence_status: 'presente' }, other], [entry], clock, { ...policy, mode });
    expect(result).toMatchObject({ kind: 'original', choice: { broker: { id: owner.id }, split: false } });
  });
  it.each([
    ['equipe', person('Mussum'), 'Mussum'],
    ['empresa', person('Dedé', { equipe: 'Outra' }), 'Dedé'],
    ['outra empresa', other, 'He-Man'],
  ] as const)('substituto de %s produz proposta com Fifty, nunca decisão de original', (_, broker, expected) => {
    expect(returnDecision(entry, [owner, broker], [entry], clock, policy)).toMatchObject({ kind: 'offer', choice: { broker: { id: expected }, split: true } });
  });
  it('oferta persiste no corretor mostrado, mesmo após chegar outro com maior prioridade', () => {
    const offer = { id: 'offer', brokerId: other.id, availability: availabilityKey(other, [entry]), at: entry.created_at };
    expect(returnDecision(entry, [owner, person('Mussum'), other], [entry], clock, { ...policy, returnConfirmation: { offer } }))
      .toMatchObject({ kind: 'offer', choice: { broker: { id: other.id } } });
  });
  it('não repete a oferta recusada no mesmo intervalo livre e reconhece nova liberação com relógio parado', () => {
    const declined = { [other.id]: availabilityKey(other, [entry]) };
    expect(returnDecision(entry, [owner, other], [entry], clock, { ...policy, returnConfirmation: { declined } }).kind).toBe('wait');
    const attended = waiting({ id: 'new-call', broker_id: other.id, queue_status: 'concluido' });
    expect(returnDecision(entry, [owner, other], [entry, attended], clock, { ...policy, returnConfirmation: { declined } }).kind).toBe('offer');
  });
  it.each(['ausente', 'pausa'] as const)('não oferece corretor %s', presence_status => {
    expect(returnDecision(entry, [owner, { ...other, presence_status }], [entry], clock, policy).kind).toBe('wait');
  });
  it('traduz o rótulo histórico na apresentação, sem modificar o contrato técnico', () => {
    expect(commissionLabel('Último da Equipe (Split)')).toBe('Último da Equipe (Fifty)');
    expect(commissionLabel('100% da comissão')).toBe('100% da comissão');
  });
});
