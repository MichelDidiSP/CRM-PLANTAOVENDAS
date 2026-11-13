import type { Broker, QueueEntry } from '../supabase';

export function isProtectedAttendance(entry: QueueEntry): boolean {
  return entry.queue_type === 'geral' && (entry.visit?.visit_reason === 'Retorno' ||
    entry.visit?.visit_reason.startsWith('Indicação') === true);
}

export function firstFree(line: Broker[], freeIds: Set<string>): Broker | undefined {
  return line.find(broker => freeIds.has(broker.id));
}

export function reverseCoverage(brokers: Broker[], owner: Broker, excluded: Set<string>): Broker | undefined {
  const available = brokers.filter(b => b.agency === owner.agency && !b.is_external_partner &&
    b.presence_status === 'presente' && b.attendance_status === 'livre' && !excluded.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0));
  return available.find(b => b.equipe === owner.equipe) ?? available[0];
}

export function meritCandidates(line: Broker[], selected: Broker, entries: QueueEntry[]): Broker[] {
  const ordered = [...line].filter(b => b.agency === selected.agency)
    .sort((a, b) => (a.sorteio_order ?? 999999) - (b.sorteio_order ?? 999999));
  return ordered.slice(0, ordered.findIndex(b => b.id === selected.id)).filter(b =>
    b.presence_status === 'presente' && entries.some(e => e.broker_id === b.id &&
      e.queue_status === 'em_atendimento' && isProtectedAttendance(e)));
}

export function completionPatch(broker: Broker, entry: QueueEntry, clickedAt: string): Partial<Broker> {
  const patch: Partial<Broker> = { attendance_status: 'livre', last_status_update: clickedAt,
    merit_priority_return: false };
  const order = new Date(clickedAt).getTime();
  if (entry.queue_type === 'decorado') patch.inverse_order = order;
  else if (isProtectedAttendance(entry)) {
    if (broker.merit_priority_return) patch.sorteio_order = -order;
  } else if (entry.queue_type === 'geral' && entry.visit?.visit_reason === 'Primeira visita') {
    patch.sorteio_order = order;
  }
  return patch;
}
