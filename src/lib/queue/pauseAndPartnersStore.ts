import { dbReady, supabase } from "../supabase";
import {
  admissionPlan,
  companyLine,
  exclusionPlan,
  pauseExpired,
  returnFromPause,
  scopeOf,
  startPause,
  partnerIntake,
  partnerReservation,
  type PauseBroker,
  type PauseClock,
  type PausePlan,
  type PartnerIntake,
  type PartnerReservation,
} from "./pauseAndPartners";

async function checked(query: PromiseLike<{ error: unknown }>) {
  const result = await query;
  if (result.error) throw result.error;
}
export type PauseAction = "pause" | "return" | "excuse" | "checkin" | "expire";
export async function actOnPause(
  id: string,
  action: PauseAction,
  clock: PauseClock,
  managerName = "",
) {
  await dbReady;
  if (action === "excuse" && !managerName.trim())
    throw new Error(
      "Informe o nome do Gerente do Plantão responsável pelo abono.",
    );
  if (typeof supabase.rpc === "function") {
    await checked(
      supabase.rpc("apply_pause_action", {
        target_id: id,
        action,
        at_time: clock.at,
        shift_name: clock.shift,
        manager_name: managerName.trim() || null,
      }),
    );
    return;
  }
  const { data, error } = await supabase.from("brokers").select("*");
  if (error) throw error;
  const brokers = (data ?? []) as PauseBroker[];
  let broker = brokers.find((b) => b.id === id);
  if (!broker) throw new Error("Corretor não encontrado.");
  let plan: PausePlan;
  if (action === "pause") plan = startPause(broker, brokers, clock);
  else if (action === "expire") plan = exclusionPlan(broker, clock);
  else if (action === "checkin" &&
    (!broker.pause_started_at || broker.pause_scope !== scopeOf(clock))) {
    if (
      broker.presence_status === "presente" &&
      broker.arrived_at &&
      broker.shift === clock.shift &&
      scopeOf({ at: broker.arrived_at, shift: clock.shift }) === scopeOf(clock)
    )
      return;
    plan = { patch: { ...admissionPlan(broker, clock), pause_started_at: null, pause_scope: null, manager_excused: false } };
    if (
      !plan.patch.only_own_referrals &&
      (broker.sorteio_order == null ||
        broker.shift !== clock.shift ||
        !broker.arrived_at ||
        scopeOf({ at: broker.arrived_at, shift: clock.shift }) !==
          scopeOf(clock))
    ) {
      plan.patch.sorteio_order =
        Math.max(
          0,
          ...companyLine(brokers, { ...broker, shift: clock.shift }).map(
            (b) => b.sorteio_order ?? 0,
          ),
        ) + 1;
      plan.patch.inverse_order =
        Math.max(0, ...brokers.map((b) => b.inverse_order ?? 0)) + 1;
    }
  } else {
    if (action === "excuse") {
      if (!broker.pause_started_at && broker.restriction_reason !== "pause")
        throw new Error("Não há pausa a abonar.");
      if (broker.pause_scope !== scopeOf(clock))
        throw new Error("O abono deve corresponder ao turno da pausa.");
      // A returned excluded broker retains the original start in the evasion log.
      if (!broker.pause_started_at) {
        const logs = await supabase
          .from("pause_audit")
          .select("*")
          .eq("broker_id", id)
          .eq("scope", scopeOf(clock))
          .eq("event", "evasion")
          .order("occurred_at", { ascending: false })
          .limit(1);
        broker = {
          ...broker,
          pause_started_at: logs.data?.[0]?.pause_started_at,
        };
      }
      broker = { ...broker, manager_excused: true };
      const logId = `${id}:${broker.pause_scope}:${broker.pause_started_at}:excuse`;
      const old = await supabase
        .from("pause_audit")
        .select("id")
        .eq("id", logId)
        .maybeSingle();
      if (!old.data)
        await checked(
          supabase
            .from("pause_audit")
            .insert({
              id: logId,
              broker_id: id,
              event: "excuse",
              scope: scopeOf(clock),
              pause_started_at: broker.pause_started_at,
              occurred_at: clock.at,
              manager_name: managerName.trim(),
            }),
        );
    }
    plan = returnFromPause(broker, brokers, clock);
    if (action === "excuse") plan.patch.manager_excused = true;
  }
  if (plan.logEvasion) {
    const logId = `${id}:${broker.pause_started_at}:evasion`;
    const old = await supabase
      .from("pause_audit")
      .select("id")
      .eq("id", logId)
      .maybeSingle();
    if (!old.data)
      await checked(
        supabase
          .from("pause_audit")
          .insert({
            id: logId,
            broker_id: id,
            event: "evasion",
            scope: scopeOf(clock),
            pause_started_at: broker.pause_started_at,
            occurred_at: clock.at,
          }),
      );
  }
  if (plan.directOrder)
    plan.patch.sorteio_order = plan.directOrder.indexOf(id) + 1;
  if (plan.directOrder)
    for (const [index, brokerId] of plan.directOrder.entries())
      await checked(
        supabase
          .from("brokers")
          .update({ sorteio_order: index + 1 })
          .eq("id", brokerId),
      );
  await checked(supabase.from("brokers").update(plan.patch).eq("id", id));
}

export async function enforcePauses(clock: PauseClock) {
  await dbReady;
  const { data, error } = await supabase.from("brokers").select("*");
  if (error) throw error;
  for (const broker of (data ?? []) as PauseBroker[]) {
    if (pauseExpired(broker, clock))
      await actOnPause(broker.id, "expire", clock);
    // Mirror the restriction trigger in the local simulator after Stage 1 completion.
    if (
      typeof supabase.rpc !== "function" &&
      broker.only_own_referrals &&
      broker.attendance_status === "livre"
    )
      await checked(
        supabase
          .from("brokers")
          .update({
            attendance_status: "apenas_indicacao",
            sorteio_order: null,
            inverse_order: null,
            merit_priority_return: false,
          })
          .eq("id", broker.id),
      );
  }
}
export async function resetPauseState() {
  await checked(
    supabase
      .from("brokers")
      .update({
        pause_started_at: null,
        pause_scope: null,
        only_own_referrals: false,
        restriction_reason: null,
        restriction_scope: null,
        manager_excused: false,
      })
      .neq("id", "00000000-0000-0000-0000-000000000000"),
  );
}

export async function createPartnerIntake(
  input: Omit<PartnerIntake, "manager_status" | "created_at">,
) {
  const intake = partnerIntake(input);
  await dbReady;
  const old = await supabase
    .from("external_partner_intakes")
    .select("id")
    .eq("id", intake.id)
    .maybeSingle();
  if (old.error) throw old.error;
  if (!old.data)
    await checked(supabase.from("external_partner_intakes").insert(intake));
  return intake;
}
export async function reservePartnerUnit(
  intakeId: string,
  unit: string,
): Promise<PartnerReservation> {
  const reservation = partnerReservation(intakeId, unit);
  await dbReady;
  if (typeof supabase.rpc === "function") {
    const { data, error } = await supabase.rpc("reserve_partner_unit", {
      intake: intakeId,
      unit: reservation.unit_reference,
    });
    if (error) throw error;
    return data as PartnerReservation;
  }
  const old = await supabase
    .from("external_partner_reservations")
    .select("*")
    .eq("intake_id", intakeId)
    .maybeSingle();
  if (old.error) throw old.error;
  if (old.data) return old.data as PartnerReservation;
  const intake = await supabase
    .from("external_partner_intakes")
    .select("id")
    .eq("id", intakeId)
    .single();
  if (intake.error || !intake.data) throw new Error("Parceria não encontrada.");
  await checked(
    supabase.from("external_partner_reservations").insert(reservation),
  );
  return reservation;
}
export async function savePartnerSale(
  reservationId: string,
  name: string,
  phone: string,
) {
  const reservation = await supabase
    .from("external_partner_reservations")
    .select("id,unit_reference")
    .eq("id", reservationId)
    .single();
  if (reservation.error || !reservation.data?.unit_reference)
    throw new Error(
      "Registre a reserva da unidade antes dos demais dados do cliente.",
    );
  await checked(
    supabase
      .from("external_partner_reservations")
      .update({ customer_full_name: name.trim(), customer_phone: phone.trim() })
      .eq("id", reservationId),
  );
}
