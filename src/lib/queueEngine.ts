import { supabase, type Broker, type QueueEntry, type Visit, type VisitReason, type Agency, type QueueType, type PlantaoSession } from './supabase';

const LATE_LIMIT_SECONDS = 8 * 3600 + 45 * 60 + 59; // 08:45:59
export const SORTED_TRIGGER_SECONDS = 8 * 3600 + 46 * 60; // 08:46:00

export function secondsSinceMidnight(date: Date): number {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

export function isLateForSort(arrivedAt: string | null): boolean {
  if (!arrivedAt) return true;
  const arrived = new Date(arrivedAt);
  return secondsSinceMidnight(arrived) > LATE_LIMIT_SECONDS;
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

export const QUEUE_TYPES: QueueType[] = ['geral', 'decorado', 'parceria'];

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
};

/**
 * Sorteio automático às 08:46:00:
 * 1. Pegar corretores presentes até 08:45:59 de cada imobiliária (excluindo parceiros externos).
 * 2. Embaralhar cada lista aleatoriamente (Fisher-Yates).
 * 3. Sorteio entre Empresas: sorteio aleatório entre as duas imobiliárias para definir quem inicia.
 * 4. Intercalar respeitando o vencedor do desempate:
 *    - Se A ganhar: A1, B1, A2, B2...
 *    - Se B ganhar: B1, A1, B2, A2...
 * 5. Quem chegou após 08:45:59 entra no fim com tag "Atrasado".
 * 6. Persistir sorteio_order em brokers e criar uma plantao_session.
 */
export async function executeSorteio(brokers: Broker[], simSeconds: number): Promise<SorteioResult | null> {
  const eligible = brokers.filter(
    (b) => !b.is_external_partner && b.agency !== 'Externo' && b.presence_status === 'presente',
  );

  const onTime = eligible.filter((b) => !isLateForSort(b.arrived_at));
  const late = eligible.filter((b) => isLateForSort(b.arrived_at));

  const vivaOnTime = onTime.filter((b) => b.agency === 'Viva Imóveis');
  const nobreOnTime = onTime.filter((b) => b.agency === 'Casa Nobre');

  const shuffledViva = shuffleArray(vivaOnTime);
  const shuffledNobre = shuffleArray(nobreOnTime);

  // Sorteio entre Empresas (Desempate): define quem inicia a intercalação
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

  const sessionId = `sorteio_${Date.now()}`;

  // Persistir a ordem do sorteio nos corretores
  for (let i = 0; i < finalOrder.length; i++) {
    await supabase
      .from('brokers')
      .update({ sorteio_order: i + 1 })
      .eq('id', finalOrder[i].id);
  }

  // Criar sessão de plantão
  await supabase.from('plantao_sessions').insert({
    id: sessionId,
    status: 'active',
  });

  // Encerrar sessões anteriores
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
  };
}

/**
 * Reiniciar plantão: limpa a fila atual, zera o relógio, coloca corretores como disponíveis.
 * NÃO apaga visitas (banco de clientes permanece intacto).
 */
export async function reiniciarPlantao(brokers: Broker[]): Promise<void> {
  // Deletar todas as queue_entries (fila atual)
  await supabase.from('queue_entries').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Zerar sorteio_order e resetar attendance_status para 'livre', presence_status para 'ausente'
  for (const broker of brokers) {
    await supabase
      .from('brokers')
      .update({
        sorteio_order: null,
        attendance_status: 'livre',
        presence_status: 'ausente',
        arrived_at: null,
        last_status_update: new Date().toISOString(),
      })
      .eq('id', broker.id);
  }

  // Marcar todas as sessões como encerradas
  await supabase
    .from('plantao_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('status', 'active');

  // Resetar status das visitas que estavam em atendimento para 'encerrado'
  await supabase
    .from('visits')
    .update({ status: 'encerrado' })
    .in('status', ['aguardando', 'aguardando_chamada', 'em_atendimento']);
}

/**
 * Intercala as listas das duas imobiliárias usando a ordem do sorteio.
 * Reentradas vão para o final ordenadas por `reentry_at`.
 */
export function interleaveQueue(entries: QueueEntry[], brokers: Broker[]): QueueEntry[] {
  const waiting = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'aguardando');
  const reentries = entries.filter((e) => e.queue_type === 'geral' && e.queue_status === 'ausente' && e.reentry_at);

  const sortedReentries = [...reentries].sort(
    (a, b) => new Date(a.reentry_at!).getTime() - new Date(b.reentry_at!).getTime(),
  );

  const viva = waiting.filter((e) => e.agency === 'Viva Imóveis').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));
  const nobre = waiting.filter((e) => e.agency === 'Casa Nobre').sort((a, b) => sortKey(entries, brokers, a) - sortKey(entries, brokers, b));

  const interleaved: QueueEntry[] = [];
  const maxLen = Math.max(viva.length, nobre.length);
  for (let i = 0; i < maxLen; i++) {
    if (viva[i]) interleaved.push(viva[i]);
    if (nobre[i]) interleaved.push(nobre[i]);
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

  if (broker && isLateForSort(broker.arrived_at)) return 999_999_000;

  // Se o corretor tem sorteio_order, usar essa ordem
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
