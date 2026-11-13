import { supabase, dbReady, type Broker, type Agency } from "../supabase";
import {
  scheduleAt,
  enrolledForAfternoon,
  transitionBroker,
  closingPatch,
  type ScheduleClock,
  type ScheduledBroker,
  type ShiftDraw,
} from "./shiftSchedule";

type Event = {
  id: string;
  schedule_data: ShiftDraw | null;
  shift: "manha" | "tarde";
  status: string;
};
async function checked(query: PromiseLike<{ error: unknown }>) {
  const result = await query;
  if (result.error) throw result.error;
}
export function makeDraw(brokers: Broker[], random = Math.random): ShiftDraw {
  const shuffle = (rows: Broker[]) => {
    const copy = rows.map((b) => b.id);
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const viva = shuffle(brokers.filter((b) => b.agency === "Viva Imóveis"));
  const nobre = shuffle(brokers.filter((b) => b.agency === "Casa Nobre"));
  const firstAgency: Agency = random() < 0.5 ? "Viva Imóveis" : "Casa Nobre";
  const first = firstAgency === "Viva Imóveis" ? viva : nobre;
  const second = firstAgency === "Viva Imóveis" ? nobre : viva;
  const combined: string[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i]) combined.push(first[i]);
    if (second[i]) combined.push(second[i]);
  }
  return { viva, nobre, inverse: combined.reverse(), firstAgency };
}

async function applyEvent(
  clock: ScheduleClock,
  action: string,
  draw: ShiftDraw | null,
  brokers: ScheduledBroker[],
) {
  if (typeof supabase.rpc === "function") {
    await checked(
      supabase.rpc("apply_shift_schedule", { day: clock.date, action, draw }),
    );
    return;
  }
  // The in-memory simulator uses the same decisions as the database transaction.
  const id = `schedule_${clock.date}_${action}`;
  const { data: existing } = await supabase
    .from("plantao_sessions")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existing) return;
  if (action === "morning_activate" && draw) {
    for (const b of brokers
      .filter(
        (b) =>
          !b.is_external_partner &&
          b.shift === "manha" &&
          b.presence_status !== "ausente" &&
          b.arrived_at,
      )
      .sort((a, b) => Date.parse(a.arrived_at!) - Date.parse(b.arrived_at!))) {
      const direct = b.agency === "Viva Imóveis" ? draw.viva : draw.nobre;
      if (!direct.includes(b.id)) {
        direct.push(b.id);
        draw.inverse.push(b.id);
      }
    }
    await checked(
      supabase
        .from("plantao_sessions")
        .update({ schedule_data: draw })
        .eq("id", `schedule_${clock.date}_morning`),
    );
    for (const b of brokers) {
      const rank = (
        b.agency === "Viva Imóveis" ? draw.viva : draw.nobre
      ).indexOf(b.id);
      if (rank >= 0)
        await checked(
          supabase
            .from("brokers")
            .update({
              sorteio_order: rank + 1,
              inverse_order: draw.inverse.indexOf(b.id) + 1,
              shift: "manha",
              preserve_shift_position: [
                "em_atendimento",
                "em_mesa",
                "decorado",
              ].includes(b.attendance_status),
            })
            .eq("id", b.id),
        );
    }
  }
  if (action === "activate" && draw) {
    for (const b of brokers.filter((b) => !b.is_external_partner)) {
      const patch = transitionBroker(b, draw, clock.date);
      await checked(supabase.from("brokers").update(patch).eq("id", b.id));
      if (patch.shift === "tarde")
        await checked(
          supabase
            .from("queue_entries")
            .update({ shift: "tarde" })
            .eq("broker_id", b.id)
            .in("queue_status", ["chamando", "em_atendimento"]),
        );
    }
    await checked(
      supabase
        .from("queue_entries")
        .update({ shift: "tarde" })
        .eq("shift", "manha")
        .eq("queue_status", "aguardando"),
    );
    await checked(
      supabase
        .from("plantao_sessions")
        .update({ status: "ended" })
        .eq("status", "active"),
    );
  }
  if (action === "close")
    for (const b of brokers)
      await checked(
        supabase.from("brokers").update(closingPatch(b)).eq("id", b.id),
      );
  await checked(
    supabase
      .from("plantao_sessions")
      .insert({
        id,
        schedule_data: draw,
        shift: action.startsWith("morning") ? "manha" : "tarde",
        status: ["morning_activate", "activate"].includes(action)
          ? "active"
          : "ended",
        plantao_date: clock.date,
      }),
  );
}

export async function advanceSchedule(
  clock: ScheduleClock,
): Promise<ShiftDraw | null> {
  await dbReady;
  const state = scheduleAt(clock);
  const { data: rows, error } = await supabase.from("brokers").select("*");
  if (error) throw error;
  const brokers = (rows ?? []) as ScheduledBroker[];
  const sessions = await supabase
    .from("plantao_sessions")
    .select("*")
    .eq("plantao_date", clock.date);
  if (sessions.error) throw sessions.error;
  const events = (sessions.data ?? []) as Event[];
  const has = (action: string) =>
    events.some((e) => e.id === `schedule_${clock.date}_${action}`);
  let morning =
    events.find((e) => e.id === `schedule_${clock.date}_morning`)
      ?.schedule_data ?? null;
  if (state.morningDrawDue && !has("morning")) {
    const eligible = brokers.filter(
      (b) =>
        !b.is_external_partner &&
        b.shift === "manha" &&
        b.presence_status !== "ausente" &&
        !!b.arrived_at,
    );
    const onTime = eligible.filter(
      (b) =>
        new Date(b.arrived_at!).toLocaleTimeString("sv-SE", {
          timeZone: "America/Sao_Paulo",
        }) <= "08:45:59",
    );
    const draw = makeDraw(onTime);
    for (const b of eligible
      .filter((b) => !onTime.includes(b))
      .sort((a, b) => Date.parse(a.arrived_at!) - Date.parse(b.arrived_at!))) {
      (b.agency === "Viva Imóveis" ? draw.viva : draw.nobre).push(b.id);
      draw.inverse.push(b.id);
    }
    morning = draw;
    await applyEvent(clock, "morning", draw, brokers);
  }
  if (clock.seconds >= 9 * 3600 && !has("morning_activate") && morning)
    await applyEvent(clock, "morning_activate", morning, brokers);
  let afternoon =
    events.find((e) => e.id === `schedule_${clock.date}_afternoon`)
      ?.schedule_data ?? null;
  if (state.afternoonDrawDue && !has("afternoon")) {
    afternoon = makeDraw(
      brokers.filter(
        (b) => !b.is_external_partner && enrolledForAfternoon(b, clock.date),
      ),
    );
    await applyEvent(clock, "afternoon", afternoon, brokers);
  }
  if (state.afternoonActive && !has("activate") && afternoon)
    await applyEvent(clock, "activate", afternoon, brokers);
  if (state.closed && !has("close"))
    await applyEvent(clock, "close", null, brokers);
  // Mirror the completion trigger for the local simulator without changing Stage 1.
  if (typeof supabase.rpc !== "function") {
    for (const b of brokers.filter((b) => b.attendance_status === "livre")) {
      const activeDraw = state.afternoonActive ? afternoon : morning;
      if (b.preserve_shift_position && activeDraw) {
        const rank = (
          b.agency === "Viva Imóveis" ? activeDraw.viva : activeDraw.nobre
        ).indexOf(b.id);
        await checked(
          supabase
            .from("brokers")
            .update({
              sorteio_order: rank + 1,
              inverse_order: activeDraw.inverse.indexOf(b.id) + 1,
              preserve_shift_position: false,
            })
            .eq("id", b.id),
        );
      }
      if (b.leave_after_service)
        await checked(
          supabase
            .from("brokers")
            .update({ ...closingPatch(b), leave_after_service: false })
            .eq("id", b.id),
        );
    }
  }
  return state.coexistence ? afternoon : null;
}

export async function enrollAfternoon(brokerId: string, clock: ScheduleClock) {
  if (!scheduleAt(clock).afternoonEnrollment)
    throw new Error("Inscrição da tarde encerrada.");
  const h = String(Math.floor(clock.seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor(clock.seconds / 60) % 60).padStart(2, "0");
  const s = String(clock.seconds % 60).padStart(2, "0");
  const timestamp = `${clock.date}T${h}:${m}:${s}-03:00`;
  const { data: broker, error } = await supabase
    .from("brokers")
    .select("*")
    .eq("id", brokerId)
    .single();
  if (error) throw error;
  if (!broker) throw new Error("Corretor não encontrado.");
  const patch: Partial<ScheduledBroker> = { afternoon_enrolled_at: timestamp };
  if (broker.presence_status === "ausente")
    Object.assign(patch, {
      presence_status: "presente",
      shift: "tarde",
      arrived_at: timestamp,
    });
  await checked(supabase.from("brokers").update(patch).eq("id", brokerId));
}

export async function leaveOvertime(broker: Broker) {
  await checked(
    supabase.from("brokers").update(closingPatch(broker)).eq("id", broker.id),
  );
}
