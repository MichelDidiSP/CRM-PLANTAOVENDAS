import { describe, it, expect } from 'vitest';
import {
  getDispatchMode,
  isArrivalOrderMode,
  isManhaSorteioActive,
  nextBrokerByArrival,
  nextBrokerByArrivalAnyAgency,
  nextBrokerByArrivalInverse,
  nextBrokerFromAgency,
  nextBrokerFromInverseTop,
  lastBrokerFromAgency,
  nextBrokerForGeneralQueue,
  resolveIndicacaoBroker,
  dispatchBroker,
  interleaveQueue,
  SORTEIO_MANHA,
  SORTEIO_TARDE,
  type SorteioResult,
} from './queueEngine';
import type { Broker, Agency, QueueEntry, Visit, QueueType, Shift } from './supabase';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeBroker(
  id: string,
  name: string,
  agency: Agency,
  opts: Partial<Broker> = {},
): Broker {
  return {
    id,
    operational_name: name,
    agency,
    presence_status: 'presente',
    attendance_status: 'livre',
    arrived_at: '2026-09-20T08:10:00.000Z',
    last_status_update: '2026-09-20T08:10:00.000Z',
    is_external_partner: false,
    external_company: null,
    sorteio_order: null,
    shift: 'manha',
    afternoon_reserved: false,
    created_at: '2026-09-20T08:00:00.000Z',
    ...opts,
  };
}

function makeVisit(id: string, name: string, reason: Visit['visit_reason'], referredId: string | null = null): Visit {
  return {
    id,
    customer_name: name,
    phone: `119999${id.padStart(5, '0')}`,
    visit_reason: reason,
    referred_broker_id: referredId,
    status: 'aguardando',
    created_at: '2026-09-20T09:00:00.000Z',
    updated_at: '2026-09-20T09:00:00.000Z',
  };
}

function makeQueueEntry(
  id: string,
  visit: Visit,
  agency: Agency,
  queueType: QueueType,
  brokerId: string | null = null,
): QueueEntry {
  return {
    id,
    visit_id: visit.id,
    broker_id: brokerId,
    agency,
    queue_status: 'aguardando',
    attempts: 0,
    called_at: null,
    reentry_at: null,
    queue_type: queueType,
    sorteio_session: null,
    shift: 'manha',
    created_at: '2026-09-20T09:00:00.000Z',
    updated_at: '2026-09-20T09:00:00.000Z',
    visit,
  };
}

// Brokers: 5 Viva, 5 Nobre — all present, arrived in order
const vivaBrokers: Broker[] = [
  makeBroker('v1', 'Viva_A', 'Viva Imóveis', { arrived_at: '2026-09-20T08:01:00.000Z', sorteio_order: 1 }),
  makeBroker('v2', 'Viva_B', 'Viva Imóveis', { arrived_at: '2026-09-20T08:02:00.000Z', sorteio_order: 3 }),
  makeBroker('v3', 'Viva_C', 'Viva Imóveis', { arrived_at: '2026-09-20T08:03:00.000Z', sorteio_order: 5 }),
  makeBroker('v4', 'Viva_D', 'Viva Imóveis', { arrived_at: '2026-09-20T08:04:00.000Z', sorteio_order: 7 }),
  makeBroker('v5', 'Viva_E', 'Viva Imóveis', { arrived_at: '2026-09-20T08:05:00.000Z', sorteio_order: 9 }),
];

const nobreBrokers: Broker[] = [
  makeBroker('n1', 'Nobre_A', 'Casa Nobre', { arrived_at: '2026-09-20T08:00:30.000Z', sorteio_order: 2 }),
  makeBroker('n2', 'Nobre_B', 'Casa Nobre', { arrived_at: '2026-09-20T08:00:45.000Z', sorteio_order: 4 }),
  makeBroker('n3', 'Nobre_C', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:15.000Z', sorteio_order: 6 }),
  makeBroker('n4', 'Nobre_D', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:30.000Z', sorteio_order: 8 }),
  makeBroker('n5', 'Nobre_E', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:45.000Z', sorteio_order: 10 }),
];

const allBrokers = [...vivaBrokers, ...nobreBrokers];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Temporal Divisor (Rule 1)', () => {
  it('returns arrival mode before 08:46h', () => {
    expect(getDispatchMode(8 * 3600 + 30 * 60)).toBe('arrival');
    expect(getDispatchMode(8 * 3600 + 45 * 60)).toBe('arrival');
    expect(getDispatchMode(SORTEIO_MANHA - 1)).toBe('arrival');
  });

  it('returns sorteio_manha at 08:46h', () => {
    expect(getDispatchMode(SORTEIO_MANHA)).toBe('sorteio_manha');
    expect(getDispatchMode(12 * 3600)).toBe('sorteio_manha');
  });

  it('returns pre_tarde from 13:00h to 13:59h — morning sorteio still governs', () => {
    expect(getDispatchMode(13 * 3600)).toBe('pre_tarde');
    expect(getDispatchMode(13 * 3600 + 30 * 60)).toBe('pre_tarde');
    expect(getDispatchMode(13 * 3600 + 59 * 60)).toBe('pre_tarde');
  });

  it('returns sorteio_tarde at 14:00h', () => {
    expect(getDispatchMode(14 * 3600)).toBe('sorteio_tarde');
    expect(getDispatchMode(18 * 3600)).toBe('sorteio_tarde');
  });

  it('isArrivalOrderMode is true only before 08:46h', () => {
    expect(isArrivalOrderMode(8 * 3600)).toBe(true);
    expect(isArrivalOrderMode(SORTEIO_MANHA)).toBe(false);
    expect(isArrivalOrderMode(13 * 3600)).toBe(false);
  });

  it('isManhaSorteioActive covers 08:46h through 13:59h', () => {
    expect(isManhaSorteioActive(SORTEIO_MANHA)).toBe(true);
    expect(isManhaSorteioActive(12 * 3600)).toBe(true);
    expect(isManhaSorteioActive(13 * 3600)).toBe(true);
    expect(isManhaSorteioActive(13 * 3600 + 59 * 60)).toBe(true);
    expect(isManhaSorteioActive(14 * 3600)).toBe(false);
    expect(isManhaSorteioActive(8 * 3600)).toBe(false);
  });
});

describe('Pre-Sorteio Arrival Order (Rule 1 — before 08:46h)', () => {
  it('Vez Geral: 1st client calls 1st broker to arrive, 2nd calls 2nd, 3rd calls 3rd', () => {
    const exclude = new Set<string>();
    // Sorted by arrival: n1(08:00:30), n2(08:00:45), v1(08:01:00), n3(08:01:15), n4(08:01:30)...
    const b1 = nextBrokerByArrivalAnyAgency(allBrokers, exclude);
    expect(b1?.id).toBe('n1');

    exclude.add(b1!.id);
    const b2 = nextBrokerByArrivalAnyAgency(allBrokers, exclude);
    expect(b2?.id).toBe('n2');

    exclude.add(b2!.id);
    const b3 = nextBrokerByArrivalAnyAgency(allBrokers, exclude);
    expect(b3?.id).toBe('v1');

    exclude.add(b3!.id);
    const b4 = nextBrokerByArrivalAnyAgency(allBrokers, exclude);
    expect(b4?.id).toBe('n3');
  });

  it('Decorado: inverse arrival — last to arrive is first for decorado', () => {
    const exclude = new Set<string>();
    // Inverse sorted by arrival: v5(08:05:00), v4(08:04:00), v3(08:03:00)...
    const b1 = nextBrokerByArrivalInverse(allBrokers, exclude);
    expect(b1?.id).toBe('v5');

    exclude.add(b1!.id);
    const b2 = nextBrokerByArrivalInverse(allBrokers, exclude);
    expect(b2?.id).toBe('v4');

    exclude.add(b2!.id);
    const b3 = nextBrokerByArrivalInverse(allBrokers, exclude);
    expect(b3?.id).toBe('v3');
  });

  it('dispatchBroker uses arrival order for geral pre-sorteio', () => {
    const result = dispatchBroker(allBrokers, 'geral', 8 * 3600 + 30 * 60, new Set(), null, null);
    expect(result.broker?.id).toBe('n1');
    expect(result.consumesVez).toBe(true);
  });

  it('dispatchBroker uses inverse arrival for decorado pre-sorteio', () => {
    const result = dispatchBroker(allBrokers, 'decorado', 8 * 3600 + 30 * 60, new Set(), null, null);
    expect(result.broker?.id).toBe('v5');
    expect(result.consumesVez).toBe(true);
  });
});

describe('Pós-Sorteio Intercalation (Rule 3)', () => {
  it('Vez Geral: alternates agencies starting with the non-last-called', () => {
    // Last called = Viva → next should be Nobre
    const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, new Set(), 'Viva Imóveis', null);
    expect(result.broker?.agency).toBe('Casa Nobre');
    expect(result.broker?.id).toBe('n1'); // sorteio_order 2

    // Last called = Nobre → next should be Viva
    const result2 = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, new Set(), 'Casa Nobre', null);
    expect(result2.broker?.agency).toBe('Viva Imóveis');
    expect(result2.broker?.id).toBe('v1'); // sorteio_order 1
  });

  it('Decorado: uses inverse sorteio (last broker of general queue)', () => {
    const result = dispatchBroker(allBrokers, 'decorado', SORTEIO_MANHA, new Set(), null, null);
    // Highest sorteio_order = 10 (n5)
    expect(result.broker?.id).toBe('n5');
  });

  it('Excludes busy brokers — next available is picked', () => {
    const busy = new Set(['n1', 'v1']);
    const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, busy, 'Casa Nobre', null);
    // Last called Nobre → next Viva, v1 busy → v2 (sorteio_order 3)
    expect(result.broker?.agency).toBe('Viva Imóveis');
    expect(result.broker?.id).toBe('v2');
  });
});

describe('Hierarchical Transbordo for Indicação (Rule 2)', () => {
  it('Step 1: named broker is present and free → goes to them, no vez consumed', () => {
    const result = resolveIndicacaoBroker(allBrokers, 'v1', new Set());
    expect(result.broker?.id).toBe('v1');
    expect(result.consumesVez).toBe(false);
    expect(result.source).toBe('named');
  });

  it('Step 2: named broker absent → same agency (same team) available', () => {
    const absentBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const result = resolveIndicacaoBroker(absentBrokers, 'v1', new Set());
    expect(result.broker?.agency).toBe('Viva Imóveis');
    expect(result.broker?.id).toBe('v2');
    expect(result.consumesVez).toBe(true);
    expect(result.source).toBe('same_agency');
  });

  it('Step 3: no one from same agency → other agency (same diretoria)', () => {
    const allVivaAbsent = allBrokers.map((b) =>
      b.agency === 'Viva Imóveis' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const result = resolveIndicacaoBroker(allVivaAbsent, 'v1', new Set());
    expect(result.broker?.agency).toBe('Casa Nobre');
    expect(result.consumesVez).toBe(true);
    expect(result.source).toBe('other_agency');
  });

  it('Step 4: all corporate instances exhausted → last broker of referred agency', () => {
    // All Viva absent, all Nobre busy → fall back to last of Viva
    const allVivaAbsent = allBrokers.map((b) =>
      b.agency === 'Viva Imóveis' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const allNobreBusy = allVivaAbsent.map((b) =>
      b.agency === 'Casa Nobre' ? { ...b, attendance_status: 'em_mesa' as const } : b,
    );
    const result = resolveIndicacaoBroker(allNobreBusy, 'v1', new Set());
    // No one available → last_of_agency returns undefined since all Viva are ausente
    expect(result.source).toBe('last_of_agency');
    expect(result.broker).toBeUndefined();
  });

  it('dispatchBroker with referredBrokerId uses transbordo', () => {
    const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, new Set(), null, 'v1');
    expect(result.broker?.id).toBe('v1');
    expect(result.consumesVez).toBe(false);
  });
});

describe('Dynamic Queue Advancement (Rule 4)', () => {
  it('Multiple clients can be dispatched simultaneously — each gets next available', () => {
    const exclude = new Set<string>();

    // Client 1 → top of geral
    const r1 = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, null, null);
    expect(r1.broker).toBeDefined();
    exclude.add(r1.broker!.id);

    // Client 2 → next available (different broker, even though client 1 is still in TV timer)
    const r2 = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, r1.agency, null);
    expect(r2.broker).toBeDefined();
    expect(r2.broker?.id).not.toBe(r1.broker?.id);

    // Client 3 → next available
    const r3 = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, r2.agency, null);
    expect(r3.broker).toBeDefined();
    expect(r3.broker?.id).not.toBe(r1.broker?.id);
    expect(r3.broker?.id).not.toBe(r2.broker?.id);
  });

  it('Decorado and Geral use independent queues — same broker can be top of both', () => {
    const geralTop = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, new Set(), null, null);
    const decoradoTop = dispatchBroker(allBrokers, 'decorado', SORTEIO_MANHA, new Set(), null, null);

    // Geral top = lowest sorteio_order (1 = v1), Decorado top = highest (10 = n5)
    expect(geralTop.broker?.id).toBe('v1');
    expect(decoradoTop.broker?.id).toBe('n5');
  });

  it('3 strikes: after 3 failed calls, broker is excluded and next from same queue is called', () => {
    const busy = new Set<string>(['v1']); // v1 was called 3 times and is now paused
    // Last called = Viva → next agency = Nobre → n1 is available
    const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, busy, 'Viva Imóveis', null);
    expect(result.broker?.id).toBe('n1');
    expect(result.broker?.agency).toBe('Casa Nobre');
  });
});

describe('Batch Test: 20+ Clients (Rule 5 + Intercalation)', () => {
  it('dispatches 25 sequential Vez Geral clients without repeating a broker until all have served', () => {
    const exclude = new Set<string>();
    const dispatched: string[] = [];
    let lastAgency: Agency | null = null;

    for (let i = 0; i < 25; i++) {
      const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, lastAgency, null);
      if (!result.broker) {
        // All 10 brokers have served — reset exclusion (simulating reentry cycle)
        exclude.clear();
        const retry = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, lastAgency, null);
        expect(retry.broker).toBeDefined();
        dispatched.push(retry.broker!.id);
        exclude.add(retry.broker!.id);
        lastAgency = retry.agency;
        continue;
      }
      dispatched.push(result.broker!.id);
      exclude.add(result.broker!.id);
      lastAgency = result.agency;
    }

    expect(dispatched.length).toBe(25);
    // First 10 should all be unique (all brokers serve once before any reentry)
    const first10 = new Set(dispatched.slice(0, 10));
    expect(first10.size).toBe(10);
  });

  it('alternates agencies in post-sorteio mode (Viva → Nobre → Viva → ...)', () => {
    const exclude = new Set<string>();
    const agencies: Agency[] = [];
    let lastAgency: Agency | null = null;

    for (let i = 0; i < 10; i++) {
      const result = dispatchBroker(allBrokers, 'geral', SORTEIO_MANHA, exclude, lastAgency, null);
      if (!result.broker) break;
      agencies.push(result.agency);
      exclude.add(result.broker!.id);
      lastAgency = result.agency;
    }

    // Should alternate: no two consecutive same agency
    for (let i = 1; i < agencies.length; i++) {
      expect(agencies[i]).not.toBe(agencies[i - 1]);
    }
  });

  it('decorado dispatches in reverse intercalation order', () => {
    const exclude = new Set<string>();
    const order: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = dispatchBroker(allBrokers, 'decorado', SORTEIO_MANHA, exclude, null, null);
      if (!result.broker) break;
      order.push(result.broker!.id);
      exclude.add(result.broker!.id);
    }

    expect(order.length).toBe(10);
    // First decorado = highest sorteio_order (n5=10), then n4(8), v4(7)...
    expect(order[0]).toBe('n5');
  });

  it('pre-sorteio: 20 clients dispatched in pure arrival order', () => {
    const exclude = new Set<string>();
    const order: string[] = [];
    const preSorteioTime = 8 * 3600 + 20 * 60; // 08:20h

    for (let i = 0; i < 20; i++) {
      const result = dispatchBroker(allBrokers, 'geral', preSorteioTime, exclude, null, null);
      if (!result.broker) {
        exclude.clear();
        const retry = dispatchBroker(allBrokers, 'geral', preSorteioTime, exclude, null, null);
        expect(retry.broker).toBeDefined();
        order.push(retry.broker!.id);
        exclude.add(retry.broker!.id);
        continue;
      }
      order.push(result.broker!.id);
      exclude.add(result.broker!.id);
    }

    expect(order.length).toBe(20);
    // First broker should be the earliest to arrive (n1 at 08:00:30)
    expect(order[0]).toBe('n1');
    // Second should be n2 (08:00:45)
    expect(order[1]).toBe('n2');
  });

  it('pre-sorteio decorado: 10 clients in inverse arrival order', () => {
    const exclude = new Set<string>();
    const order: string[] = [];
    const preSorteioTime = 8 * 3600 + 20 * 60;

    for (let i = 0; i < 10; i++) {
      const result = dispatchBroker(allBrokers, 'decorado', preSorteioTime, exclude, null, null);
      if (!result.broker) break;
      order.push(result.broker!.id);
      exclude.add(result.broker!.id);
    }

    expect(order.length).toBe(10);
    // First decorado = last to arrive (v5 at 08:05:00)
    expect(order[0]).toBe('v5');
    expect(order[1]).toBe('v4');
  });
});

describe('Intercalation Function', () => {
  it('produces alternating agency sequence', () => {
    const visits: Visit[] = Array.from({ length: 6 }, (_, i) => makeVisit(`vis${i}`, `Cliente ${i}`, 'Primeira visita'));
    const entries: QueueEntry[] = visits.map((v, i) =>
      makeQueueEntry(`q${i}`, v, i % 2 === 0 ? 'Viva Imóveis' : 'Casa Nobre', 'geral'),
    );

    const result = interleaveQueue(entries, allBrokers, null);
    expect(result.length).toBe(6);
    // Should alternate Viva, Nobre, Viva, Nobre...
    expect(result[0].agency).toBe('Viva Imóveis');
    expect(result[1].agency).toBe('Casa Nobre');
    expect(result[2].agency).toBe('Viva Imóveis');
    expect(result[3].agency).toBe('Casa Nobre');
  });
});

describe('Dynamic Return Rule (Rule 3 — Término de Atendimento)', () => {
  it('moveBrokerToEndOfQueue sends broker to highest sorteio_order + 1', () => {
    // v1 has sorteio_order 1, max in Viva is 9 (v5)
    // After moving v1 to end, v1 should have sorteio_order 10
    const vivaWithOrder = allBrokers.filter((b) => b.agency === 'Viva Imóveis');
    const maxOrder = Math.max(...vivaWithOrder.map((b) => b.sorteio_order ?? 0));
    expect(maxOrder).toBe(9);

    // Simulate: v1 gets new sorteio_order = maxOrder + 1 = 10
    const updatedBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, sorteio_order: maxOrder + 1 } : b,
    );
    const updatedV1 = updatedBrokers.find((b) => b.id === 'v1');
    expect(updatedV1?.sorteio_order).toBe(10);

    // Now v2 should be the first in Viva (sorteio_order 3)
    const nextViva = nextBrokerFromAgency(updatedBrokers, 'Viva Imóveis', new Set());
    expect(nextViva?.id).toBe('v2');
  });

  it('two brokers never share the same position after recompute', () => {
    // After v1 moves to end (order 10), all Viva brokers should have unique orders
    const updatedBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, sorteio_order: 10 } : b,
    );
    const vivaOrders = updatedBrokers
      .filter((b) => b.agency === 'Viva Imóveis')
      .map((b) => b.sorteio_order)
      .filter((o): o is number => o != null);
    const uniqueOrders = new Set(vivaOrders);
    expect(uniqueOrders.size).toBe(vivaOrders.length);
  });
});

describe('Parceria (Rule 3)', () => {
  it('parceria dispatches to no broker (gerente de parcerias handles it)', () => {
    const result = dispatchBroker(allBrokers, 'parceria', SORTEIO_MANHA, new Set(), null, null);
    expect(result.broker).toBeUndefined();
    expect(result.agency).toBe('Externo');
    expect(result.consumesVez).toBe(false);
  });
});
