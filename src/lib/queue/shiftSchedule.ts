import type { Agency, Broker, QueueEntry, QueueType, Shift } from "../supabase";

export const SHIFT_TIMES = {
  open: 8 * 3600,
  morningDraw: 8 * 3600 + 46 * 60,
  morningStart: 9 * 3600,
  afternoonEnrollment: 13 * 3600,
  afternoonDeadline: 13 * 3600 + 45 * 60 + 59,
  afternoonDraw: 13 * 3600 + 46 * 60,
  afternoonStart: 14 * 3600 + 1,
  regularEnd: 19 * 3600,
  close: 21 * 3600,
} as const;

export type ScheduleClock = {
  seconds: number;
  singleShift: boolean;
  date: string;
};
export type ScheduledBroker = Broker & {
  afternoon_enrolled_at?: string | null;
  preserve_shift_position?: boolean;
  leave_after_service?: boolean;
};
export type ShiftDraw = {
  viva: string[];
  nobre: string[];
  inverse: string[];
  firstAgency: Agency;
};

export function scheduleAt({ seconds: s, singleShift }: ScheduleClock) {
  const afternoon = !singleShift && s >= SHIFT_TIMES.afternoonStart;
  return {
    shift: (afternoon ? "tarde" : "manha") as Shift,
    preOpening: s >= SHIFT_TIMES.open && s < SHIFT_TIMES.morningStart,
    coexistence:
      !singleShift &&
      s >= SHIFT_TIMES.afternoonDraw &&
      s < SHIFT_TIMES.afternoonStart,
    afternoonEnrollment:
      !singleShift &&
      s >= SHIFT_TIMES.afternoonEnrollment &&
      s <= SHIFT_TIMES.afternoonDeadline,
    morningDrawDue: s >= SHIFT_TIMES.morningDraw,
    afternoonDrawDue: !singleShift && s >= SHIFT_TIMES.afternoonDraw,
    afternoonActive: afternoon,
    overtime: s > SHIFT_TIMES.regularEnd && s < SHIFT_TIMES.close,
    acceptingClients: s >= SHIFT_TIMES.open && s < SHIFT_TIMES.close,
    closed: s >= SHIFT_TIMES.close,
  };
}

export function enrolledForAfternoon(
  broker: ScheduledBroker,
  date: string,
): boolean {
  const value = broker.afternoon_enrolled_at;
  if (!value) return false;
  // Enrollment timestamps are generated in the plantão's São Paulo time zone.
  const local = new Date(value).toLocaleString("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
  return (
    local.slice(0, 10) === date &&
    local.slice(11, 19) >= "13:00:00" &&
    local.slice(11, 19) <= "13:45:59"
  );
}

export function arrivalQueue(brokers: Broker[], excluded = new Set<string>()) {
  return brokers
    .filter(
      (b) =>
        !b.is_external_partner &&
        b.arrived_at &&
        b.presence_status === "presente" &&
        b.attendance_status === "livre" &&
        !excluded.has(b.id),
    )
    .sort(
      (a, b) =>
        Date.parse(a.arrived_at!) - Date.parse(b.arrived_at!) ||
        a.id.localeCompare(b.id),
    );
}

export function preOpeningChoice(
  brokers: Broker[],
  ownerId: string | null,
  excluded = new Set<string>(),
) {
  const owner = brokers.find((b) => b.id === ownerId);
  const registered = !!owner?.arrived_at && owner.presence_status !== "ausente";
  const available = arrivalQueue(brokers, excluded);
  return {
    needsChoice: !!owner && !registered,
    owner: registered ? available.find((b) => b.id === ownerId) : undefined,
    alternative: owner
      ? available.find((b) => b.agency === owner.agency)
      : available[0],
  };
}

export function preOpeningBroker(
  brokers: Broker[],
  queueType: QueueType,
  ownerId: string | null,
  excluded: Set<string>,
) {
  if (queueType === "parceria") return undefined;
  if (ownerId) return preOpeningChoice(brokers, ownerId, excluded).owner;
  return arrivalQueue(brokers, excluded)[0];
}

export function transitionBroker(
  broker: ScheduledBroker,
  draw: ShiftDraw,
  date: string,
): Partial<ScheduledBroker> {
  const direct = broker.agency === "Viva Imóveis" ? draw.viva : draw.nobre;
  const rank = direct.indexOf(broker.id);
  const inService = ["em_atendimento", "em_mesa", "decorado"].includes(
    broker.attendance_status,
  );
  if (rank >= 0 && enrolledForAfternoon(broker, date))
    return {
      shift: "tarde",
      sorteio_order: rank + 1,
      inverse_order: draw.inverse.indexOf(broker.id) + 1,
      arrived_at: broker.afternoon_enrolled_at,
      afternoon_reserved: false,
      preserve_shift_position: inService,
    };
  return {
    shift: null,
    sorteio_order: null,
    inverse_order: null,
    presence_status: inService ? broker.presence_status : "ausente",
    leave_after_service: inService,
  };
}

export function closingPatch(broker: Broker): Partial<ScheduledBroker> {
  const busy = ["em_atendimento", "em_mesa", "decorado"].includes(
    broker.attendance_status,
  );
  return busy
    ? { leave_after_service: true }
    : { presence_status: "ausente", sorteio_order: null, inverse_order: null };
}

export function activeBrokers(
  brokers: ScheduledBroker[],
  clock: ScheduleClock,
) {
  const state = scheduleAt(clock);
  if (!state.acceptingClients) return [];
  return brokers.filter(
    (b) =>
      !b.leave_after_service && (state.preOpening || b.shift === state.shift),
  );
}

// The application installs its clock once. Standalone legacy callers retain their API.
let currentClock: ScheduleClock | undefined;
export function setScheduleClock(clock: ScheduleClock | undefined) {
  currentClock = clock;
}
export function getScheduleClock() {
  return currentClock;
}
