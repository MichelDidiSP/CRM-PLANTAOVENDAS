import { useRef, useState } from 'react';
import { Zap, UserCheck, UserX, Building2, Trash2 } from 'lucide-react';
import { supabase, type Broker, type Visit, type VisitReason, type Agency, type QueueEntry } from '@/lib/supabase';
import { useSim } from '@/lib/simContext';
import { onlyOwn } from '@/lib/queue/pauseAndPartners';
import { scheduleAt, preOpeningChoice } from '@/lib/queue/shiftSchedule';
import { dispatchBroker, isArrivalOrderDispatchActive } from '@/lib/queueEngine';
import { busyReceptionIds, receptionDestination, receptionRoster, resolveReceptionDispatch } from '@/lib/reception/fallbackOrchestrator';
import { claimReceptionCall, saveDirectLead } from '@/lib/reception/fallbackStore';

type QuickReason = VisitReason;
// Original PR #6 quick entry: the official engines decide and persist every assignment.
export default function QuickEntryPanel({ brokers, visits, queue, disabled, onChanged }: {
  brokers: Broker[]; visits: Visit[]; queue: QueueEntry[]; disabled: boolean; onChanged: () => Promise<unknown>;
}) {
  const { currentShift, simSeconds, getCurrentTime, isExtendedShift, plantaoDate } = useSim();
  const [apenasImobiliariaAgency, setApenasImobiliariaAgency] = useState<Agency>('Viva Imóveis');
  const [message, setMessage] = useState<{ type: string; text: string } | null>(null);
  // Quick entry state
  const [quickReason, setQuickReason] = useState<QuickReason>('Primeira visita');
  const [quickBrokerId, setQuickBrokerId] = useState<string>('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const quickCounterRef = useRef<number>(
    (() => {
      try {
        const stored = localStorage.getItem('global_client_counter');
        return stored ? parseInt(stored, 10) : 0;
      } catch { return 0; }
    })(),
  );
  const [discardCount, setDiscardCount] = useState(5);
  const [discarding, setDiscarding] = useState(false);

  const isIndicacaoPresente = quickReason === 'Indicação Presente';
  const isIndicacaoAusente = quickReason === 'Indicação Ausente';
  const isIndicacaoImobiliaria = quickReason === 'Indicação Imobiliária';
  const isAnyIndicacao = isIndicacaoPresente || isIndicacaoAusente || isIndicacaoImobiliaria;
  const needsBrokerSelect = isIndicacaoPresente || isIndicacaoAusente || quickReason === 'Retorno' || quickReason === 'Indicação';

  const presentBrokers = brokers.filter(
    (b) => !b.is_external_partner && b.presence_status === 'presente',
  );
  const allInternalBrokers = brokers.filter(
    (b) => !b.is_external_partner,
  );

  const clock = { seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate };
  const busyIds = busyReceptionIds(queue);
  const roster = receptionRoster(brokers, clock);
  function choosePreOpeningBroker(ownerId: string | null): string | null {
    if (!isArrivalOrderDispatchActive(simSeconds, isExtendedShift) || !ownerId) return null;
    if (brokers.some(b => b.id === ownerId && onlyOwn(b))) return null;
    const choice = preOpeningChoice(brokers, ownerId);
    if (!choice.needsChoice) return null;
    const wait = window.confirm('O corretor ainda não está inscrito. O cliente deseja aguardar? OK para aguardar; Cancelar para atender com o primeiro inscrito da mesma imobiliária.');
    if (wait) return null;
    if (!choice.alternative) {
      setMessage({ type: 'warning', text: 'Nenhum corretor livre inscrito na mesma imobiliária. Cliente aguardará.' });
      return null;
    }
    return choice.alternative.id;
  }

  async function handleQuickEntry() {
    if (disabled || quickSubmitting || !scheduleAt(clock).acceptingClients) return;
    setQuickSubmitting(true);
    quickCounterRef.current += 1;
    try { localStorage.setItem('global_client_counter', String(quickCounterRef.current)); } catch { /* ignore */ }
    const seq = quickCounterRef.current;
    const fakeName = `Cliente #${String(seq).padStart(2, '0')}`;
    const phoneSuffix = String(Date.now() + seq).slice(-8);
    const fakePhone = `119${phoneSuffix}`;
    const simTimestamp = getCurrentTime().toISOString();

    const isParceriaQuick = quickReason === 'Parceria';
    const isDecoradoQuick = quickReason === 'Visita ao Decorado';
    const queueType = isParceriaQuick ? 'parceria' : isDecoradoQuick ? 'decorado' : 'geral';

    let referredBrokerId: string | null = null;
    let dbVisitReason: VisitReason = quickReason;
    let targetAgency: Agency = 'Viva Imóveis';

    if (isIndicacaoPresente) {
      referredBrokerId = quickBrokerId || null;
      dbVisitReason = 'Indicação';
      const refBroker = brokers.find((b) => b.id === quickBrokerId);
      if (refBroker) targetAgency = refBroker.agency;
    } else if (isIndicacaoAusente) {
      referredBrokerId = quickBrokerId || null;
      dbVisitReason = 'Indicação';
      const refBroker = brokers.find((b) => b.id === quickBrokerId);
      if (refBroker) targetAgency = refBroker.agency;
    } else if (isIndicacaoImobiliaria) {
      dbVisitReason = 'Indicação';
      targetAgency = apenasImobiliariaAgency;
    }

    if (quickReason === 'Retorno' || quickReason === 'Indicação') referredBrokerId = quickBrokerId || null;
    const destination = receptionDestination(roster, busyIds, referredBrokerId);
    let visitId: string | null = null;
    try {
      if (destination === 'direct') {
        await saveDirectLead({ customer_name: fakeName, phone: fakePhone, visit_reason: dbVisitReason,
          media_channel: null, media_channel_detail: null, created_at: simTimestamp, shift: currentShift, is_test: true });
      } else {
        const preOpeningAssignee = destination === 'normal' ? choosePreOpeningBroker(referredBrokerId) : null;
        const { data: visit, error: visitError } = await supabase.from('visits').insert({
          customer_name: fakeName, phone: fakePhone, visit_reason: dbVisitReason, referred_broker_id: referredBrokerId,
          pre_opening_assignee: preOpeningAssignee, status: 'aguardando', created_at: simTimestamp, is_test: true,
        }).select().single();
        if (visitError || !visit) throw new Error(visitError?.message ?? 'Falha ao cadastrar visita de teste.');
        visitId = visit.id;
        const { data: row, error: queueError } = await supabase.from('queue_entries').insert({
          visit_id: visit.id, agency: isParceriaQuick ? 'Externo' : brokers.find(b => b.id === referredBrokerId)?.agency ?? targetAgency,
          queue_status: 'aguardando', attempts: 0, queue_type: queueType, shift: currentShift,
          created_at: simTimestamp, reception_waiting: destination === 'waiting',
        }).select().single();
        if (queueError || !row) throw new Error(queueError?.message ?? 'Falha ao criar fila de teste.');
        visitId = null;
        if (destination === 'normal') {
          const { broker, split } = resolveReceptionDispatch({ ...row, visit }, brokers, clock, busyIds, () =>
            dispatchBroker(brokers, queueType, simSeconds, busyIds, null, preOpeningAssignee ?? referredBrokerId).broker,
          );
          if (broker) await claimReceptionCall(row, broker, split, simTimestamp,
            !referredBrokerId && queueType === 'geral');
        }
      }
      await onChanged();
    } catch (error) {
      if (visitId) await supabase.from('visits').delete().eq('id', visitId);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Falha ao simular entrada.' });
    } finally {
      setQuickSubmitting(false);
    }
  }

  async function handleDiscardClients() {
    if (disabled || discardCount < 1) return;
    setDiscarding(true);
    const recentVisits = visits.filter(visit => visit.is_test).reverse().slice(0, discardCount);
    const visitIds = recentVisits.map((v) => v.id);
    if (visitIds.length > 0) {
      await supabase.from('queue_entries').delete().in('visit_id', visitIds);
      await supabase.from('visits').delete().in('id', visitIds);
    }
    await onChanged();
    if (visits.filter(visit => visit.is_test).length <= discardCount) {
      quickCounterRef.current = 0;
      try { localStorage.setItem('global_client_counter', '0'); } catch { /* ignore */ }
    }
    setDiscarding(false);
  }


  return <fieldset disabled={disabled} className="disabled:opacity-50">
    {message && <p role="status">{message.text}</p>}
        {/* Simular Entrada Rápida */}
        <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-2xl border border-amber-500/30 p-5 mb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-500/20 p-2.5 rounded-xl">
              <Zap className="h-6 w-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-amber-400">Simular Entrada Rápida</h2>
              <p className="text-sm text-slate-400">Gera um cliente fictício durante o horário de entrada do plantão.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px]">
              <label className="block text-xs text-slate-400 mb-1">Motivo</label>
              <select
                value={quickReason}
                onChange={(e) => {
                  setQuickReason(e.target.value as QuickReason);
                  setQuickBrokerId('');
                }}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                <option value="Primeira visita">Vez Geral</option>
                <option value="Visita ao Decorado">Visita ao Decorado</option>
                <option value="Indicação Presente">Indicação: Corretor Presente</option>
                <option value="Indicação Ausente">Indicação: Corretor Ausente</option>
                <option value="Indicação Imobiliária">Indicação: Só a Imobiliária</option>
              </select>
            </div>

            {needsBrokerSelect && (
              <div className="min-w-[220px]">
                <label className="block text-xs text-slate-400 mb-1">
                  {isIndicacaoPresente ? 'Corretor presente (todos os presentes)' : 'Corretor indicado (ausente)'}
                </label>
                <select
                  value={quickBrokerId}
                  onChange={(e) => setQuickBrokerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">Selecione um corretor…</option>
                  {(isIndicacaoPresente ? presentBrokers : allInternalBrokers.filter((b) => b.presence_status !== 'presente')).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.operational_name} ({b.agency}) · {b.equipe} {b.presence_status === 'presente' ? '· Presente' : b.presence_status === 'pausa' ? '· Pausa' : '· Ausente'}{b.attendance_status === 'apenas_indicacao' ? ' · Apenas Indicação' : ''}
                    </option>
                  ))}
                </select>
                {isIndicacaoPresente && presentBrokers.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">Nenhum corretor marcou presença ainda.</p>
                )}
                {isIndicacaoAusente && allInternalBrokers.filter((b) => b.presence_status !== 'presente').length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">Nenhum corretor ausente para indicar.</p>
                )}
              </div>
            )}

            {isIndicacaoImobiliaria && (
              <div className="min-w-[200px]">
                <label className="block text-xs text-slate-400 mb-1">Imobiliária responsável</label>
                <select
                  value={apenasImobiliariaAgency}
                  onChange={(e) => setApenasImobiliariaAgency(e.target.value as Agency)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="Viva Imóveis">Viva Imóveis (Empresa A)</option>
                  <option value="Casa Nobre">Casa Nobre (Empresa B)</option>
                </select>
              </div>
            )}

            <button
              onClick={handleQuickEntry}
              disabled={quickSubmitting || (needsBrokerSelect && !quickBrokerId)}
              className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 text-slate-950 font-bold px-5 py-2.5 rounded-xl transition"
            >
              <Zap className="h-5 w-5" />
              {quickSubmitting ? 'Enviando…' : 'Simular Entrada Rápida'}
            </button>
          </div>

          {/* Rule explanation badges */}
          {isAnyIndicacao && (
            <div className="mt-3 flex flex-wrap gap-2">
              {isIndicacaoPresente && (
                <span className="flex items-center gap-1.5 text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-lg">
                  <UserCheck className="h-3.5 w-3.5" />
                  Regra 5: Vai direto ao corretor presente. Mantém a posição na fila geral.
                </span>
              )}
              {isIndicacaoAusente && (
                <span className="flex items-center gap-1.5 text-xs bg-orange-500/10 text-orange-400 px-3 py-1.5 rounded-lg">
                  <UserX className="h-3.5 w-3.5" />
                  Hierarquia: Mesma Equipe → Mesma Empresa. Posição protegida (Indicação Dividida 50/50).
                </span>
              )}
              {isIndicacaoImobiliaria && (
                <span className="flex items-center gap-1.5 text-xs bg-sky-500/10 text-sky-400 px-3 py-1.5 rounded-lg">
                  <Building2 className="h-3.5 w-3.5" />
                  Só a marca: último disponível da imobiliária. 100% comissão para o atendente.
                </span>
              )}
            </div>
          )}

          {/* Descarte Controlado de Clientes */}
          <div className="mt-4 flex flex-wrap items-end gap-3 pt-4 border-t border-amber-500/20">
            <div className="min-w-[100px]">
              <label className="block text-xs text-slate-400 mb-1">Quantidade</label>
              <input
                type="number"
                min={1}
                max={100}
                value={discardCount}
                onChange={(e) => setDiscardCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>
            <button
              onClick={handleDiscardClients}
              disabled={discarding || visits.length === 0}
              className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 disabled:bg-slate-700 text-red-400 disabled:text-slate-500 font-medium px-4 py-2.5 rounded-xl transition border border-red-500/20 disabled:border-slate-700"
            >
              <Trash2 className="h-4 w-4" />
              {discarding ? 'Descartando…' : `Descartar Últimos ${discardCount} Clientes`}
            </button>
            <p className="text-xs text-slate-500 self-center">
              Apaga apenas os últimos clientes inseridos. Mantém o restante para testes de anti-duplicidade e Retorno.
            </p>
          </div>
        </div>
  </fieldset>;
}
