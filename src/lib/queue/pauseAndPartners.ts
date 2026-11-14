import type { Broker, QueueType, Shift } from "../supabase";

export const CONTINUOUS_PAUSE_LIMIT_MS = 120 * 60 * 1000;
export type PauseBroker = Broker & {
  pause_started_at?: string | null;
  pause_exit_index?: number | null;
  pause_exit_order?: number | null;
  pause_inverse_order?: number | null;
  pause_direct_snapshot?: string[];
  pause_scope?: string | null;
  manager_excused?: boolean;
  only_own_referrals?: boolean;
  restriction_reason?: "pause" | "late" | null;
  restriction_scope?: string | null;
};
export type PauseClock = { at: string; shift: Shift };
export type PausePlan = {
  patch: Partial<PauseBroker>;
  directOrder?: string[];
  logEvasion?: boolean;
};

export function scopeOf(clock: PauseClock): string {
  const date = new Date(clock.at).toLocaleDateString("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
  return `${date}:${clock.shift}`;
}
export function onlyOwn(broker: Broker): boolean {
  return (
    (broker as PauseBroker).only_own_referrals === true ||
    broker.attendance_status === "apenas_indicacao"
  );
}
export function afterAdmissionCutoff(clock: PauseClock): boolean {
  const time = new Date(clock.at).toLocaleTimeString("sv-SE", {
    timeZone: "America/Sao_Paulo",
  });
  return time > (clock.shift === "tarde" ? "14:30:00" : "09:30:00");
}
export function pauseElapsed(broker: PauseBroker, at: string): number {
  return broker.pause_started_at
    ? Math.max(0, Date.parse(at) - Date.parse(broker.pause_started_at))
    : 0;
}
export function pauseExpired(broker: PauseBroker, clock: PauseClock): boolean {
  return (
    !!broker.pause_started_at &&
    broker.pause_scope === scopeOf(clock) &&
    !broker.manager_excused &&
    pauseElapsed(broker, clock.at) > CONTINUOUS_PAUSE_LIMIT_MS
  );
}
export function companyLine(brokers: Broker[], broker: Broker): PauseBroker[] {
  return brokers
    .filter(
      (b) =>
        !b.is_external_partner &&
        b.agency === broker.agency &&
        b.shift === broker.shift &&
        b.sorteio_order != null &&
        !onlyOwn(b),
    )
    .sort(
      (a, b) => a.sorteio_order! - b.sorteio_order! || a.id.localeCompare(b.id),
    );
}
export function startPause(
  broker: PauseBroker,
  brokers: Broker[],
  clock: PauseClock,
): PausePlan {
  if (broker.is_external_partner)
    throw new Error("Parceria externa possui fluxo próprio.");
  if (broker.pause_started_at && broker.presence_status === "pausa")
    return { patch: {} };
  if (broker.presence_status !== "presente")
    throw new Error("Registre a presença antes de pausar.");
  if (
    ["em_mesa", "em_atendimento", "decorado"].includes(broker.attendance_status)
  )
    throw new Error("Finalize o atendimento antes de pausar.");
  const line = companyLine(brokers, broker).filter(
    (b) => b.presence_status === "presente",
  );
  return {
    patch: {
      presence_status: "pausa",
      pause_started_at: clock.at,
      pause_exit_index: line.findIndex((b) => b.id === broker.id) + 1,
      pause_exit_order: broker.sorteio_order,
      pause_inverse_order: broker.inverse_order,
      pause_direct_snapshot: line.map((b) => b.id),
      pause_scope: scopeOf(clock),
      manager_excused: false,
      last_status_update: clock.at,
    },
  };
}
export function exclusionPlan(
  broker: PauseBroker,
  clock: PauseClock,
): PausePlan {
  if (
    !pauseExpired(broker, clock) ||
    (broker.restriction_scope === scopeOf(clock) &&
      broker.restriction_reason === "pause")
  )
    return { patch: {} };
  return {
    logEvasion: true,
    patch: {
      only_own_referrals: true,
      restriction_reason:
        broker.restriction_reason === "late" ? "late" : "pause",
      restriction_scope: scopeOf(clock),
      sorteio_order: null,
      inverse_order: null,
      merit_priority_return: false,
      returning_from_pause: false,
      attendance_status: "apenas_indicacao",
    },
  };
}
export function returnFromPause(
  broker: PauseBroker,
  brokers: Broker[],
  clock: PauseClock,
): PausePlan {
  if (!broker.pause_started_at) return { patch: {} };
  const exclusion = exclusionPlan(broker, clock);
  const stillExcluded =
    broker.only_own_referrals &&
    broker.restriction_scope === scopeOf(clock) &&
    !broker.manager_excused;
  if (
    pauseExpired(broker, clock) ||
    stillExcluded ||
    broker.restriction_reason === "late"
  )
    return {
      ...exclusion,
      patch: {
        ...exclusion.patch,
        presence_status: "presente",
        pause_started_at: null,
        only_own_referrals: true,
        sorteio_order: null,
        inverse_order: null,
        attendance_status: "apenas_indicacao",
        merit_priority_return: false,
        last_status_update: clock.at,
      },
    };
  const line = companyLine(brokers, broker).filter((b) => b.id !== broker.id);
  const head = line.find(
    (b) => b.presence_status === "presente" && b.attendance_status === "livre",
  );
  const snapshot = broker.pause_direct_snapshot ?? [];
  const exitIndex = broker.pause_exit_index ?? 0;
  const headIndex = head ? snapshot.indexOf(head.id) + 1 : 0;
  const passed =
    !!head &&
    (headIndex >= exitIndex - 1 ||
      (broker.pause_exit_order != null &&
        head.sorteio_order! > broker.pause_exit_order));
  if (!passed && broker.sorteio_order != null)
    return {
      patch: {
        presence_status: "presente",
        attendance_status: "livre",
        pause_started_at: null,
        only_own_referrals: false,
        restriction_reason: null,
        restriction_scope: null,
        sorteio_order: broker.sorteio_order,
        inverse_order: broker.pause_inverse_order ?? broker.inverse_order,
        merit_priority_return: false,
        returning_from_pause: false,
        last_status_update: clock.at,
      },
    };
  const order = line.map((b) => b.id);
  if (passed && head) order.splice(order.indexOf(head.id) + 1, 0, broker.id);
  else {
    // Restore at the saved successor, retaining changes made by other brokers.
    const successor = snapshot
      .slice(exitIndex)
      .find((id) => order.includes(id));
    const position = successor
      ? order.indexOf(successor)
      : Math.min(Math.max(exitIndex - 1, 0), order.length);
    order.splice(position, 0, broker.id);
  }
  return {
    directOrder: order,
    patch: {
      presence_status: "presente",
      attendance_status: "livre",
      pause_started_at: null,
      only_own_referrals: false,
      restriction_reason: null,
      restriction_scope: null,
      inverse_order: broker.pause_inverse_order ?? broker.inverse_order,
      merit_priority_return: false,
      returning_from_pause: false,
      last_status_update: clock.at,
    },
  };
}
export function admissionPlan(
  broker: PauseBroker,
  clock: PauseClock,
): Partial<PauseBroker> {
  const sameRestriction =
    broker.only_own_referrals && broker.restriction_scope === scopeOf(clock);
  const restricted = sameRestriction || afterAdmissionCutoff(clock);
  return {
    presence_status: "presente",
    arrived_at: clock.at,
    shift: clock.shift,
    only_own_referrals: restricted,
    restriction_scope: restricted ? scopeOf(clock) : null,
    restriction_reason: sameRestriction
      ? broker.restriction_reason
      : restricted
        ? "late"
        : null,
    attendance_status: restricted ? "apenas_indicacao" : "livre",
    ...(restricted
      ? {
          sorteio_order: null,
          inverse_order: null,
          merit_priority_return: false,
        }
      : {}),
    last_status_update: clock.at,
  };
}

/** Project restricted brokers as unavailable to all legacy distribution helpers. */
export function distributionBrokers(
  brokers: Broker[],
  ownerId: string | null = null,
): Broker[] {
  return brokers.map((b) =>
    onlyOwn(b) && b.id !== ownerId
      ? { ...b, attendance_status: "apenas_indicacao" }
      : b,
  );
}
export function restrictedOwner(
  brokers: Broker[],
  ownerId: string | null,
  queueType: QueueType,
  excluded: Set<string>,
) {
  const owner = brokers.find((b) => b.id === ownerId);
  if (!owner || !onlyOwn(owner)) return null;
  const eligible =
    queueType === "geral" &&
    owner.presence_status === "presente" &&
    ["livre", "apenas_indicacao"].includes(owner.attendance_status) &&
    !excluded.has(owner.id);
  return {
    broker: eligible ? owner : undefined,
    agency: owner.agency,
    consumesVez: false,
    protectedPosition: true,
    source: "only_own_referrals",
  };
}

export type PartnerIntake = {
  id: string;
  partner_name: string;
  company: string;
  creci: string;
  client_first_name: string;
  arrival: "before_partner" | "accompanied";
  manager_target: "partnerships" | "general";
  manager_status: "pending" | "acknowledged";
  created_at?: string;
};
export function partnerIntake(
  input: Omit<PartnerIntake, "manager_status" | "created_at">,
): PartnerIntake {
  const result = {
    id: input.id,
    partner_name: input.partner_name.trim(),
    company: input.company.trim() || "Autônomo",
    creci: input.creci.trim(),
    client_first_name: input.client_first_name.trim(),
    arrival: input.arrival,
    manager_target: input.manager_target,
    manager_status: "pending" as const,
  };
  if (
    !result.partner_name ||
    !result.creci ||
    !result.client_first_name ||
    /\s/.test(result.client_first_name)
  )
    throw new Error(
      "Informe nome do parceiro, CRECI e apenas o primeiro nome do cliente.",
    );
  if (
    !["before_partner", "accompanied"].includes(result.arrival) ||
    !["partnerships", "general"].includes(result.manager_target)
  )
    throw new Error("Selecione a chegada e o gerente responsável.");
  return result;
}
export type PartnerReservation = {
  id: string;
  intake_id: string;
  unit_reference: string;
  commission_percent: 100;
  customer_full_name?: string;
  customer_phone?: string;
};
export function partnerReservation(
  intakeId: string,
  unit: string,
): PartnerReservation {
  if (!unit.trim())
    throw new Error("Informe a unidade para registrar a reserva.");
  return {
    id: crypto.randomUUID(),
    intake_id: intakeId,
    unit_reference: unit.trim(),
    commission_percent: 100,
  };
}
