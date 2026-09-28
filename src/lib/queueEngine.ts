import { supabase, dbReady, type Broker, type QueueEntry, type Visit, type VisitReason, type Agency, type QueueType, type PlantaoSession, type Shift } from './supabase';

const LATE_LIMIT_MANHA = 8 * 3600 + 45 * 60 + 59; // 08:45:59
const LATE_LIMIT_TARDE = 13 * 3600 + 45 * 60 + 59; // 13:45:59
export const SORTEIO_MANHA = 8 * 3600 + 46 * 60;  // 08:46:00
export const SORTEIO_TARDE = 13 * 3600 + 46 * 60; // 13:46:00
export const ATENDIMENTO_MANHA_START = 9 * 3600;       // 09:00:00 — roleta assumes command
export const ATENDIMENTO_TARDE_START = 14 * 3600;      // 14:00:00
export const BARRIER_MANHA = 9 * 3600 + 30 * 60;        // 09:30:00 — after this, check-in = Apenas Indicação
export const BARRIER_TARDE = 14 * 3600 + 30 * 60;       // 14:30:00

export function secondsSinceMidnight(date: Date): number {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

export function isLateForSort(arrivedAt: string | null, shift: Shift = 'manha'): boolean {
  if (!arrivedAt) return true;
  const arrived = new Date(arrivedAt);
  const limit = shift === 'manha' ? LATE_LIMIT_MANHA : LATE_LIMIT_TARDE;
  return secondsSinceMidnight(arrived) > limit;
}

export function isBeyondBarrier(simSeconds: number, shift: Shift = 'manha'): boolean {
  const barrier = shift === 'manha' ? BARRIER_MANHA : BARRIER_TARDE;
  return simSeconds >= barrier;
}

export function isApenasIndicacao(broker: Broker): boolean {
  return broker.attendance_status === 'apenas_indicacao';
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function formatPhoneDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return phone;
}

export function sanitizePhone(input: string): string {
  return input.replace(/\D/g, '');
}

export const AGENCIES: Agency[] = ['Viva Imóveis', 'Casa Nobre'];
export const REASONS: VisitReason[] = ['Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Visita ao Decorado'];

export const QUICK_REASONS: VisitReason[] = ['Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Visita ao Decorado', 'Indicação Presente', 'Indicação Ausente', 'Indicação Imobiliária'];
export const QUEUE_TYPES: QueueType[] = ['geral', 'decorado', 'parceria'];

/**
 * Temporal Divisor: determines which dispatch mode the system is in.
 * - 'arrival': pre-sorteio morning (before 08:46h) — pure arrival-order queue
 * - 'sorteio_manha': morning sorteio active (08:46h to 13:59h) — intercalated roleta
 * - 'pre_tarde': 13:00h to 13:59h — morning sorteio still governs, afternoon check-in opens
 * - 'sorteio_tarde': 14:00h+ — afternoon sorteio active
 */
export type DispatchMode = 'arrival' | 'sorteio_manha' | 'pre_tarde' | 'sorteio_tarde';

export function getDispatchMode(simSeconds: number): DispatchMode {
  if (simSeconds < SORTEIO_MANHA) return 'arrival';
  if (simSeconds >= SORTEIO_MANHA && simSeconds < TARDE_CHECKIN_OPEN_SECONDS) return 'sorteio_manha';
  if (simSeconds >= TARDE_CHECKIN_OPEN_SECONDS && simSeconds < TARDE_ATEND_START_SECONDS) return 'pre_tarde';
  return 'sorteio_tarde';
}

const TARDE_CHECKIN_OPEN_SECONDS = 13 * 3600;       // 13:00:00
const TARDE_ATEND_START_SECONDS = 14 * 3600;          // 14:00:00

/**
 * Is the system in pre-sorteio mode (arrival order, no roleta)?
 */
export function isArrivalOrderMode(simSeconds: number): boolean {
  return getDispatchMode(simSeconds) === 'arrival';
}

/**
 * Arrival-order dispatch lock: the roleta's sorteio fires at 08:46h but does NOT
 * take command of dispatch until 09:00h sharp. Between 08:46h and 08:59:59 the
 * motor still dispatches by arrival order (ponto timestamp), ignoring the sorteio.
 */
export function isArrivalOrderDispatchActive(simSeconds: number): boolean {
  if (simSeconds < ATENDIMENTO_MANHA_START) return true;
  if (simSeconds >= SORTEIO_TARDE && simSeconds < ATENDIMENTO_TARDE_START) return true;
  return false;
}

/**
 * Is the morning sorteio still governing the plantao (08:46h to 13:59h)?
 */
export function isManhaSorteioActive(simSeconds: number): boolean {
  const mode = getDispatchMode(simSeconds);
  return mode === 'sorteio_manha' || mode === 'pre_tarde';
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export type SorteioResult = {
  vivaBrokers: Broker[];
  nobreBrokers: Broker[];
  interleavedBrokers: Broker[];
  lateBrokers: Broker[];
  desempateWinner: Agency;
  sessionId: string;
  shift: Shift;
};

/**
 * Sorteio automático:
 * Manhã: às 08:46:00 | Tarde: às 13:46:00
 * 1. Pegar corretores presentes até o limite de check-in de cada imobiliária.
 * 2. Embaralhar cada lista (Fisher-Yates).
 * 3. Sorteio entre Empresas: define quem inicia a intercalação.
 * 4. Intercalar respeitando o vencedor.
 * 5. Atrasados entram no fim com tag "Atrasado".
 * 6. Persistir sorteio_order e criar plantao_session.
 */
export async function executeSorteio(brokers: Broker[], simSeconds: number, shift: Shift): Promise<SorteioResult | null> {
  const eligible = brokers.filter(
    (b) => !b.is_external_partner && b.agency !== 'Externo' && b.presence_status === 'presente' && b.shift === shift,
  );

  const onTime = eligible.filter((b) => !isLateForSort(b.arrived_at, shift));
  const late = eligible.filter((b) => isLateForSort(b.arrived_at, shift));

  const vivaOnTime = onTime.filter((b) => b.agency === 'Viva Imóveis');
  const nobreOnTime = onTime.filter((b) => b.agency === 'Casa Nobre');

  const shuffledViva = shuffleArray(vivaOnTime);
  const shuffledNobre = shuffleArray(nobreOnTime);

  const desempateWinner: Agency = Math.random() < 0.5 ? 'Viva Imóveis' : 'Casa Nobre';

  const first = desempateWinner === 'Viva Imóveis' ? shuffledViva : shuffledNobre;
  const second = desempateWinner === 'Viva Imóveis' ? shuffledNobre : shuffledViva;

  const interleaved: Broker[] = [];
  const maxLen = Math.max(first.length, second.length);
  for (let i = 0; i < maxLen; i++) {
    if (first[i]) interleaved.push(first[i]);
    if (second[i]) interleaved.push(second[i]);
  }

  const lateViva = late.filter((b) => b.agency === 'Viva Imóveis');
  const lateNobre = late.filter((b) => b.agency === 'Casa Nobre');
  const lateFirst = desempateWinner === 'Viva Imóveis' ? lateViva : lateNobre;
  const lateSecond = desempateWinner === 'Viva Imóveis' ? lateNobre : lateViva;
  const lateInterleaved: Broker[] = [];
  const maxLate = Math.max(lateFirst.length, lateSecond.length);
  for (let i = 0; i < maxLate; i++) {
    if (lateFirst[i]) lateInterleaved.push(lateFirst[i]);
    if (lateSecond[i]) lateInterleaved.push(lateSecond[i]);
  }

  const finalOrder = [...interleaved, ...lateInterleaved];
  const sessionId = `sorteio_${shift}_${Date.now()}`;

  // Direct queue: sorteio_order = 1, 2, 3... (intercalated order)
  // Inverse queue: inverse_order = mirrored from direct, then independently numbered
  // The inverse queue is the direct queue reversed and renumbered 1, 2, 3...
  // Late brokers are pushed to the END of BOTH queues via .push()
  const directOrder = [...interleaved, ...lateInterleaved];
  const inverseOrder = [...interleaved].reverse();
  // Late brokers go to the end of the inverse queue too, via .push()
  for (const b of lateInterleaved) inverseOrder.push(b);

  for (let i = 0; i < directOrder.length; i++) {
    await supabase
      .from('brokers')
      .update({ sorteio_order: i + 1, shift })
      .eq('id', directOrder[i].id);
  }
  for (let i = 0; i < inverseOrder.length; i++) {
    await supabase
      .from('brokers')
      .update({ inverse_order: i + 1 })
      .eq('id', inverseOrder[i].id);
  }

  await supabase.from('plantao_sessions').insert({
    id: sessionId,
    status: 'active',
    shift,
    last_called_agency: null,
  });

  await supabase
    .from('plantao_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .neq('id', sessionId);

  return {
    vivaBrokers: shuffledViva,
    nobreBrokers: shuffledNobre,
    interleavedBrokers: finalOrder,
    lateBrokers: lateInterleaved,
    desempateWinner,
    sessionId,
    shift,
  };
}

/**
 * Reiniciar plantão: limpa a fila atual, zera o relógio, coloca corretores como disponíveis.
 * NÃO apaga visitas (banco de clientes permanece intacto).
 */
export async function reiniciarPlantao(brokers: Broker[]): Promise<void> {
  await supabase.from('queue_entries').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  for (const broker of brokers) {
    await supabase
      .from('brokers')
      .update({
        sorteio_order: null,
        inverse_order: null,
        attendance_status: 'livre',
        presence_status: 'ausente',
        arrived_at: null,
        shift: null,
        afternoon_reserved: false,
        last_status_update: new Date().toISOString(),
      })
      .eq('id', broker.id);
  }

  await supabase
    .from('plantao_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('status', 'active');

  await supabase
    .from('visits')
    .update({ status: 'encerrado' })
    .in('status', ['aguardando', 'aguardando_chamada', 'em_atendimento']);
}

/**
 * Transição de turno às 14:00h:
 * 1. Limpa a fila da manhã (queue_entries com shift='manha' e status 'aguardando').
 * 2. Corretores em atendimento continuam — marcados com afternoon_reserved.
 * 3. Outros corretores voltam para novo check-in (presence_status='ausente', shift=null).
 */
export async function transitionToAfternoon(brokers: Broker[]): Promise<void> {
  // Encerrar sessões da manhã
  await supabase
    .from('plantao_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('shift', 'manha')
    .eq('status', 'active');

  // Limpar fila da manhã (apenas aguardando — em atendimento e concluídos permanecem para auditoria)
  await supabase
    .from('queue_entries')
    .delete()
    .eq('shift', 'manha')
    .eq('queue_status', 'aguardando');

  for (const broker of brokers) {
    if (broker.is_external_partner) continue;
    const inAttendance = broker.attendance_status === 'em_mesa' || broker.attendance_status === 'decorado';
    if (inAttendance) {
      // Corretor continua em atendimento — vaga reservada na tarde
      await supabase
        .from('brokers')
        .update({ afternoon_reserved: true, shift: null })
        .eq('id', broker.id);
    } else {
      // Resetar para novo check-in
      await supabase
        .from('brokers')
        .update({
          presence_status: 'ausente',
          attendance_status: 'livre',
          arrived_at: null,
          sorteio_order: null,
          inverse_order: null,
          shift: null,
          afternoon_reserved: false,
          last_status_update: new Date().toISOString(),
        })
        .eq('id', broker.id);
    }
  }
}

/**
 * Intercalação Institucional Infinita:
 * Mantém A -> B -> A -> B... na fila geral.
 * Usa sorteio_order para ordenar dentro de cada agência.
 * Quando uma agência tem menos entries, a outra continua — mas a alternância
 * é reiniciada quando novos clientes da agência menor chegam.
 * Reentradas vão para o final ordenadas por reentry_at.
 */
export function interleaveQueue(entries: QueueEntry[], brokers: Broker[], lastCalledAgency?: Agency | null): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

  const viva = waiting.filter((e) => e.agency === 'Viva Imóveis').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));
  const nobre = waiting.filter((e) => e.agency === 'Casa Nobre').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));

  // Determinar quem começa: se a última chamada foi Viva, a próxima é Nobre, e vice-versa
  const startWithViva = lastCalledAgency ? lastCalledAgency !== 'Viva Imóveis' : true;

  const interleaved: QueueEntry[] = [];
  const first = startWithViva ? viva : nobre;
  const second = startWithViva ? nobre : viva;
  const maxLen = Math.max(first.length, second.length);
  for (let i = 0; i < maxLen; i++) {
    if (first[i]) interleaved.push(first[i]);
    if (second[i]) interleaved.push(second[i]);
  }

  return [...interleaved, ...sortedReentries];
}

export function reverseInterleaveQueue(entries: QueueEntry[], brokers: Broker[]): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  // Sort by inverse_order ascending — the inverse queue has its own independent numbering
  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

  // Separate on-time and late brokers based on inverse_order
  const lateIds = new Set(
    brokers
      .filter((b) => isLateForSort(b.arrived_at, b.shift ?? 'manha'))
      .map((b) => b.id),
  );

  const onTime = waiting
    .filter((e) => !e.broker_id || !lateIds.has(e.broker_id))
    .sort((a, b) => {
      const ba = brokers.find((br) => br.id === a.broker_id);
      const bb = brokers.find((br) => br.id === b.broker_id);
      return (ba?.inverse_order ?? 999_999) - (bb?.inverse_order ?? 999_999);
    });

  const late = waiting.filter((e) => e.broker_id && lateIds.has(e.broker_id));

  // On-time brokers sorted by inverse_order ascending, then late at the end via .push()
  const result: QueueEntry[] = [...onTime];
  result.push(...late);
  result.push(...sortedReentries);
  return result;
}

const PRIORITY_REASONS: VisitReason[] = ['Retorno', 'Indicação'];

function sortKey(entries: QueueEntry[], brokers: Broker[], entry: QueueEntry): number {
  const visit = entries.find((e) => e.id === entry.id)?.visit;
  const broker = brokers.find((b) => b.id === entry.broker_id);

  if (broker && isLateForSort(broker.arrived_at, broker.shift ?? 'manha')) return 999_999_000;

  if (broker && broker.sorteio_order != null) {
    const hasReferredBroker = visit?.referred_broker_id != null;
    const isPriority = visit != null && PRIORITY_REASONS.includes(visit.visit_reason) && hasReferredBroker;
    const priorityOffset = isPriority ? 0 : 500_000_000;
    return priorityOffset + broker.sorteio_order;
  }

  const hasReferredBroker = visit?.referred_broker_id != null;
  const isPriority = visit != null && PRIORITY_REASONS.includes(visit.visit_reason) && hasReferredBroker;
  const priorityOffset = isPriority ? 0 : 500_000_000;

  if (visit) return priorityOffset + new Date(visit.created_at).getTime();
  return priorityOffset + new Date(entry.created_at).getTime();
}

/**
 * Returns the first 'Livre' broker from a given agency, sorted by sorteio_order ascending.
 * Brokers with status 'Chamado', 'Em Atendimento', or 'Pausado' are skipped.
 */
export function nextBrokerFromAgency(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  const agencyBrokers = brokers
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => (a.sorteio_order ?? 999_999) - (b.sorteio_order ?? 999_999));

  return agencyBrokers[0];
}

/**
 * Picks the next broker for the general queue by scanning the FULL intercalated
 * queue top-to-bottom (sorted by sorteio_order ascending) and returning the
 * FIRST broker whose status is strictly 'Livre'.
 *
 * The sorteio_order already encodes the intercalation (1=Viva, 2=Nobre, 3=Viva...),
 * so scanning top-to-bottom naturally respects alternation. Brokers with status
 * 'Chamado', 'Em Atendimento', or 'Pausado' are skipped.
 */
export function nextBrokerForGeneralQueue(
  brokers: Broker[],
  lastCalledAgency: Agency | null,
  excludeIds: Set<string>,
): { broker: Broker | undefined; agency: Agency } {
  // Determine which agency's turn it is (opposite of last called, or sorteio start)
  let nextAgency: Agency;
  if (lastCalledAgency) {
    nextAgency = lastCalledAgency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  } else {
    const sorted = brokers
      .filter((b) => !b.is_external_partner && b.sorteio_order != null)
      .sort((a, b) => (a.sorteio_order ?? 0) - (b.sorteio_order ?? 0));
    nextAgency = sorted[0]?.agency ?? 'Viva Imóveis';
  }

  // Try the agency whose turn it is — find first Livre broker from that agency
  const broker = nextBrokerFromAgency(brokers, nextAgency, excludeIds);
  if (broker) return { broker, agency: broker.agency };

  // Caos: no Livre from that agency → transbord to the other agency
  const otherAgency: Agency = nextAgency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  const otherBroker = nextBrokerFromAgency(brokers, otherAgency, excludeIds);
  return { broker: otherBroker, agency: otherBroker?.agency ?? nextAgency };
}

/**
 * Pre-sorteio: picks the first available broker by arrival order (not sorteio).
 * Used for Vez Geral before 08:46h.
 */
export function nextBrokerByArrival(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  const agencyBrokers = brokers
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
    .sort((a, b) => {
      const aTime = a.arrived_at ? new Date(a.arrived_at).getTime() : Infinity;
      const bTime = b.arrived_at ? new Date(b.arrived_at).getTime() : Infinity;
      return aTime - bTime;
    });

  return agencyBrokers[0];
}

/**
 * Pre-sorteio: picks the first available broker by arrival order across ALL agencies.
 * 1st client calls 1st broker who arrived, 2nd calls 2nd, etc.
 */
export function nextBrokerByArrivalAnyAgency(brokers: Broker[], excludeIds: Set<string>): Broker | undefined {
  const available = brokers
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => {
      const aTime = a.arrived_at ? new Date(a.arrived_at).getTime() : Infinity;
      const bTime = b.arrived_at ? new Date(b.arrived_at).getTime() : Infinity;
      return aTime - bTime;
    });

  return available[0];
}

/**
 * Pre-sorteio inverse: picks the LAST available broker by arrival order.
 * Used for Visita ao Decorado before 08:46h (inverse queue = last to arrive).
 */
export function nextBrokerByArrivalInverse(brokers: Broker[], excludeIds: Set<string>): Broker | undefined {
  const available = brokers
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => {
      const aTime = a.arrived_at ? new Date(a.arrived_at).getTime() : -Infinity;
      const bTime = b.arrived_at ? new Date(b.arrived_at).getTime() : -Infinity;
      return bTime - aTime;
    });

  return available[0];
}

/**
 * Indicação Module 3 — Rule 2 & 3: pick the LAST available broker from an agency
 * (fim da fila atual). Used when the referred broker is absent, or when the
 * client only knows the agency brand.
 */
export function lastBrokerFromAgency(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  const agencyBrokers = brokers
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0));

  return agencyBrokers[0];
}

/**
 * Late check-in push: when a broker checks in after the sorteio (08:46h),
 * they are appended to the END of both queues independently via .push():
 * - Direct queue: sorteio_order = max(sorteio_order across ALL brokers) + 1
 * - Inverse queue: inverse_order = max(inverse_order across ALL brokers) + 1
 *
 * Both queues have independent numbering and are decoupled after the sorteio.
 */
export async function pushLateBrokerToQueues(brokerId: string, brokers: Broker[]): Promise<void> {
  const broker = brokers.find((b) => b.id === brokerId);
  if (!broker) return;

  const allDirect = brokers.filter((b) => !b.is_external_partner && b.sorteio_order != null);
  const maxDirect = allDirect.length > 0 ? Math.max(...allDirect.map((b) => b.sorteio_order ?? 0)) : 0;

  const allInverse = brokers.filter((b) => !b.is_external_partner && b.inverse_order != null);
  const maxInverse = allInverse.length > 0 ? Math.max(...allInverse.map((b) => b.inverse_order ?? 0)) : 0;

  await supabase
    .from('brokers')
    .update({
      sorteio_order: maxDirect + 1,
      inverse_order: maxInverse + 1,
    })
    .eq('id', brokerId);
}

/**
 * Hierarchical Transbordo for Indicação (Rule 2):
 * 1. Try the named broker if present and free.
 * 2. If absent, try someone from the SAME AGENCY who is present and free.
 *    (same agency = same team/gerente)
 * 3. If no one from same agency is available, try the OTHER agency
 *    (same diretoria = both agencies belong to the same corporate entity).
 * 4. Only after exhausting all corporate instances, fall back to the LAST
 *    available broker of the referred broker's agency (consome a vez normal).
 *
 * Returns the broker and whether the vez is consumed.
 */
export function resolveIndicacaoBroker(
  brokers: Broker[],
  referredBrokerId: string | null,
  excludeIds: Set<string>,
): { broker: Broker | undefined; consumesVez: boolean; source: 'named' | 'same_agency' | 'other_agency' | 'last_of_agency' } {
  if (!referredBrokerId) {
    return { broker: undefined, consumesVez: true, source: 'last_of_agency' };
  }

  const referred = brokers.find((b) => b.id === referredBrokerId);
  if (!referred) {
    return { broker: undefined, consumesVez: true, source: 'last_of_agency' };
  }

  // Step 1: Named broker is present and free (apenas_indicacao brokers CAN receive their own indicação)
  if (referred.presence_status === 'presente' && (referred.attendance_status === 'livre' || referred.attendance_status === 'apenas_indicacao') && !excludeIds.has(referred.id)) {
    return { broker: referred, consumesVez: false, source: 'named' };
  }

  // Step 2: Same agency (same team/gerente) — first available
  const sameAgency = nextBrokerFromAgency(brokers, referred.agency, excludeIds);
  if (sameAgency) {
    return { broker: sameAgency, consumesVez: true, source: 'same_agency' };
  }

  // Step 3: Other agency (same diretoria)
  const otherAgency: Agency = referred.agency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  const otherAgencyBroker = nextBrokerFromAgency(brokers, otherAgency, excludeIds);
  if (otherAgencyBroker) {
    return { broker: otherAgencyBroker, consumesVez: true, source: 'other_agency' };
  }

  // Step 4: Last available broker of referred broker's agency (consome vez normal)
  const lastBroker = lastBrokerFromAgency(brokers, referred.agency, excludeIds);
  return { broker: lastBroker, consumesVez: true, source: 'last_of_agency' };
}

/**
 * Unified dispatch: picks the next broker for any queue type based on the current dispatch mode.
 * - Pre-sorteio (arrival): Vez Geral uses arrival order, Decorado uses inverse arrival order.
 * - Pós-sorteio: Vez Geral uses intercalation, Decorado uses inverse sorteio.
 * - Indicação: uses hierarchical transbordo.
 */
export function dispatchBroker(
  brokers: Broker[],
  queueType: QueueType,
  simSeconds: number,
  excludeIds: Set<string>,
  lastCalledAgency: Agency | null,
  referredBrokerId: string | null,
): { broker: Broker | undefined; agency: Agency; consumesVez: boolean } {
  const isPreSorteio = isArrivalOrderDispatchActive(simSeconds);

  // Indicação always uses hierarchical transbordo regardless of time
  if (referredBrokerId) {
    const result = resolveIndicacaoBroker(brokers, referredBrokerId, excludeIds);
    return {
      broker: result.broker,
      agency: result.broker?.agency ?? 'Viva Imóveis',
      consumesVez: result.consumesVez,
    };
  }

  if (queueType === 'parceria') {
    return { broker: undefined, agency: 'Externo', consumesVez: false };
  }

  if (queueType === 'decorado') {
    if (isPreSorteio) {
      const broker = nextBrokerByArrivalInverse(brokers, excludeIds);
      return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true };
    }
    const broker = nextBrokerFromInverseTop(brokers, excludeIds);
    return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true };
  }

  // Geral
  if (isPreSorteio) {
    const broker = nextBrokerByArrivalAnyAgency(brokers, excludeIds);
    return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true };
  }

  // Pós-sorteio: intercalation
  const { broker, agency } = nextBrokerForGeneralQueue(brokers, lastCalledAgency, excludeIds);
  return { broker, agency, consumesVez: true };
}

/**
 * Move broker to end of BOTH queues independently:
 * - Direct queue: sorteio_order = max(sorteio_order) + 1 among same-agency brokers
 * - Inverse queue: inverse_order = max(inverse_order) + 1 among ALL brokers (both agencies)
 *
 * The two queues are decoupled — each walks forward at its own pace.
 */
export async function moveBrokerToEndOfQueue(brokerId: string, brokers: Broker[]): Promise<void> {
  const broker = brokers.find((b) => b.id === brokerId);
  if (!broker) return;

  // Direct queue: move to end within the same agency
  const sameAgencyDirect = brokers.filter((b) => !b.is_external_partner && b.agency === broker.agency && b.sorteio_order != null);
  const maxDirect = sameAgencyDirect.length > 0 ? Math.max(...sameAgencyDirect.map((b) => b.sorteio_order ?? 0)) : 0;

  // Inverse queue: move to end across ALL brokers (independent numbering)
  const allInverse = brokers.filter((b) => !b.is_external_partner && b.inverse_order != null);
  const maxInverse = allInverse.length > 0 ? Math.max(...allInverse.map((b) => b.inverse_order ?? 0)) : 0;

  await supabase
    .from('brokers')
    .update({
      sorteio_order: maxDirect + 1,
      inverse_order: maxInverse + 1,
      last_status_update: new Date().toISOString(),
    })
    .eq('id', brokerId);
}

/**
 * Visita ao Decorado: picks the first available broker from the TOP of the
 * INVERSE queue. The inverse queue has its own independent numbering
 * (inverse_order: 1, 2, 3...) assigned at sorteio time and maintained
 * independently from the direct queue.
 * Late brokers are at the end (highest inverse_order).
 * Excludes brokers currently busy (calling, em_atendimento).
 */
export function nextBrokerFromInverseTop(brokers: Broker[], excludeIds: Set<string>): Broker | undefined {
  const present = brokers.filter(
    (b) => !b.is_external_partner && b.presence_status === 'presente' && !isApenasIndicacao(b) && !excludeIds.has(b.id),
  );

  // Sort by inverse_order ascending — the inverse queue's own independent numbering
  const sorted = present
    .filter((b) => b.inverse_order != null)
    .sort((a, b) => (a.inverse_order ?? 999_999) - (b.inverse_order ?? 999_999));

  // Brokers without inverse_order (e.g. late check-ins that haven't been pushed yet)
  // go to the absolute end
  const noOrder = present.filter((b) => b.inverse_order == null);
  const fullQueue: Broker[] = [...sorted];
  for (const b of noOrder) fullQueue.push(b);

  // Agency turn: determined by the top of the inverse queue
  const topBroker = fullQueue[0];
  if (!topBroker) return undefined;
  const targetAgency = topBroker.agency;

  // Find first Livre broker from that agency
  const sameAgency = fullQueue.find(
    (b) => b.agency === targetAgency && b.attendance_status === 'livre',
  );
  if (sameAgency) return sameAgency;

  // Caos: no Livre from that agency → transbord to the other
  const otherAgency: Agency = targetAgency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  return fullQueue.find(
    (b) => b.agency === otherAgency && b.attendance_status === 'livre',
  );
}

export function nextBrokerFromInverseQueue(brokers: Broker[], sortedQueue: QueueEntry[]): Broker | undefined {
  const reversed = [...sortedQueue].reverse();
  for (const entry of reversed) {
    if (entry.broker_id) {
      const broker = brokers.find((b) => b.id === entry.broker_id);
      if (broker && !broker.is_external_partner && broker.presence_status === 'presente' && broker.attendance_status === 'livre' && !isApenasIndicacao(broker)) {
        return broker;
      }
    }
  }
  return brokers.find(
    (b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b),
  );
}

export async function fetchAll() {
  await dbReady;
  const [brokersRes, visitsRes, queueRes, sessionsRes] = await Promise.all([
    supabase.from('brokers').select('*').order('created_at', { ascending: true }),
    supabase.from('visits').select('*').order('created_at', { ascending: true }),
    supabase.from('queue_entries').select('*, visit:visits(*), broker:brokers(*)').order('created_at', { ascending: true }),
    supabase.from('plantao_sessions').select('*').order('started_at', { ascending: false }).limit(1),
  ]);

  return {
    brokers: (brokersRes.data ?? []) as Broker[],
    visits: (visitsRes.data ?? []) as Visit[],
    queue: (queueRes.data ?? []) as QueueEntry[],
    activeSession: (sessionsRes.data?.[0] ?? null) as PlantaoSession | null,
    error: brokersRes.error || visitsRes.error || queueRes.error || sessionsRes.error,
  };
}
