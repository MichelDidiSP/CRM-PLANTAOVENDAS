import { describe, it, expect } from 'vitest';
import type { Broker, QueueEntry, VisitReason } from '../supabase';
import { firstFree, reverseCoverage, meritCandidates, completionPatch } from './coreDistribution';
const broker = (id: string, rank: number, extra: Partial<Broker> = {}): Broker => ({
  id, sorteio_order: rank, inverse_order: 10 - rank, agency: 'Viva Imóveis', equipe: 'A',
  presence_status: 'presente', attendance_status: 'livre', is_external_partner: false,
  ...extra,
} as Broker);
const visit = (reason: VisitReason, extra: Partial<QueueEntry> = {}): QueueEntry => ({
  broker_id: 'a', queue_type: 'geral', queue_status: 'em_atendimento',
  visit: { visit_reason: reason }, ...extra,
} as QueueEntry);
const time = '2026-11-13T12:00:00.123Z';
describe('Normative distribution', () => {
  it('takes the free top without skipping innocent brokers', () => {
    const line = [broker('a', 1), broker('b', 2), broker('c', 3)];
    expect(firstFree(line, new Set(['b', 'c']))?.id).toBe('b');
    expect(firstFree(line, new Set(['a', 'c']))?.id).toBe('a');
  });
  it('orders first-visit completion by click time even with stale snapshots', () => {
    const early = completionPatch(broker('a', 1), visit('Primeira visita'), time);
    const late = completionPatch(broker('b', 2), visit('Primeira visita'), '2026-11-13T12:00:00.124Z');
    expect(early.sorteio_order).toBeGreaterThan(2);
    expect(late.sorteio_order).toBeGreaterThan(early.sorteio_order!);
    expect(early.inverse_order).toBeUndefined();
  });
  it('moves Decorado only to the inverse tail', () => {
    const patch = completionPatch(broker('a', 1), visit('Visita ao Decorado', { queue_type: 'decorado' }), time);
    expect(patch.sorteio_order).toBeUndefined();
    expect(patch.inverse_order).toBe(new Date(time).getTime());
  });
  it.each(['Retorno', 'Indicação', 'Indicação Presente', 'Indicação Ausente', 'Indicação Imobiliária'] as VisitReason[])('protects %s and restores earned priority', reason => {
    expect(completionPatch(broker('a', 2), visit(reason), time).sorteio_order).toBeUndefined();
    const patch = completionPatch(broker('a', 2, { merit_priority_return: true }), visit(reason), time);
    expect(patch.sorteio_order).toBeLessThan(0);
    expect(patch.merit_priority_return).toBe(false);
  });
  it('awards merit only when a protected occupied broker is passed', () => {
    const line = [broker('a', 1, { attendance_status: 'em_atendimento' }), broker('b', 2), broker('c', 3)];
    expect(meritCandidates(line, line[1], [visit('Retorno')]).map(b => b.id)).toEqual(['a']);
    expect(meritCandidates(line, line[1], [visit('Primeira visita')])).toEqual([]);
    expect(meritCandidates(line, line[1], [visit('Retorno', { broker_id: 'c' })])).toEqual([]);
  });
  it('scans same team backwards then same company, excluding unavailable brokers', () => {
    const owner = broker('a', 1, { presence_status: 'ausente' });
    const line = [owner, broker('b', 2), broker('c', 3), broker('d', 4, { equipe: 'B' }), broker('e', 5, { agency: 'Casa Nobre' })];
    expect(reverseCoverage(line, owner, new Set())?.id).toBe('c');
    expect(reverseCoverage(line, owner, new Set(['b', 'c']))?.id).toBe('d');
    expect(reverseCoverage(line, owner, new Set(['b', 'c', 'd']))).toBeUndefined();
    expect(reverseCoverage([owner, broker('p', 2, { presence_status: 'pausa' }), broker('o', 3, { attendance_status: 'em_atendimento' })], owner, new Set())).toBeUndefined();
  });
});
