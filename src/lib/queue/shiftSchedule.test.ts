import { afterEach, describe, expect, it } from "vitest";
import {
  activeBrokers,
  arrivalQueue,
  closingPatch,
  enrolledForAfternoon,
  preOpeningBroker,
  preOpeningChoice,
  scheduleAt,
  setScheduleClock,
  transitionBroker,
  type ScheduledBroker,
  type ScheduleClock,
  type ShiftDraw,
} from "./shiftSchedule";
import {
  dispatchBroker,
  isArrivalOrderDispatchActive,
  isArrivalOrderMode,
  nextBrokerByArrivalInverse,
} from "../queueEngine";
import {
  makeDraw,
  advanceSchedule,
  enrollAfternoon,
} from "./shiftScheduleStore";
import { supabase } from "../supabase";
const time = (h: number, m = 0, s = 0) => h * 3600 + m * 60 + s;
const clock = (seconds: number, singleShift = false): ScheduleClock => ({
  seconds,
  singleShift,
  date: "2026-11-13",
});
const broker = (
  id: string,
  extra: Partial<ScheduledBroker> = {},
): ScheduledBroker =>
  ({
    id,
    operational_name: id,
    agency: "Viva Imóveis",
    equipe: "A",
    presence_status: "presente",
    attendance_status: "livre",
    arrived_at: "2026-11-13T08:01:00-03:00",
    shift: "manha",
    sorteio_order: 1,
    inverse_order: 1,
    is_external_partner: false,
    ...extra,
  }) as ScheduledBroker;
const draw: ShiftDraw = {
  viva: ["a", "b"],
  nobre: ["c"],
  inverse: ["c", "b", "a"],
  firstAgency: "Viva Imóveis",
};
afterEach(() => setScheduleClock(undefined));

describe("Schedule boundaries", () => {
  it.each([false, true])(
    "uses arrival order only from 08:00 until 08:59:59, single=%s",
    (single) => {
      expect(scheduleAt(clock(time(7, 59, 59), single)).preOpening).toBe(false);
      for (const s of [time(8), time(8, 45, 59), time(8, 46), time(8, 59, 59)])
        expect(scheduleAt(clock(s, single)).preOpening).toBe(true);
      expect(scheduleAt(clock(time(9), single)).preOpening).toBe(false);
    },
  );
  it("draws at 08:46 while keeping temporary arrival until 09:00", () => {
    expect(scheduleAt(clock(time(8, 45, 59))).morningDrawDue).toBe(false);
    expect(scheduleAt(clock(time(8, 46))).morningDrawDue).toBe(true);
    setScheduleClock(clock(time(8, 50)));
    expect(isArrivalOrderMode(time(8, 50))).toBe(true);
    expect(isArrivalOrderMode(time(9))).toBe(false);
  });
  it.each([
    time(13),
    time(13, 45, 59),
    time(13, 46),
    time(13, 59, 59),
    time(14),
  ])("keeps the morning active at %s", (s) => {
    expect(scheduleAt(clock(s)).shift).toBe("manha");
    expect(isArrivalOrderDispatchActive(s)).toBe(false);
  });
  it("coexists from 13:46 to activation at 14:00:01", () => {
    expect(scheduleAt(clock(time(13, 45, 59))).coexistence).toBe(false);
    expect(scheduleAt(clock(time(13, 46))).coexistence).toBe(true);
    expect(scheduleAt(clock(time(14))).coexistence).toBe(true);
    expect(scheduleAt(clock(time(14, 0, 1)))).toMatchObject({
      coexistence: false,
      afternoonActive: true,
      shift: "tarde",
    });
  });
  it.each([time(13), time(13, 46), time(14, 0, 1), time(19), time(20)])(
    "single shift disables afternoon at %s",
    (s) => {
      expect(scheduleAt(clock(s, true))).toMatchObject({
        shift: "manha",
        afternoonEnrollment: false,
        afternoonDrawDue: false,
        coexistence: false,
        afternoonActive: false,
      });
    },
  );
  it("respects enrollment second and date", () => {
    expect(
      enrolledForAfternoon(
        broker("a", { afternoon_enrolled_at: "2026-11-13T13:45:59-03:00" }),
        "2026-11-13",
      ),
    ).toBe(true);
    for (const stamp of [
      "2026-11-13T12:59:59-03:00",
      "2026-11-13T13:46:00-03:00",
      "2026-11-12T13:30:00-03:00",
    ])
      expect(
        enrolledForAfternoon(
          broker("a", { afternoon_enrolled_at: stamp }),
          "2026-11-13",
        ),
      ).toBe(false);
  });
  it("allows overtime after 19 until the 21 closure", () => {
    expect(scheduleAt(clock(time(19))).overtime).toBe(false);
    expect(scheduleAt(clock(time(19, 0, 1))).overtime).toBe(true);
    expect(scheduleAt(clock(time(20, 59, 59))).acceptingClients).toBe(true);
    expect(scheduleAt(clock(time(21)))).toMatchObject({
      closed: true,
      acceptingClients: false,
    });
  });
});

describe("Scheduled dispatch and continuity", () => {
  it("uses forward arrival for both first visit and Decorado in the running application", () => {
    const rows = [
      broker("a"),
      broker("b", { arrived_at: "2026-11-13T08:00:00-03:00" }),
    ];
    setScheduleClock(clock(time(8, 50)));
    for (const kind of ["geral", "decorado"] as const)
      expect(
        dispatchBroker(rows, kind, time(8, 50), new Set(), null, null).broker
          ?.id,
      ).toBe("b");
    expect(nextBrokerByArrivalInverse(rows, new Set())?.id).toBe("b");
    expect(arrivalQueue(rows, new Set(["b"]))[0].id).toBe("a");
  });
  it("offers waiting or the first free same-company arrival without team restriction", () => {
    const rows = [
      broker("a", { arrived_at: null, presence_status: "ausente" }),
      broker("b", { equipe: "other" }),
      broker("c", {
        agency: "Casa Nobre",
        arrived_at: "2026-11-13T08:00:00-03:00",
      }),
    ];
    const choice = preOpeningChoice(rows, "a");
    expect(choice.needsChoice).toBe(true);
    expect(choice.alternative?.id).toBe("b");
    expect(preOpeningBroker(rows, "geral", "a", new Set())).toBeUndefined();
    expect(preOpeningBroker(rows, "geral", "b", new Set())?.id).toBe("b");
    expect(
      preOpeningChoice(rows, "a", new Set(["b"])).alternative,
    ).toBeUndefined();
  });
  it("retains absent-owner metadata for same-company coverage after opening", () => {
    setScheduleClock(clock(time(10)));
    const rows = [
      broker("owner", { shift: null, presence_status: "ausente" }),
      broker("cover"),
    ];
    expect(
      dispatchBroker(rows, "geral", time(10), new Set(), null, "owner").broker
        ?.id,
    ).toBe("cover");
  });
  it("preserves the valid afternoon rank and ongoing attendance", () => {
    const busy = broker("b", {
      attendance_status: "em_atendimento",
      afternoon_enrolled_at: "2026-11-13T13:45:59-03:00",
    });
    const result = { ...busy, ...transitionBroker(busy, draw, "2026-11-13") };
    expect(result).toMatchObject({
      shift: "tarde",
      attendance_status: "em_atendimento",
      sorteio_order: 2,
      inverse_order: 2,
      preserve_shift_position: true,
    });
  });
  it("keeps a non-enrolled ongoing service until completion without admitting it to afternoon queues", () => {
    const busy = broker("a", { attendance_status: "em_atendimento" });
    const result = { ...busy, ...transitionBroker(busy, draw, "2026-11-13") };
    expect(result.attendance_status).toBe("em_atendimento");
    expect(activeBrokers([result], clock(time(14, 0, 1)))).toEqual([]);
  });
  it("departure removes a free broker and lets a busy broker finish", () => {
    expect(closingPatch(broker("a"))).toMatchObject({
      presence_status: "ausente",
      sorteio_order: null,
      inverse_order: null,
    });
    expect(
      closingPatch(broker("a", { attendance_status: "em_atendimento" })),
    ).toEqual({ leave_after_service: true });
    expect(activeBrokers([broker("a")], clock(time(21)))).toEqual([]);
  });
  it("creates three independent draw lists", () => {
    const result = makeDraw(
      [broker("a"), broker("b"), broker("c", { agency: "Casa Nobre" })],
      () => 0.25,
    );
    const inverse = [...result.inverse];
    result.viva.reverse();
    expect(result.inverse).toEqual(inverse);
    expect(result.nobre).toEqual(["c"]);
  });
});

describe("Schedule persistence in the simulator", () => {
  it("never creates an afternoon draw on single-shift days", async () => {
    const single = { ...clock(time(14, 1), true), date: "2026-11-15" };
    expect(await advanceSchedule(single)).toBeNull();
    const result = await supabase
      .from("plantao_sessions")
      .select("*")
      .eq("plantao_date", single.date);
    expect(result.data?.map((row) => row.id)).toEqual([
      "schedule_2026-11-15_morning",
      "schedule_2026-11-15_morning_activate",
    ]);
  });
  it("rejects afternoon enrollment after the cutoff or on a single-shift day", async () => {
    await expect(enrollAfternoon("a", clock(time(13, 46)))).rejects.toThrow();
    await expect(
      enrollAfternoon("a", clock(time(13, 30), true)),
    ).rejects.toThrow();
  });
  it("draws once, preserves morning during coexistence, carries the lead and keeps busy status", async () => {
    const date = "2026-11-14";
    const dayClock = (seconds: number) => ({ ...clock(seconds), date });
    await supabase
      .from("brokers")
      .insert(
        broker("schedule-test", { arrived_at: `${date}T08:00:00-03:00` }),
      );
    await advanceSchedule(dayClock(time(8, 46)));
    await advanceSchedule(dayClock(time(9)));
    await enrollAfternoon("schedule-test", dayClock(time(13, 45, 59)));
    await supabase
      .from("brokers")
      .update({ attendance_status: "em_atendimento", sorteio_order: 42 })
      .eq("id", "schedule-test");
    await supabase
      .from("queue_entries")
      .insert({
        id: "ongoing",
        broker_id: "schedule-test",
        shift: "manha",
        queue_status: "em_atendimento",
      });
    const first = await advanceSchedule(dayClock(time(13, 46)));
    const second = await advanceSchedule(dayClock(time(13, 59, 59)));
    expect(second).toEqual(first);
    const before = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "schedule-test")
      .single();
    expect(before.data.sorteio_order).toBe(42);
    expect(before.data.shift).toBe("manha");
    await advanceSchedule(dayClock(time(14, 0, 1)));
    const after = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "schedule-test")
      .single();
    expect(after.data).toMatchObject({
      shift: "tarde",
      attendance_status: "em_atendimento",
      sorteio_order: 1,
    });
    const lead = await supabase
      .from("queue_entries")
      .select("*")
      .eq("id", "ongoing")
      .single();
    expect(lead.data.shift).toBe("tarde");
    await advanceSchedule(dayClock(time(21)));
    const closing = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "schedule-test")
      .single();
    expect(closing.data).toMatchObject({
      leave_after_service: true,
      attendance_status: "em_atendimento",
    });
    await supabase
      .from("brokers")
      .update({ attendance_status: "livre" })
      .eq("id", "schedule-test");
    await advanceSchedule(dayClock(time(21, 1)));
    const exited = await supabase
      .from("brokers")
      .select("*")
      .eq("id", "schedule-test")
      .single();
    expect(exited.data).toMatchObject({
      presence_status: "ausente",
      sorteio_order: null,
      inverse_order: null,
    });
  });
});
