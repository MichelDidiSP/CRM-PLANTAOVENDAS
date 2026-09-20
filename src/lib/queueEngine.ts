import { supabase, type Broker, type QueueEntry, type Visit, type VisitReason, type Agency, type QueueType, type PlantaoSession, type Shift } from './supabase';

const LATE_LIMIT_MANHA = 8 * 3600 + 45 * 60 + 59; // 08:45:59
const LATE_LIMIT_TARDE = 13 * 3600 + 45 * 60 + 59; // 13:45:59
export const SORTEIO_MANHA = 8 * 3600 + 46 * 60;  // 08:46:00
export const SORTEIO_TARDE = 13 * 3600 + 46 * 60; // 13:46:00

export function secondsSinceMidnight(date: Date): number {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

export function isLateForSort(arrivedAt: string | null, shift: Shift = 'manha'): boolean {
  if (!arrivedAt) return true;
  const arrived = new Date(arrivedAt);
  const limit = shift === 'manha' ? LATE_LIMIT_MANHA : LATE_LIMIT_TARDE;
  return secondsSinceMidnight(arrived) > limit;
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

  for (let i = 0; i < finalOrder.length; i++) {
    await supabase
      .from('brokers')
      .update({ sorteio_order: i + 1, shift })
      .eq('id', finalOrder[i].id);
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
  return [...interleaveQueue(entries, brokers)].reverse();
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
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
    .sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999));

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
  _lastCalledAgency: Agency | null,
  excludeIds: Set<string>,
): { broker: Broker | undefined; agency: Agency } {
  const available = brokers
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
    .sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999));

  const broker = available[0];
  return { broker, agency: broker?.agency ?? 'Viva Imóveis' };
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
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
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
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
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
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0));

  return agencyBrokers[0];
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

  // Step 1: Named broker is present and free
  if (referred.presence_status === 'presente' && referred.attendance_status === 'livre' && !excludeIds.has(referred.id)) {
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
  const mode = getDispatchMode(simSeconds);
  const isPreSorteio = mode === 'arrival';

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
 * Move broker to end of queue: assigns the highest sorteio_order + 1 among
 * same-agency brokers, effectively sending them to the back of their agency's
 * internal queue. This makes the fila walk forward.
 */
export async function moveBrokerToEndOfQueue(brokerId: string, brokers: Broker[]): Promise<void> {
  const broker = brokers.find((b) => b.id === brokerId);
  if (!broker) return;
  const sameAgency = brokers.filter((b) => !b.is_external_partner && b.agency === broker.agency && b.sorteio_order != null);
  const maxOrder = sameAgency.length > 0 ? Math.max(...sameAgency.map((b) => b.sorteio_order ?? 0)) : 0;
  await supabase
    .from('brokers')
    .update({ sorteio_order: maxOrder + 1, last_status_update: new Date().toISOString() })
    .eq('id', brokerId);
}

/**
 * Visita ao Decorado: picks the first available broker from the TOP of the
 * INVERSE queue (which is the LAST broker of the general queue by sorteio_order).
 * The inverse queue runs in the opposite direction — the last broker in the
 * general queue is the first to be called for decorado.
 * Excludes brokers currently busy (calling, em_atendimento).
 */
export function nextBrokerFromInverseTop(brokers: Broker[], excludeIds: Set<string>): Broker | undefined {
  const available = brokers
    .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre' && !excludeIds.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 999) - (a.sorteio_order ?? 999));
  return available[0];
}

export function nextBrokerFromInverseQueue(brokers: Broker[], sortedQueue: QueueEntry[]): Broker | undefined {
  const reversed = [...sortedQueue].reverse();
  for (const entry of reversed) {
    if (entry.broker_id) {
      const broker = brokers.find((b) => b.id === entry.broker_id);
      if (broker && !broker.is_external_partner && broker.presence_status === 'presente' && broker.attendance_status === 'livre') {
        return broker;
      }
    }
  }
  return brokers.find(
    (b) => !b.is_external_partner && b.presence_status === 'presente' && b.attendance_status === 'livre',
  );
}

export async function fetchAll() {
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
