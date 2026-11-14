import { afterEach, describe, expect, it } from "vitest";
import type { Broker, Shift } from "../supabase";
import { supabase } from "../supabase";
import {
  admissionPlan,
  afterAdmissionCutoff,
  exclusionPlan,
  onlyOwn,
  partnerIntake,
  partnerReservation,
  pauseElapsed,
  pauseExpired,
  returnFromPause,
  scopeOf,
  startPause,
  type PauseBroker,
} from "./pauseAndPartners";
import {
  actOnPause,
  createPartnerIntake,
  enforcePauses,
  reservePartnerUnit,
  savePartnerSale,
} from "./pauseAndPartnersStore";
import {
  dispatchBroker,
  distributeIndicacao,
  nextBrokerFromAgency,
  nextBrokerFromInverseTop,
  markMeritReturns,
} from "../queueEngine";
import { setScheduleClock } from "./shiftSchedule";
const clock = (time: string, shift: Shift = "manha") => ({
  at: `2026-11-13T${time}-03:00`,
  shift,
});
const broker = (
  id: string,
  rank = 1,
  extra: Partial<PauseBroker> = {},
): PauseBroker =>
  ({
    id,
    operational_name: id,
    agency: "Viva Imóveis",
    equipe: "A",
    presence_status: "presente",
    attendance_status: "livre",
    shift: "manha",
    sorteio_order: rank,
    inverse_order: rank,
    arrived_at: clock("08:00:00").at,
    is_external_partner: false,
    ...extra,
  }) as PauseBroker;
const paused = (
  b: PauseBroker,
  rows: Broker[],
  time = "09:00:00",
): PauseBroker => ({ ...b, ...startPause(b, rows, clock(time)).patch });
afterEach(() => setScheduleClock(undefined));

describe("Continuous pauses", () => {
  it("records the exact ordinal, snapshot and timestamp independently of rank values", () => {
    const rows = [broker("a", 100), broker("b", 200), broker("c", 300)];
    expect(startPause(rows[1], rows, clock("09:00:00")).patch).toMatchObject({
      pause_exit_index: 2,
      pause_exit_order: 200,
      pause_direct_snapshot: ["a", "b", "c"],
      pause_started_at: clock("09:00:00").at,
      manager_excused: false,
    });
  });
  it("records the visible ordinal when another broker is already paused", () => {
    const rows = [
      broker("a", 1, { presence_status: "pausa" }),
      broker("b", 2),
      broker("c", 3),
    ];
    expect(
      startPause(rows[2], rows, clock("09:00:00")).patch.pause_exit_index,
    ).toBe(2);
  });
  it("requires presence before starting a pause", () => {
    const b = broker("a", 1, { presence_status: "ausente" });
    expect(() => startPause(b, [b], clock("09:00:00"))).toThrow();
  });
  it("does not reset a running pause on another Pause click", () => {
    const b = paused(broker("a"), [broker("a")]);
    expect(startPause(b, [b], clock("10:59:00")).patch).toEqual({});
    expect(pauseElapsed(b, clock("10:59:00").at)).toBe(119 * 60000);
  });
  it("allows exactly 120 minutes and excludes after the next second", () => {
    const b = paused(broker("a"), [broker("a")]);
    expect(pauseExpired(b, clock("11:00:00"))).toBe(false);
    expect(exclusionPlan(b, clock("11:00:01"))).toMatchObject({
      logEvasion: true,
      patch: {
        only_own_referrals: true,
        sorteio_order: null,
        inverse_order: null,
        merit_priority_return: false,
        restriction_reason: "pause",
      },
    });
  });
  it("starts a new continuous timer instead of accumulating two 80-minute absences", () => {
    const b = paused(broker("a"), [broker("a")]);
    const returned = {
      ...b,
      ...returnFromPause(b, [b], clock("10:20:00")).patch,
    };
    const again = paused(returned, [returned], "10:30:00");
    expect(pauseExpired(again, clock("11:50:00"))).toBe(false);
    expect(again.manager_excused).toBe(false);
    expect(pauseElapsed(again, clock("10:30:00").at)).toBe(0);
  });
  it("never excludes a pause from an earlier shift", () => {
    const b = paused(broker("a"), [broker("a")]);
    expect(pauseExpired(b, clock("14:10:00", "tarde"))).toBe(false);
  });
  it("retains position 11 when the current free broker is 8", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      broker(String(i + 1), i + 1, {
        attendance_status: i < 7 ? "em_atendimento" : "livre",
      }),
    );
    const b = paused(rows[10], rows);
    const result = returnFromPause(b, rows, clock("10:00:00"));
    expect(result.patch.sorteio_order).toBe(11);
    expect(result.directOrder).toBeUndefined();
  });
  it.each([2, 3, 4, 5])(
    "returns behind the next broker %s when the turn is adjacent or has passed",
    (head) => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        broker(String(i + 1), i + 1, {
          attendance_status: i + 1 < head ? "em_atendimento" : "livre",
        }),
      );
      rows[2] = broker("3", 3);
      const b = paused(rows[2], rows);
      const result = returnFromPause(b, rows, clock("10:00:00"));
      const actualHead = head === 3 ? 4 : head;
      expect(result.directOrder!.indexOf("3")).toBe(
        result.directOrder!.indexOf(String(actualHead)) + 1,
      );
      expect(result.directOrder).toHaveLength(6);
      expect(result.patch.inverse_order).toBe(3);
    },
  );
  it("manager excuse applies the dynamic return even after expiry", () => {
    const rows = [broker("a", 1), broker("b", 2), broker("c", 3)];
    const b = {
      ...paused(rows[0], rows),
      manager_excused: true,
      only_own_referrals: true,
      restriction_reason: "pause" as const,
      sorteio_order: null,
    };
    const result = returnFromPause(b, [b, ...rows.slice(1)], clock("12:00:00"));
    expect(result.directOrder).toEqual(["b", "a", "c"]);
    expect(result.patch.only_own_referrals).toBe(false);
  });
  it("cannot evade a same-shift exclusion by starting and returning from a new short pause", () => {
    const b = broker("a", 1, {
      only_own_referrals: true,
      restriction_reason: "pause",
      restriction_scope: scopeOf(clock("11:00:01")),
    });
    const again = paused(b, [b], "11:10:00");
    expect(
      returnFromPause(again, [again], clock("11:11:00")).patch,
    ).toMatchObject({
      only_own_referrals: true,
      sorteio_order: null,
      inverse_order: null,
    });
  });
  it("does not let a pause excuse remove a late-entry restriction", () => {
    const b = {
      ...paused(broker("a"), [broker("a")]),
      restriction_reason: "late" as const,
      only_own_referrals: true,
      manager_excused: true,
    };
    expect(returnFromPause(b, [b], clock("12:00:00")).patch).toMatchObject({
      only_own_referrals: true,
      sorteio_order: null,
      inverse_order: null,
    });
  });
  it("rejects pausing in the middle of an attendance", () => {
    const b = broker("a", 1, { attendance_status: "em_atendimento" });
    expect(() => startPause(b, [b], clock("10:00:00"))).toThrow();
  });
});

describe("Only own referrals", () => {
  it.each([
    ["09:30:00", "manha", false],
    ["09:30:01", "manha", true],
    ["14:30:00", "tarde", false],
    ["14:30:01", "tarde", true],
    ["14:00:00", "manha", true],
  ] as const)("checks cutoff %s %s", (time, shift, expected) => {
    expect(afterAdmissionCutoff(clock(time, shift))).toBe(expected);
    expect(
      admissionPlan(broker("a"), clock(time, shift)).only_own_referrals,
    ).toBe(expected);
  });
  it("keeps exclusion for the rest of the same shift but releases it next shift", () => {
    const b = broker("a", 1, {
      only_own_referrals: true,
      restriction_reason: "pause",
      restriction_scope: scopeOf(clock("11:00:01")),
    });
    expect(admissionPlan(b, clock("12:00:00")).only_own_referrals).toBe(true);
    expect(
      admissionPlan(b, clock("14:10:00", "tarde")).only_own_referrals,
    ).toBe(false);
  });
  it("excludes a restricted broker from direct, inverse and coverage even with stale livre status", () => {
    const rows = [
      broker("own", 1, { only_own_referrals: true }),
      broker("other", 2),
      broker("owner", 3, { presence_status: "ausente" }),
    ];
    expect(onlyOwn(rows[0])).toBe(true);
    expect(nextBrokerFromAgency(rows, "Viva Imóveis", new Set())?.id).toBe(
      "other",
    );
    expect(nextBrokerFromInverseTop(rows, new Set())?.id).toBe("other");
    expect(distributeIndicacao(rows, "owner", new Set()).broker?.id).toBe(
      "other",
    );
  });
  it("admits only its own named client and refuses coverage when that owner is unavailable", () => {
    const rows = [
      broker("own", 1, { only_own_referrals: true }),
      broker("other", 2),
    ];
    expect(
      dispatchBroker(rows, "geral", 36000, new Set(), null, "own"),
    ).toMatchObject({
      broker: { id: "own" },
      consumesVez: false,
      protectedPosition: true,
    });
    expect(
      dispatchBroker(rows, "decorado", 36000, new Set(), null, "own").broker,
    ).toBeUndefined();
    expect(
      distributeIndicacao(rows, "own", new Set(["own"])).broker,
    ).toBeUndefined();
  });
  it("respects closure for own clients too", () => {
    setScheduleClock({
      date: "2026-11-13",
      seconds: 21 * 3600,
      singleShift: false,
    });
    expect(
      dispatchBroker(
        [broker("a", 1, { only_own_referrals: true })],
        "geral",
        21 * 3600,
        new Set(),
        null,
        "a",
      ).broker,
    ).toBeUndefined();
  });
});

describe("Persistence and isolation", () => {
  it("logs one evasion, persists restriction on return, and records a manager excuse", async () => {
    const rows = [broker("persist-a", 1), broker("persist-b", 2)];
    await supabase.from("brokers").insert(rows);
    await actOnPause("persist-a", "pause", clock("09:00:00"));
    await actOnPause("persist-a", "expire", clock("11:00:01"));
    await actOnPause("persist-a", "expire", clock("11:01:00"));
    await actOnPause("persist-a", "return", clock("11:02:00"));
    const restricted = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "persist-a")
      .single();
    expect(restricted.data).toMatchObject({
      only_own_referrals: true,
      sorteio_order: null,
      inverse_order: null,
      presence_status: "presente",
    });
    const logs = await supabase
      .from("pause_audit")
      .select("*")
      .eq("broker_id", "persist-a")
      .eq("event", "evasion");
    expect(logs.data).toHaveLength(1);
    await expect(
      actOnPause("persist-a", "excuse", clock("11:03:00")),
    ).rejects.toThrow();
    await actOnPause("persist-a", "excuse", clock("11:03:00"), "Gerente Teste");
    const returned = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "persist-a")
      .single();
    expect(returned.data).toMatchObject({
      manager_excused: true,
      only_own_referrals: false,
      attendance_status: "livre",
    });
    expect(returned.data.sorteio_order).not.toBeNull();
    const excuses = await supabase
      .from("pause_audit")
      .select("*")
      .eq("broker_id", "persist-a")
      .eq("event", "excuse");
    expect(excuses.data?.[0].manager_name).toBe("Gerente Teste");
  });
  it("never awards merit or restores distribution after a restricted attendance concludes", async () => {
    const b = broker("restricted-persist", 0, {
      only_own_referrals: true,
      merit_priority_return: false,
    });
    await supabase.from("brokers").insert(b);
    await markMeritReturns([b, broker("other", 2)], broker("other", 2), [
      {
        broker_id: b.id,
        queue_status: "em_atendimento",
        queue_type: "geral",
        visit: { visit_reason: "Retorno" },
      } as never,
    ]);
    await enforcePauses(clock("11:00:00"));
    const result = await supabase
      .from("brokers")
      .select("*")
      .eq("id", b.id)
      .single();
    expect(result.data).toMatchObject({
      merit_priority_return: false,
      sorteio_order: null,
      inverse_order: null,
      attendance_status: "apenas_indicacao",
    });
  });
  it("records only minimal partner intake and no changes to internal queues or rotation", async () => {
    const before = await supabase.from("queue_entries").select("*");
    const brokersBefore = await supabase.from("brokers").select("*");
    const input = {
      id: "partner-intake",
      partner_name: "Parceiro",
      company: "",
      creci: "12345-F",
      client_first_name: "Ana",
      arrival: "before_partner" as const,
      manager_target: "general" as const,
    };
    const minimal = partnerIntake({
      ...input,
      customer_phone: "forbidden",
      customer_full_name: "not collected",
    } as typeof input);
    expect(minimal).not.toHaveProperty("customer_phone");
    expect(minimal).not.toHaveProperty("customer_full_name");
    await createPartnerIntake(input);
    await createPartnerIntake(input);
    const intake = await supabase
      .from("external_partner_intakes")
      .select("*")
      .eq("id", input.id)
      .single();
    expect(intake.data).toMatchObject({
      company: "Autônomo",
      manager_status: "pending",
      manager_target: "general",
      client_first_name: "Ana",
    });
    expect((await supabase.from("queue_entries").select("*")).data).toEqual(
      before.data,
    );
    expect((await supabase.from("brokers").select("*")).data).toEqual(
      brokersBefore.data,
    );
    await expect(
      savePartnerSale("missing", "Ana Silva", "11999999999"),
    ).rejects.toThrow();
    await expect(reservePartnerUnit(input.id, " ")).rejects.toThrow();
    const reservation = await reservePartnerUnit(input.id, "Torre A / 101");
    expect(reservation.commission_percent).toBe(100);
    expect((await reservePartnerUnit(input.id, "Torre A / 101")).id).toBe(
      reservation.id,
    );
    await savePartnerSale(reservation.id, "Ana Silva", "11999999999");
    const sale = await supabase
      .from("external_partner_reservations")
      .select("*")
      .eq("id", reservation.id)
      .single();
    expect(sale.data).toMatchObject({
      customer_full_name: "Ana Silva",
      commission_percent: 100,
      unit_reference: "Torre A / 101",
    });
    expect((await supabase.from("queue_entries").select("*")).data).toEqual(
      before.data,
    );
  });
  it.each(["before_partner", "accompanied"] as const)(
    "validates partner arrival %s",
    (arrival) => {
      expect(
        partnerIntake({
          id: "x",
          partner_name: "A",
          company: "B",
          creci: "1-F",
          client_first_name: "Ana",
          arrival,
          manager_target: "partnerships",
        }).arrival,
      ).toBe(arrival);
      expect(() =>
        partnerIntake({
          id: "x",
          partner_name: "A",
          company: "B",
          creci: "",
          client_first_name: "Ana Silva",
          arrival,
          manager_target: "partnerships",
        }),
      ).toThrow();
      expect(() => partnerReservation("x", "")).toThrow();
    },
  );
});


it("starts a new shift admission without restoring a previous shift pause", async () => {
  const b = paused(broker("prior-shift-pause", 99), [broker("prior-shift-pause", 99)]);
  await supabase.from("brokers").insert(b);
  try {
    await actOnPause(b.id, "checkin", clock("14:20:00", "tarde"));
    const { data } = await supabase.from("brokers").select("*").eq("id", b.id).single();
    expect(data).toMatchObject({ shift: "tarde", presence_status: "presente", pause_started_at: null, pause_scope: null, only_own_referrals: false });
    expect(data.sorteio_order).not.toBe(99);
  } finally {
    await supabase.from("brokers").delete().eq("id", b.id);
  }
});
