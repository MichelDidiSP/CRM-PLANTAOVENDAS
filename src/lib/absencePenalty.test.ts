import { describe, it, expect } from 'vitest';
import type { Broker } from '@/lib/supabase';
import { isAbsencePenaltyDue, isRotationExcluded, lastBrokerFromAgency, nextBrokerFromAgency, resolveIndicacaoBroker } from '@/lib/queueEngine';

function makeBroker(id: string, overrides: Partial<Broker> = {}): Broker {
  return {
    id,
    operational_name: id,
    agency: 'Viva Imóveis',
    equipe: 'Equipe Teste',
    presence_status: 'presente',
    attendance_status: 'livre',
    arrived_at: '2026-09-20T08:10:00.000Z',
    last_status_update: '2026-09-20T08:10:00.000Z',
    is_external_partner: false,
    external_company: null,
    sorteio_order: 1,
    inverse_order: 1,
    shift: 'manha',
    afternoon_reserved: false,
    absence_started_at: null,
    only_own_referrals: false,
    created_at: '2026-09-20T08:00:00.000Z',
    ...overrides,
  };
}

const START = '2026-09-20T10:00:00.000Z';
const minutesAfter = (min: number) => new Date(new Date(START).getTime() + min * 60_000);

describe('isAbsencePenaltyDue', () => {
  const away = makeBroker('a', { presence_status: 'ausente', absence_started_at: START });

  it('is not due at exactly 120 minutes', () => {
    expect(isAbsencePenaltyDue(away, minutesAfter(120))).toBe(false);
  });

  it('is due after 120 minutes', () => {
    expect(isAbsencePenaltyDue(away, minutesAfter(120.02))).toBe(true);
  });

  it('applies to pausa as well as ausente', () => {
    const paused = { ...away, presence_status: 'pausa' as const };
    expect(isAbsencePenaltyDue(paused, minutesAfter(121))).toBe(true);
  });

  it('is never due for a present broker or one without a departure time', () => {
    expect(isAbsencePenaltyDue(makeBroker('p', { absence_started_at: START }), minutesAfter(300))).toBe(false);
    expect(isAbsencePenaltyDue({ ...away, absence_started_at: null }, minutesAfter(300))).toBe(false);
  });

  it('is not due again once already flagged', () => {
    expect(isAbsencePenaltyDue({ ...away, only_own_referrals: true }, minutesAfter(300))).toBe(false);
  });
});

describe('own-referrals-only exclusion', () => {
  it('excludes flagged brokers from rotation', () => {
    expect(isRotationExcluded(makeBroker('f', { only_own_referrals: true }))).toBe(true);
    expect(isRotationExcluded(makeBroker('n'))).toBe(false);
  });

  it('skips flagged brokers in round-robin and back-of-queue selection', () => {
    const brokers = [
      makeBroker('f1', { sorteio_order: 1, only_own_referrals: true }),
      makeBroker('ok', { sorteio_order: 2 }),
    ];
    expect(nextBrokerFromAgency(brokers, 'Viva Imóveis', new Set())?.id).toBe('ok');
    expect(lastBrokerFromAgency(brokers, 'Viva Imóveis', new Set())?.id).toBe('ok');
  });

  it('still routes a client to the flagged broker when it is their own referral', () => {
    const brokers = [
      makeBroker('f1', { sorteio_order: null, inverse_order: null, only_own_referrals: true }),
      makeBroker('ok', { sorteio_order: 2 }),
    ];
    expect(resolveIndicacaoBroker(brokers, 'f1', new Set()).broker?.id).toBe('f1');
  });

  it('does not route another broker referral to a flagged broker', () => {
    const brokers = [
      makeBroker('ref', { presence_status: 'ausente', sorteio_order: 3 }),
      makeBroker('f1', { sorteio_order: null, only_own_referrals: true }),
    ];
    expect(resolveIndicacaoBroker(brokers, 'ref', new Set()).broker).toBeUndefined();
  });
});
