import type { Broker, QueueEntry, VisitReason } from '../supabase';
import { activeBrokers, SHIFT_TIMES, type ScheduleClock, type ShiftDraw } from '../queue/shiftSchedule';
import { onlyOwn } from '../queue/pauseAndPartners';

type CoverageEntry = Pick<QueueEntry, 'queue_type' | 'visit'> & { reception_waiting?: boolean };

export function receptionRoster(brokers: Broker[], clock: ScheduleClock) {
  return activeBrokers(brokers, clock).filter(broker => !broker.is_external_partner);
}

export function busyReceptionIds(queue: QueueEntry[]) {
  return new Set(queue.flatMap(entry =>
    entry.broker_id && ['chamando', 'em_atendimento'].includes(entry.queue_status) ? [entry.broker_id] : [],
  ));
}

export function isReceptionFree(broker: Broker, busy: Set<string>) {
  return broker.presence_status === 'presente' && broker.attendance_status === 'livre' &&
    !broker.is_external_partner && !onlyOwn(broker) && !busy.has(broker.id);
}

export function receptionDestination(roster: Broker[], busy: Set<string>, ownerId: string | null) {
  if (roster.every(broker => broker.presence_status === 'ausente')) return 'direct';
  if (roster.some(broker => isReceptionFree(broker, busy) ||
    (broker.id === ownerId && broker.presence_status === 'presente' && onlyOwn(broker) &&
      ['livre', 'apenas_indicacao'].includes(broker.attendance_status) && !busy.has(broker.id)))) return 'normal';
  return 'waiting';
}

const coverageReasons: VisitReason[] = ['Retorno', 'Indicação', 'Indicação Presente', 'Indicação Ausente'];

export function resolveReceptionDispatch(
  entry: CoverageEntry,
  brokers: Broker[],
  clock: ScheduleClock,
  busy: Set<string>,
  runEngine: () => Broker | undefined,
) {
  const roster = receptionRoster(brokers, clock);
  const general = entry.reception_waiting;
  const reason = entry.visit?.visit_reason;
  const ownerId = (entry.visit as (QueueEntry['visit'] & { original_referred_broker_id?: string | null }))?.original_referred_broker_id ?? entry.visit?.referred_broker_id;
  const owner = reason && coverageReasons.includes(reason) ? brokers.find(broker => broker.id === ownerId) : undefined;
  const engineBroker = runEngine();
  const available = roster.filter(broker => isReceptionFree(broker, busy));
  if (owner && !owner.is_external_partner && owner.agency !== 'Externo') {
    if (engineBroker?.agency === owner.agency &&
        roster.some(broker => broker.id === engineBroker.id && broker.presence_status === 'presente') &&
        !busy.has(engineBroker.id) &&
        (isReceptionFree(engineBroker, busy) || (engineBroker.id === owner.id && onlyOwn(engineBroker) &&
          ['livre', 'apenas_indicacao'].includes(engineBroker.attendance_status)))) {
      return { broker: engineBroker, split: false };
    }
    const reversed = (candidates: Broker[]) => [...candidates].sort((a, b) =>
      clock.seconds < SHIFT_TIMES.morningStart
        ? (b.arrived_at ?? '').localeCompare(a.arrived_at ?? '') || b.id.localeCompare(a.id)
        : (b.sorteio_order ?? -1) - (a.sorteio_order ?? -1) || b.id.localeCompare(a.id),
    );
    const sameCompany = reversed(available.filter(broker => broker.agency === owner.agency));
    const local = sameCompany.find(broker => broker.id === owner.id) ??
      sameCompany.find(broker => broker.equipe === owner.equipe) ?? sameCompany[0];
    if (local) return { broker: local, split: false };
    const other = reversed(available.filter(broker => broker.agency !== owner.agency && broker.agency !== 'Externo'))[0];
    return { broker: other, split: Boolean(other) };
  }
  if (general) {
    const broker = available.find(person => person.id === engineBroker?.id) ?? available[0];
    return { broker, split: false };
  }
  return { broker: engineBroker, split: false };
}

export function visibleDraws(seconds: number, singleShift: boolean, morning: ShiftDraw | null, afternoon: ShiftDraw | null) {
  return {
    morning: seconds >= SHIFT_TIMES.morningDraw ? morning : null,
    afternoon: !singleShift && seconds >= SHIFT_TIMES.afternoonDraw ? afternoon : null,
  };
}

export async function copyQuickPhone(phone: string, copy: (value: string) => Promise<void>) {
  await copy(phone);
}
