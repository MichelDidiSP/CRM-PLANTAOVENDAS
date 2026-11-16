import { describe, expect, it, vi } from 'vitest';
import type { Broker, QueueEntry, Visit } from '../supabase';
import { scheduleAt, SHIFT_TIMES, type ShiftDraw } from '../queue/shiftSchedule';
import { busyReceptionIds, copyQuickPhone, receptionDestination, receptionRoster, resolveReceptionDispatch, visibleDraws } from './fallbackOrchestrator';

const clock = { seconds: 10 * 3600, date: '2040-01-20', singleShift: false };
function broker(id: string, patch: Partial<Broker> = {}): Broker {
  return { id, operational_name: id, agency: 'Viva Imóveis', equipe: 'Equipe A', presence_status: 'presente',
    attendance_status: 'livre', arrived_at: '2040-01-20T08:30:00-03:00',
    last_status_update: '', is_external_partner: false, external_company: null, sorteio_order: 1,
    inverse_order: 1, shift: 'manha', afternoon_reserved: false, returning_from_pause: false, created_at: '', ...patch };
}
const owner = broker('original', { presence_status: 'ausente' });
function referral(reason: 'Retorno' | 'Indicação', reception_waiting = false) {
  return { queue_type: 'geral' as const, reception_waiting,
    visit: { referred_broker_id: owner.id, visit_reason: reason } as Visit };
}
const empty = new Set<string>();

describe('orquestração de recepção', () => {
  it('encaminha cadastro para a incorporadora quando todos estão ausentes ou só há parceiro externo', () => {
    expect(receptionDestination([], empty, null)).toBe('direct');
    expect(receptionDestination(receptionRoster([owner, broker('externo', { is_external_partner: true })], clock), empty, owner.id)).toBe('direct');
  });
  it('aguarda quando todos estão ocupados, em pausa ou com chamada ativa', () => {
    const roster = [broker('pausa', { presence_status: 'pausa' }), broker('mesa', { attendance_status: 'em_mesa' }), broker('tv')];
    const busy = busyReceptionIds([{ broker_id: 'tv', queue_status: 'chamando' } as QueueEntry]);
    expect(receptionDestination(roster, busy, null)).toBe('waiting');
    expect(receptionDestination(roster.slice(0, 1), empty, null)).toBe('waiting');
  });
  it.each(['geral', 'decorado', 'parceria'] as const)('libera a espera geral %s para o primeiro corretor livre', queue_type => {
    const free = broker('liberou');
    const paused = broker('pausa', { presence_status: 'pausa' });
    const entry = { queue_type, reception_waiting: true };
    expect(resolveReceptionDispatch(entry, [paused], clock, empty, () => paused).broker).toBeUndefined();
    expect(resolveReceptionDispatch(entry, [paused, free], clock, empty, () => undefined)).toEqual({ broker: free, split: false });
  });
  it.each(['Indicação', 'Retorno'] as const)('preserva a equipe ou empresa de origem em %s antes do transbordo', reason => {
    const team = broker('equipe', { sorteio_order: 2 });
    const company = broker('empresa', { equipe: 'Outra', sorteio_order: 8 });
    const other = broker('outra empresa', { agency: 'Casa Nobre', sorteio_order: 9 });
    expect(resolveReceptionDispatch(referral(reason), [owner, company, other, team], clock, empty, () => undefined)).toEqual({ broker: team, split: false });
    expect(resolveReceptionDispatch(referral(reason), [owner, company, other], clock, empty, () => company)).toEqual({ broker: company, split: false });
  });
  it.each(['Indicação', 'Retorno'] as const)('seleciona o último livre da outra imobiliária com split em %s', reason => {
    const first = broker('primeiro', { agency: 'Casa Nobre', sorteio_order: 2 });
    const last = broker('último livre', { agency: 'Casa Nobre', sorteio_order: 8 });
    const absent = broker('ausente', { agency: 'Casa Nobre', sorteio_order: 9, presence_status: 'ausente' });
    const paused = broker('pausa', { agency: 'Casa Nobre', sorteio_order: 10, presence_status: 'pausa' });
    const occupied = broker('ocupado', { agency: 'Casa Nobre', sorteio_order: 11, attendance_status: 'em_mesa' });
    expect(resolveReceptionDispatch(referral(reason), [owner, first, last, absent, paused, occupied], clock, empty, () => first)).toEqual({ broker: last, split: true });
    expect(resolveReceptionDispatch(referral(reason), [owner, absent, paused, occupied], clock, empty, () => undefined)).toEqual({ broker: undefined, split: false });
  });
  it('mantém a decisão normal do motor quando não há caso de borda', () => {
    const selected = broker('motor');
    expect(resolveReceptionDispatch({ queue_type: 'decorado' }, [selected], clock, empty, () => selected))
      .toEqual({ broker: selected, split: false });
  });
});

describe('publicidade e painel de testes', () => {
  const draw: ShiftDraw = { viva: ['a'], nobre: ['b'], inverse: ['b', 'a'], firstAgency: 'Viva Imóveis' };
  it('publica a manhã às 08:46:00 sem mudar a janela por chegada', () => {
    expect(visibleDraws(SHIFT_TIMES.morningDraw - 1, false, draw, draw).morning).toBeNull();
    expect(visibleDraws(SHIFT_TIMES.morningDraw, false, draw, draw).morning).toEqual(draw);
    expect(scheduleAt({ ...clock, seconds: 8 * 3600 + 59 * 60 + 59 }).preOpening).toBe(true);
    expect(scheduleAt({ ...clock, seconds: 9 * 3600 }).preOpening).toBe(false);
  });
  it('publica a tarde às 13:46:00 sem trocar a fila de despacho', () => {
    expect(visibleDraws(SHIFT_TIMES.afternoonDraw - 1, false, draw, draw).afternoon).toBeNull();
    expect(visibleDraws(SHIFT_TIMES.afternoonDraw, false, draw, draw).afternoon).toEqual(draw);
    expect(visibleDraws(SHIFT_TIMES.afternoonDraw, true, draw, draw).afternoon).toBeNull();
    expect(scheduleAt({ ...clock, seconds: 13 * 3600 + 59 * 60 + 59 }).shift).toBe('manha');
  });
  it('copia exatamente o telefone fictício', async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    await copyQuickPhone('11912345678', clipboard);
    expect(clipboard).toHaveBeenCalledWith('11912345678');
  });
});
