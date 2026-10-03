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

export const EQUIPES_BY_AGENCY: Record<Exclude<Agency, 'Externo'>, string[]> = {
  'Viva Imóveis': ['Equipe Carlos', 'Equipe Rodrigo', 'Equipe Externa A'],
  'Casa Nobre': ['Equipe Marcos', 'Equipe Tatiana', 'Equipe Externa B'],
};

export function equipesForAgency(agency: Agency): string[] {
  if (agency === 'Externo') return [];
  return EQUIPES_BY_AGENCY[agency] ?? [];
}

const ROTATION_KEY = 'plantao_company_rotation_index';
const DRAW_ORDER_KEY = 'plantao_company_draw_order';

export function getCompanyRotationIndex(): number {
  try {
    const stored = localStorage.getItem(ROTATION_KEY);
    return stored ? parseInt(stored, 10) : 0;
  } catch { return 0; }
}

export function setCompanyRotationIndex(index: number): void {
  try { localStorage.setItem(ROTATION_KEY, String(index)); } catch { /* ignore */ }
}

export function incrementCompanyRotationIndex(totalCompanies: number): void {
  const next = (getCompanyRotationIndex() + 1) % totalCompanies;
  setCompanyRotationIndex(next);
}

export function getCompanyDrawOrder(): Agency[] {
  try {
    const stored = localStorage.getItem(DRAW_ORDER_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return AGENCIES;
}

export function setCompanyDrawOrder(order: Agency[]): void {
  try { localStorage.setItem(DRAW_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
}

export function resetCompanyRotation(): void {
  setCompanyRotationIndex(0);
  try { localStorage.removeItem(DRAW_ORDER_KEY); } catch { /* ignore */ }
}

export const QUICK_REASONS: VisitReason[] = ['Primeira visita', 'Retorno', 'Indicação', 'Parceria', 'Visita ao Decorado', 'Indicação Presente', 'Indicação Ausente', 'Indicação Imobiliária'];
export const QUEUE_TYPES: QueueType[] = ['geral', 'decorado', 'parceria'];

export type DispatchMode = 'arrival' | 'sorteio_manha' | 'pre_tarde' | 'sorteio_tarde';

export function getDispatchMode(simSeconds: number): DispatchMode {
  if (simSeconds < SORTEIO_MANHA) return 'arrival';
  if (simSeconds >= SORTEIO_MANHA && simSeconds < TARDE_CHECKIN_OPEN_SECONDS) return 'sorteio_manha';
  if (simSeconds >= TARDE_CHECKIN_OPEN_SECONDS && simSeconds < TARDE_ATEND_START_SECONDS) return 'pre_tarde';
  return 'sorteio_tarde';
}

const TARDE_CHECKIN_OPEN_SECONDS = 13 * 3600;       // 13:00:00
const TARDE_ATEND_START_SECONDS = 14 * 3600;          // 14:00:00

export function isArrivalOrderMode(simSeconds: number): boolean {
  return getDispatchMode(simSeconds) === 'arrival';
}

export function isArrivalOrderDispatchActive(simSeconds: number): boolean {
  if (simSeconds < ATENDIMENTO_MANHA_START) return true;
  if (simSeconds >= SORTEIO_TARDE && simSeconds < ATENDIMENTO_TARDE_START) return true;
  return false;
}

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
 *
 * ARCHITECTURAL ISOLATION:
 * 1. Each company gets its own independent sorteio_order sequence (1, 2, 3... within agency).
 * 2. The inverse queue is a single mirrored list with its own independent inverse_order (1, 2, 3...).
 * 3. After the draw, these three arrays are fully decoupled — no shared references.
 * 4. Late brokers are pushed to the END of their own company queue AND the inverse queue.
 */
export async function executeSorteio(brokers: Broker[], simSeconds: number, shift: Shift): Promise<SorteioResult | null> {
  const eligible = brokers.filter(
    (b) => !b.is_external_partner && b.agency !== 'Externo' && b.presence_status === 'presente' && b.shift === shift,
  );

  const onTime = eligible.filter((b) => !isLateForSort(b.arrived_at, shift));
  const late = eligible.filter((b) => isLateForSort(b.arrived_at, shift));

  const vivaOnTime = onTime.filter((b) => b.agency === 'Viva Imóveis');
  const nobreOnTime = onTime.filter((b) => b.agency === 'Casa Nobre');

  // Fisher-Yates shuffle each company independently
  const shuffledViva = shuffleArray(vivaOnTime);
  const shuffledNobre = shuffleArray(nobreOnTime);

  // Company draw — who starts the rotation
  const desempateWinner: Agency = Math.random() < 0.5 ? 'Viva Imóveis' : 'Casa Nobre';

  // Late brokers per agency
  const lateViva = late.filter((b) => b.agency === 'Viva Imóveis');
  const lateNobre = late.filter((b) => b.agency === 'Casa Nobre');

  // Company A (Viva) direct queue: on-time shuffled + late pushed to end
  const vivaDirect = [...shuffledViva, ...lateViva];
  // Company B (Nobre) direct queue: on-time shuffled + late pushed to end
  const nobreDirect = [...shuffledNobre, ...lateNobre];

  // Inverse queue: mirror of ALL eligible brokers (interleaved reversed), then late at end
  // Build the intercalated order for the visual result only
  const first = desempateWinner === 'Viva Imóveis' ? shuffledViva : shuffledNobre;
  const second = desempateWinner === 'Viva Imóveis' ? shuffledNobre : shuffledViva;
  const interleaved: Broker[] = [];
  const maxLen = Math.max(first.length, second.length);
  for (let i = 0; i < maxLen; i++) {
    if (first[i]) interleaved.push(first[i]);
    if (second[i]) interleaved.push(second[i]);
  }
  const lateFirst = desempateWinner === 'Viva Imóveis' ? lateViva : lateNobre;
  const lateSecond = desempateWinner === 'Viva Imóveis' ? lateNobre : lateViva;
  const lateInterleaved: Broker[] = [];
  const maxLate = Math.max(lateFirst.length, lateSecond.length);
  for (let i = 0; i < maxLate; i++) {
    if (lateFirst[i]) lateInterleaved.push(lateFirst[i]);
    if (lateSecond[i]) lateInterleaved.push(lateSecond[i]);
  }

  // Inverse queue = reversed intercalated on-time + late at end (independent numbering)
  const inverseOrder = [...interleaved].reverse();
  for (const b of lateInterleaved) inverseOrder.push(b);

  const finalOrder = [...interleaved, ...lateInterleaved];
  const sessionId = `sorteio_${shift}_${Date.now()}`;

  // Persist: each company's sorteio_order is INDEPENDENT (1, 2, 3... within agency)
  for (let i = 0; i < vivaDirect.length; i++) {
    await supabase
      .from('brokers')
      .update({ sorteio_order: i + 1, shift })
      .eq('id', vivaDirect[i].id);
  }
  for (let i = 0; i < nobreDirect.length; i++) {
    await supabase
      .from('brokers')
      .update({ sorteio_order: i + 1, shift })
      .eq('id', nobreDirect[i].id);
  }
  // Persist: inverse queue has its own independent global numbering (1, 2, 3...)
  for (let i = 0; i < inverseOrder.length; i++) {
    await supabase
      .from('brokers')
      .update({ inverse_order: i + 1 })
      .eq('id', inverseOrder[i].id);
  }

  const drawOrder: Agency[] = [desempateWinner, desempateWinner === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis'];
  setCompanyDrawOrder(drawOrder);
  setCompanyRotationIndex(0);

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

  resetCompanyRotation();
}

export async function transitionToAfternoon(brokers: Broker[]): Promise<void> {
  await supabase
    .from('plantao_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('shift', 'manha')
    .eq('status', 'active');

  await supabase
    .from('queue_entries')
    .delete()
    .eq('shift', 'manha')
    .eq('queue_status', 'aguardando');

  for (const broker of brokers) {
    if (broker.is_external_partner) continue;
    const inAttendance = broker.attendance_status === 'em_mesa' || broker.attendance_status === 'decorado' || broker.attendance_status === 'em_atendimento';
    if (inAttendance) {
      await supabase
        .from('brokers')
        .update({ afternoon_reserved: true, shift: null })
        .eq('id', broker.id);
    } else {
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

  resetCompanyRotation();
}

const PRIORITY_REASONS: VisitReason[] = ['Retorno', 'Indicação'];

/**
 * Client-side interleave for display only — alternates Viva/Nobre entries
 * based on the persistent rotation pointer. Used to show the waiting list.
 */
export function interleaveQueue(entries: QueueEntry[], brokers: Broker[], lastCalledAgency?: Agency | null): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

  const viva = waiting.filter((e) => e.agency === 'Viva Imóveis').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));
  const nobre = waiting.filter((e) => e.agency === 'Casa Nobre').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));

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

/**
 * Inverse queue display — sorts by inverse_order ascending (the inverse
 * queue's own independent numbering). No agency intercalation here.
 */
export function reverseInterleaveQueue(entries: QueueEntry[], brokers: Broker[]): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

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

  const result: QueueEntry[] = [...onTime];
  result.push(...late);
  result.push(...sortedReentries);
  return result;
}

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
 * Returns the broker at the CURRENT TOP (index 0) of a specific company's
 * direct queue — i.e. the Livre broker with the lowest sorteio_order
 * within that agency. Brokers with status em_mesa, em_atendimento,
 * decorado, encerrado, pausa, or apenas_indicacao are skipped.
 */
export function nextBrokerFromAgency(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  const agencyBrokers = brokers
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => (a.sorteio_order ?? 999_999) - (b.sorteio_order ?? 999_999));

  return agencyBrokers[0];
}

/**
 * Picks the next broker for the general queue using the persistent company
 * rotation pointer. When it is Company A's turn, strictly fetch the broker
 * at the CURRENT TOP (index 0) of Company A's direct queue.
 *
 * If the target agency has all brokers busy, transbords to the other agency
 * WITHOUT advancing the pointer.
 */
export function nextBrokerForGeneralQueue(
  brokers: Broker[],
  _lastCalledAgency: Agency | null,
  excludeIds: Set<string>,
): { broker: Broker | undefined; agency: Agency } {
  const drawOrder = getCompanyDrawOrder();
  const totalCompanies = drawOrder.length;
  const rotationIndex = getCompanyRotationIndex();
  const targetAgency = drawOrder[rotationIndex] ?? AGENCIES[0];

  const broker = nextBrokerFromAgency(brokers, targetAgency, excludeIds);
  if (broker) {
    incrementCompanyRotationIndex(totalCompanies);
    return { broker, agency: broker.agency };
  }

  const otherAgency: Agency = targetAgency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  const otherBroker = nextBrokerFromAgency(brokers, otherAgency, excludeIds);
  return { broker: otherBroker, agency: otherBroker?.agency ?? targetAgency };
}

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

export function lastBrokerFromAgency(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  const agencyBrokers = brokers
    .filter((b) => !b.is_external_partner && b.agency === agency && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0));

  return agencyBrokers[0];
}

/**
 * Returns the CURRENT BOTTOM (last available) Livre broker from the SAME TEAM.
 * Used for hierarchical indicacao overflow: 1st priority is same-team.
 */
export function lastBrokerFromTeam(brokers: Broker[], equipe: string, excludeIds: Set<string>): Broker | undefined {
  const teamBrokers = brokers
    .filter((b) => !b.is_external_partner && b.equipe === equipe && b.presence_status === 'presente' && b.attendance_status === 'livre' && !isApenasIndicacao(b) && !excludeIds.has(b.id))
    .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0));

  return teamBrokers[0];
}

/**
 * Returns the CURRENT BOTTOM (last available) Livre broker from the SAME COMPANY (agency).
 * Used as 2nd priority in hierarchical indicacao overflow.
 */
export function lastBrokerFromCompany(brokers: Broker[], agency: Agency, excludeIds: Set<string>): Broker | undefined {
  return lastBrokerFromAgency(brokers, agency, excludeIds);
}

/**
 * Late check-in push: when a broker checks in after the sorteio (08:46h),
 * they are pushed via .push() to the ABSOLUTE END of:
 * - Their own company's direct queue (sorteio_order = max within same agency + 1)
 * - The unified inverse queue (inverse_order = max across ALL brokers + 1)
 *
 * The three queues remain fully isolated — pushing to one never reorders another.
 */
export async function pushLateBrokerToQueues(brokerId: string, brokers: Broker[]): Promise<void> {
  const broker = brokers.find((b) => b.id === brokerId);
  if (!broker) return;

  // Direct queue: push to end within the same agency
  const sameAgencyDirect = brokers.filter((b) => !b.is_external_partner && b.agency === broker.agency && b.sorteio_order != null);
  const maxDirect = sameAgencyDirect.length > 0 ? Math.max(...sameAgencyDirect.map((b) => b.sorteio_order ?? 0)) : 0;

  // Inverse queue: push to end across ALL brokers (independent global numbering)
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

export function resolveIndicacaoBroker(
  brokers: Broker[],
  referredBrokerId: string | null,
  excludeIds: Set<string>,
): { broker: Broker | undefined; consumesVez: boolean; source: 'named' | 'same_team' | 'same_agency' | 'other_agency' | 'last_of_agency'; equipe: string | null; protectedPosition: boolean } {
  if (!referredBrokerId) {
    return { broker: undefined, consumesVez: true, source: 'last_of_agency', equipe: null, protectedPosition: false };
  }

  const referred = brokers.find((b) => b.id === referredBrokerId);
  if (!referred) {
    return { broker: undefined, consumesVez: true, source: 'last_of_agency', equipe: null, protectedPosition: false };
  }

  // Step 1: named broker is present and free → goes directly, NO vez consumed, position protected
  if (referred.presence_status === 'presente' && (referred.attendance_status === 'livre' || referred.attendance_status === 'apenas_indicacao') && !excludeIds.has(referred.id)) {
    return { broker: referred, consumesVez: false, source: 'named', equipe: referred.equipe, protectedPosition: true };
  }

  // Step 2: named broker is busy or absent → LAST available from SAME TEAM (present at project)
  const sameTeam = lastBrokerFromTeam(brokers, referred.equipe, excludeIds);
  if (sameTeam) {
    return { broker: sameTeam, consumesVez: false, source: 'same_team', equipe: referred.equipe, protectedPosition: true };
  }

  // Step 3: no one from same team available → LAST available from SAME COMPANY (present at project)
  const sameAgency = lastBrokerFromAgency(brokers, referred.agency, excludeIds);
  if (sameAgency) {
    return { broker: sameAgency, consumesVez: false, source: 'same_agency', equipe: sameAgency.equipe, protectedPosition: true };
  }

  // Step 4: no one from same company → other company
  const otherAgency: Agency = referred.agency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
  const otherAgencyBroker = lastBrokerFromAgency(brokers, otherAgency, excludeIds);
  if (otherAgencyBroker) {
    return { broker: otherAgencyBroker, consumesVez: false, source: 'other_agency', equipe: otherAgencyBroker.equipe, protectedPosition: true };
  }

  // Step 5: all exhausted → last of referred agency (may be undefined if all absent)
  const lastBroker = lastBrokerFromAgency(brokers, referred.agency, excludeIds);
  return { broker: lastBroker, consumesVez: false, source: 'last_of_agency', equipe: referred.equipe, protectedPosition: true };
}

/**
 * Apenas Imobiliária: client goes straight to the LAST available broker of that
 * company's direct queue. 100% commission for the attending broker, consumes vez.
 */
export function resolveApenasImobiliariaBroker(
  brokers: Broker[],
  targetAgency: Agency,
  excludeIds: Set<string>,
): { broker: Broker | undefined; consumesVez: boolean } {
  const broker = lastBrokerFromAgency(brokers, targetAgency, excludeIds);
  return { broker, consumesVez: true };
}

/**
 * Unified dispatch: picks the next broker for any queue type based on the current dispatch mode.
 * - Pre-sorteio (arrival): Vez Geral uses arrival order, Decorado uses inverse arrival order.
 * - Pós-sorteio: Vez Geral uses rotation pointer → top of that company's direct queue.
 *   Decorado uses top of the isolated inverse queue (regardless of brand).
 * - Indicação: uses hierarchical transbordo.
 */
export function dispatchBroker(
  brokers: Broker[],
  queueType: QueueType,
  simSeconds: number,
  excludeIds: Set<string>,
  lastCalledAgency: Agency | null,
  referredBrokerId: string | null,
): { broker: Broker | undefined; agency: Agency; consumesVez: boolean; protectedPosition: boolean; source: string } {
  const isPreSorteio = isArrivalOrderDispatchActive(simSeconds);

  if (referredBrokerId) {
    const result = resolveIndicacaoBroker(brokers, referredBrokerId, excludeIds);
    return {
      broker: result.broker,
      agency: result.broker?.agency ?? 'Viva Imóveis',
      consumesVez: result.consumesVez,
      protectedPosition: result.protectedPosition,
      source: result.source,
    };
  }

  if (queueType === 'parceria') {
    return { broker: undefined, agency: 'Externo', consumesVez: false, protectedPosition: false, source: 'parceria' };
  }

  if (queueType === 'decorado') {
    if (isPreSorteio) {
      const broker = nextBrokerByArrivalInverse(brokers, excludeIds);
      return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true, protectedPosition: false, source: 'decorado_arrival' };
    }
    const broker = nextBrokerFromInverseTop(brokers, excludeIds);
    return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true, protectedPosition: false, source: 'decorado_inverse' };
  }

  if (isPreSorteio) {
    const broker = nextBrokerByArrivalAnyAgency(brokers, excludeIds);
    return { broker, agency: broker?.agency ?? 'Viva Imóveis', consumesVez: true, protectedPosition: false, source: 'arrival' };
  }

  const { broker, agency } = nextBrokerForGeneralQueue(brokers, lastCalledAgency, excludeIds);
  return { broker, agency, consumesVez: true, protectedPosition: false, source: 'rotation' };
}

/**
 * LIVE FIFO RE-ENTRY for direct queue:
 * When a broker completes a regular "Vez Geral" first visit, they are pushed
 * to the ABSOLUTE END of their own company's direct queue.
 * - sorteio_order = max(sorteio_order within same agency) + 1
 *
 * This NEVER touches the inverse queue — the queues are fully isolated.
 */
export async function moveBrokerToEndOfDirectQueue(brokerId: string, brokers: Broker[]): Promise<void> {
  const broker = brokers.find((b) => b.id === brokerId);
  if (!broker) return;

  const sameAgencyDirect = brokers.filter((b) => !b.is_external_partner && b.agency === broker.agency && b.sorteio_order != null);
  const maxDirect = sameAgencyDirect.length > 0 ? Math.max(...sameAgencyDirect.map((b) => b.sorteio_order ?? 0)) : 0;

  await supabase
    .from('brokers')
    .update({
      sorteio_order: maxDirect + 1,
      last_status_update: new Date().toISOString(),
    })
    .eq('id', brokerId);
}

/**
 * DECORADO RE-ENTRY for inverse queue:
 * Upon completing a Decorado attendance, the broker is pushed to the
 * ABSOLUTE END of the inverse_queue_general — independently from the direct queues.
 * - inverse_order = max(inverse_order across ALL brokers) + 1
 */
export async function moveBrokerToEndOfInverseQueue(brokerId: string, brokers: Broker[]): Promise<void> {
  const allInverse = brokers.filter((b) => !b.is_external_partner && b.inverse_order != null);
  const maxInverse = allInverse.length > 0 ? Math.max(...allInverse.map((b) => b.inverse_order ?? 0)) : 0;

  await supabase
    .from('brokers')
    .update({
      inverse_order: maxInverse + 1,
      last_status_update: new Date().toISOString(),
    })
    .eq('id', brokerId);
}

/**
 * Legacy alias — moves broker to end of direct queue only (does NOT touch inverse queue).
 * Kept for backward compatibility with callers that don't distinguish queue types.
 */
export async function moveBrokerToEndOfQueue(brokerId: string, brokers: Broker[]): Promise<void> {
  await moveBrokerToEndOfDirectQueue(brokerId, brokers);
}

/**
 * Visita ao Decorado: strictly dispatches the broker at the CURRENT TOP
 * (index 0) of the isolated inverse_queue_general, regardless of their
 * brand or who is next in the direct queues.
 *
 * The inverse queue has its own independent numbering (inverse_order: 1, 2, 3...)
 * assigned at sorteio time and maintained independently from the direct queues.
 */
export function nextBrokerFromInverseTop(brokers: Broker[], excludeIds: Set<string>): Broker | undefined {
  const present = brokers.filter(
    (b) => !b.is_external_partner && b.presence_status === 'presente' && !isApenasIndicacao(b) && !excludeIds.has(b.id),
  );

  // Sort by inverse_order ascending — the inverse queue's own independent numbering
  const sorted = present
    .filter((b) => b.inverse_order != null)
    .sort((a, b) => (a.inverse_order ?? 999_999) - (b.inverse_order ?? 999_999));

  // Brokers without inverse_order go to the absolute end
  const noOrder = present.filter((b) => b.inverse_order == null);
  const fullQueue: Broker[] = [...sorted];
  for (const b of noOrder) fullQueue.push(b);

  // Strictly return the broker at index 0 if they are Livre
  const topBroker = fullQueue[0];
  if (!topBroker) return undefined;

  if (topBroker.attendance_status === 'livre') return topBroker;

  // Top broker is busy — find next Livre in the inverse queue (regardless of brand)
  return fullQueue.find((b) => b.attendance_status === 'livre');
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

/**
 * Afternoon queue preparation: builds three separate arrays for the afternoon shift.
 * Called at 13:46h (afternoon draw) to structure:
 * - queue_company_A_afternoon (Viva direct)
 * - queue_company_B_afternoon (Nobre direct)
 * - inverse_queue_general_afternoon (independent inverse)
 *
 * Morning queues continue operating until 13:59h:59s — they are NOT touched here.
 */
export function prepareAfternoonArrays(brokers: Broker[]): {
  queue_company_A_afternoon: Broker[];
  queue_company_B_afternoon: Broker[];
  inverse_queue_general_afternoon: Broker[];
} {
  const afternoonBrokers = brokers.filter(
    (b) => !b.is_external_partner && b.agency !== 'Externo' && b.shift === 'tarde' && b.presence_status === 'presente',
  );

  const viva = afternoonBrokers.filter((b) => b.agency === 'Viva Imóveis').sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999));
  const nobre = afternoonBrokers.filter((b) => b.agency === 'Casa Nobre').sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999));
  const inverse = afternoonBrokers.sort((a, b) => (a.inverse_order ?? 999_999) - (b.inverse_order ?? 999_999));

  return {
    queue_company_A_afternoon: viva,
    queue_company_B_afternoon: nobre,
    inverse_queue_general_afternoon: inverse,
  };
}

/**
 * Exports an attendance log snapshot to the relatorio_fechamento table.
 * Called at 14:00h:00s when the afternoon shift takes command.
 */
export async function exportRelatorioFechamento(queue: QueueEntry[], shift: Shift): Promise<void> {
  const completed = queue.filter((e) => e.queue_status === 'concluido');
  const snapshotData = completed.map((e) => ({
    id: e.id,
    visit_id: e.visit_id,
    broker_id: e.broker_id,
    agency: e.agency,
    queue_type: e.queue_type,
    queue_status: e.queue_status,
    shift: e.shift,
    visit: e.visit ? {
      customer_name: e.visit.customer_name,
      phone: e.visit.phone,
      visit_reason: e.visit.visit_reason,
    } : null,
  }));

  await supabase.from('relatorio_fechamento').insert({
    shift,
    snapshot_data: snapshotData,
    total_attendances: completed.length,
  });
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
