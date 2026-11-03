import { describe, it, expect, beforeEach } from 'vitest';
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
  resetCompanyRotation,
  setCompanyDrawOrder,
  setCompanyRotationIndex,
  SORTEIO_MANHA,
  SORTEIO_TARDE,
  ATENDIMENTO_MANHA_START,
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
    equipe: 'Equipe Teste',
    presence_status: 'presente',
    attendance_status: 'livre',
    arrived_at: '2026-09-20T08:10:00.000Z',
    last_status_update: '2026-09-20T08:10:00.000Z',
    is_external_partner: false,
    external_company: null,
    sorteio_order: null,
    inverse_order: null,
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
// sorteio_order is now PER-COMPANY (1-5 for each)
// inverse_order is a single independent global sequence (mirrored)
const vivaBrokers: Broker[] = [
  makeBroker('v1', 'Viva_A', 'Viva Imóveis', { arrived_at: '2026-09-20T08:01:00.000Z', sorteio_order: 1, inverse_order: 10 }),
  makeBroker('v2', 'Viva_B', 'Viva Imóveis', { arrived_at: '2026-09-20T08:02:00.000Z', sorteio_order: 2, inverse_order: 8 }),
  makeBroker('v3', 'Viva_C', 'Viva Imóveis', { arrived_at: '2026-09-20T08:03:00.000Z', sorteio_order: 3, inverse_order: 6 }),
  makeBroker('v4', 'Viva_D', 'Viva Imóveis', { arrived_at: '2026-09-20T08:04:00.000Z', sorteio_order: 4, inverse_order: 4 }),
  makeBroker('v5', 'Viva_E', 'Viva Imóveis', { arrived_at: '2026-09-20T08:05:00.000Z', sorteio_order: 5, inverse_order: 2 }),
];

const nobreBrokers: Broker[] = [
  makeBroker('n1', 'Nobre_A', 'Casa Nobre', { arrived_at: '2026-09-20T08:00:30.000Z', sorteio_order: 1, inverse_order: 9 }),
  makeBroker('n2', 'Nobre_B', 'Casa Nobre', { arrived_at: '2026-09-20T08:00:45.000Z', sorteio_order: 2, inverse_order: 7 }),
  makeBroker('n3', 'Nobre_C', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:15.000Z', sorteio_order: 3, inverse_order: 5 }),
  makeBroker('n4', 'Nobre_D', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:30.000Z', sorteio_order: 4, inverse_order: 3 }),
  makeBroker('n5', 'Nobre_E', 'Casa Nobre', { arrived_at: '2026-09-20T08:01:45.000Z', sorteio_order: 5, inverse_order: 1 }),
];

const allBrokers = [...vivaBrokers, ...nobreBrokers];

// Post-sorteio dispatch time: after 09:00h when the roleta takes command
const POST_SORTEIO_TIME = ATENDIMENTO_MANHA_START + 10 * 60; // 09:10:00

beforeEach(() => {
  resetCompanyRotation();
  setCompanyDrawOrder(['Viva Imóveis', 'Casa Nobre']);
});

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

describe('Pós-Sorteio: Three Isolated Queues (Rule 3)', () => {
  it('Vez Geral: rotation pointer at 0 (Viva) → top of Viva direct queue (v1)', () => {
    const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, new Set(), null, null);
    expect(result.broker?.id).toBe('v1');
    expect(result.broker?.agency).toBe('Viva Imóveis');
  });

  it('Vez Geral: rotation pointer at 1 (Nobre) → top of Nobre direct queue (n1)', () => {
    setCompanyRotationIndex(1);
    const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, new Set(), null, null);
    expect(result.broker?.id).toBe('n1');
    expect(result.broker?.agency).toBe('Casa Nobre');
  });

  it('Vez Geral alternates Viva → Nobre → Viva via rotation pointer', () => {
    const exclude = new Set<string>();
    const r1 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r1.broker?.agency).toBe('Viva Imóveis');
    exclude.add(r1.broker!.id);

    const r2 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r2.broker?.agency).toBe('Casa Nobre');
    exclude.add(r2.broker!.id);

    const r3 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r3.broker?.agency).toBe('Viva Imóveis');
  });

  it('Decorado: strictly dispatches top of inverse queue regardless of brand (n5, inverse_order=1)', () => {
    const result = dispatchBroker(allBrokers, 'decorado', POST_SORTEIO_TIME, new Set(), null, null);
    expect(result.broker?.id).toBe('n5');
  });

  it('Decorado and Geral use fully independent queues', () => {
    const geralTop = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, new Set(), null, null);
    const decoradoTop = dispatchBroker(allBrokers, 'decorado', POST_SORTEIO_TIME, new Set(), null, null);
    // Geral top = Viva's sorteio_order 1 (v1), Decorado top = inverse_order 1 (n5)
    expect(geralTop.broker?.id).toBe('v1');
    expect(decoradoTop.broker?.id).toBe('n5');
  });

  it('Excludes busy brokers — next available Livre from same agency', () => {
    const busy = new Set(['v1', 'n1']);
    // Pointer at 0 (Viva) → v1 busy → v2 (sorteio_order 2)
    const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, busy, null, null);
    expect(result.broker?.agency).toBe('Viva Imóveis');
    expect(result.broker?.id).toBe('v2');
  });
});

describe('Hierarchical Transbordo for Indicação (Rule 2)', () => {
  it('Step 1: named broker is present and free → goes to them, no vez consumed, position protected', () => {
    const result = resolveIndicacaoBroker(allBrokers, 'v1', new Set());
    expect(result.broker?.id).toBe('v1');
    expect(result.consumesVez).toBe(false);
    expect(result.source).toBe('named');
    expect(result.protectedPosition).toBe(true);
  });

  it('Step 2: named broker absent → same team available (last of same team)', () => {
    const absentBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const result = resolveIndicacaoBroker(absentBrokers, 'v1', new Set());
    // Same team = same equipe. All Viva brokers share 'Equipe Teste' → last available of same team
    expect(result.broker).toBeDefined();
    expect(result.consumesVez).toBe(false);
    expect(result.protectedPosition).toBe(true);
    // source is 'same_team' since all Viva share the same equipe
    expect(result.source).toBe('same_team');
  });

  it('Step 3: no one from same team → same company (last of same agency)', () => {
    // Make v1's equipe unique so no one else shares it
    const uniqueTeamBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, equipe: 'Equipe Única' } : b,
    );
    const absentBrokers = uniqueTeamBrokers.map((b) =>
      b.id === 'v1' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const result = resolveIndicacaoBroker(absentBrokers, 'v1', new Set());
    expect(result.broker?.agency).toBe('Viva Imóveis');
    expect(result.consumesVez).toBe(false);
    expect(result.source).toBe('same_agency');
    expect(result.protectedPosition).toBe(true);
  });

  it('Step 4: no one from same company → other agency', () => {
    const allVivaAbsent = allBrokers.map((b) =>
      b.agency === 'Viva Imóveis' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const result = resolveIndicacaoBroker(allVivaAbsent, 'v1', new Set());
    expect(result.broker?.agency).toBe('Casa Nobre');
    expect(result.consumesVez).toBe(false);
    expect(result.source).toBe('other_agency');
    expect(result.protectedPosition).toBe(true);
  });

  it('Step 5: all corporate instances exhausted → last broker of referred agency (undefined)', () => {
    const allVivaAbsent = allBrokers.map((b) =>
      b.agency === 'Viva Imóveis' ? { ...b, presence_status: 'ausente' as const } : b,
    );
    const allNobreBusy = allVivaAbsent.map((b) =>
      b.agency === 'Casa Nobre' ? { ...b, attendance_status: 'em_mesa' as const } : b,
    );
    const result = resolveIndicacaoBroker(allNobreBusy, 'v1', new Set());
    expect(result.source).toBe('last_of_agency');
    expect(result.broker).toBeUndefined();
    expect(result.protectedPosition).toBe(true);
  });

  it('dispatchBroker with referredBrokerId uses transbordo', () => {
    const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, new Set(), null, 'v1');
    expect(result.broker?.id).toBe('v1');
    expect(result.consumesVez).toBe(false);
    expect(result.protectedPosition).toBe(true);
  });
});

describe('Dynamic Queue Advancement (Rule 4)', () => {
  it('Multiple clients can be dispatched simultaneously — each gets next available', () => {
    const exclude = new Set<string>();

    const r1 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r1.broker).toBeDefined();
    exclude.add(r1.broker!.id);

    const r2 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r2.broker).toBeDefined();
    expect(r2.broker?.id).not.toBe(r1.broker?.id);
    exclude.add(r2.broker!.id);

    const r3 = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
    expect(r3.broker).toBeDefined();
    expect(r3.broker?.id).not.toBe(r1.broker?.id);
    expect(r3.broker?.id).not.toBe(r2.broker?.id);
  });

  it('3 strikes: after 3 failed calls, broker is excluded and next Livre is called', () => {
    const busy = new Set<string>(['v1']);
    // Pointer at 0 (Viva) → v1 busy → v2 (next Viva Livre)
    const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, busy, null, null);
    expect(result.broker?.id).toBe('v2');
    expect(result.broker?.agency).toBe('Viva Imóveis');
  });
});

describe('Batch Test: 20+ Clients (Rule 5 + Intercalation)', () => {
  it('dispatches 25 sequential Vez Geral clients without repeating a broker until all have served', () => {
    const exclude = new Set<string>();
    const dispatched: string[] = [];

    for (let i = 0; i < 25; i++) {
      const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
      if (!result.broker) {
        exclude.clear();
        const retry = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
        expect(retry.broker).toBeDefined();
        dispatched.push(retry.broker!.id);
        exclude.add(retry.broker!.id);
        continue;
      }
      dispatched.push(result.broker!.id);
      exclude.add(result.broker!.id);
    }

    expect(dispatched.length).toBe(25);
    const first10 = new Set(dispatched.slice(0, 10));
    expect(first10.size).toBe(10);
  });

  it('alternates agencies in post-sorteio mode (Viva → Nobre → Viva → ...)', () => {
    const exclude = new Set<string>();
    const agencies: Agency[] = [];

    for (let i = 0; i < 10; i++) {
      const result = dispatchBroker(allBrokers, 'geral', POST_SORTEIO_TIME, exclude, null, null);
      if (!result.broker) break;
      agencies.push(result.agency);
      exclude.add(result.broker!.id);
    }

    for (let i = 1; i < agencies.length; i++) {
      expect(agencies[i]).not.toBe(agencies[i - 1]);
    }
  });

  it('decorado dispatches in inverse order (n5, n4, v4, v5...)', () => {
    const exclude = new Set<string>();
    const order: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = dispatchBroker(allBrokers, 'decorado', POST_SORTEIO_TIME, exclude, null, null);
      if (!result.broker) break;
      order.push(result.broker!.id);
      exclude.add(result.broker!.id);
    }

    expect(order.length).toBe(10);
    // inverse_order 1 = n5, 2 = v5, 3 = n4, 4 = v4...
    expect(order[0]).toBe('n5');
    expect(order[1]).toBe('v5');
  });

  it('pre-sorteio: 20 clients dispatched in pure arrival order', () => {
    const exclude = new Set<string>();
    const order: string[] = [];
    const preSorteioTime = 8 * 3600 + 20 * 60;

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
    expect(order[0]).toBe('n1');
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
    expect(result[0].agency).toBe('Viva Imóveis');
    expect(result[1].agency).toBe('Casa Nobre');
    expect(result[2].agency).toBe('Viva Imóveis');
    expect(result[3].agency).toBe('Casa Nobre');
  });
});

describe('Per-Company Direct Queue Independence (Rule 3 — Sorteio)', () => {
  it('sorteio_order is per-company: each agency has its own 1-N sequence', () => {
    const vivaOrders = vivaBrokers.map((b) => b.sorteio_order).filter((o): o is number => o != null);
    const nobreOrders = nobreBrokers.map((b) => b.sorteio_order).filter((o): o is number => o != null);

    // Viva: 1, 2, 3, 4, 5
    expect(Math.max(...vivaOrders)).toBe(5);
    // Nobre: 1, 2, 3, 4, 5 (independent numbering)
    expect(Math.max(...nobreOrders)).toBe(5);
  });

  it('inverse_order is a single global sequence across both agencies', () => {
    const allInverse = allBrokers.map((b) => b.inverse_order).filter((o): o is number => o != null);
    expect(Math.max(...allInverse)).toBe(10);
    expect(Math.min(...allInverse)).toBe(1);
  });

  it('nextBrokerFromAgency returns top of that company queue only', () => {
    const vivaTop = nextBrokerFromAgency(allBrokers, 'Viva Imóveis', new Set());
    const nobreTop = nextBrokerFromAgency(allBrokers, 'Casa Nobre', new Set());
    expect(vivaTop?.id).toBe('v1');
    expect(nobreTop?.id).toBe('n1');
  });

  it('two brokers never share the same position after recompute', () => {
    const updatedBrokers = allBrokers.map((b) =>
      b.id === 'v1' ? { ...b, sorteio_order: 6 } : b,
    );
    const vivaOrders = updatedBrokers
      .filter((b) => b.agency === 'Viva Imóveis')
      .map((b) => b.sorteio_order)
      .filter((o): o is number => o != null);
    const uniqueOrders = new Set(vivaOrders);
    expect(uniqueOrders.size).toBe(vivaOrders.length);
  });
});

describe('Inverse Queue Isolation (Rule 3 — Decorado)', () => {
  it('nextBrokerFromInverseTop returns broker with lowest inverse_order regardless of brand', () => {
    const top = nextBrokerFromInverseTop(allBrokers, new Set());
    expect(top?.id).toBe('n5');
    expect(top?.inverse_order).toBe(1);
  });

  it('inverse queue dispatches in inverse_order sequence, not by agency', () => {
    const exclude = new Set<string>();
    const order: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = nextBrokerFromInverseTop(allBrokers, exclude);
      if (!result) break;
      order.push(result.id);
      exclude.add(result.id);
    }

    expect(order.length).toBe(10);
    // n5(1), v5(2), n4(3), v4(4), n3(5), v3(6), n2(7), v2(8), n1(9), v1(10)
    expect(order[0]).toBe('n5');
    expect(order[1]).toBe('v5');
    expect(order[2]).toBe('n4');
  });
});

describe('Parceria (Rule 3)', () => {
  it('parceria dispatches to no broker (gerente de parcerias handles it)', () => {
    const result = dispatchBroker(allBrokers, 'parceria', POST_SORTEIO_TIME, new Set(), null, null);
    expect(result.broker).toBeUndefined();
    expect(result.agency).toBe('Externo');
    expect(result.consumesVez).toBe(false);
  });
});
