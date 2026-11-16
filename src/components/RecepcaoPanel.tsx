import { MEDIA_CHANNELS, mediaChannelFields } from '@/lib/reports/shiftClosingReport';
import { normalizePhone, maskPhone, firstName, lookupReturn, intakeRoute, recentVisits, attendanceTrace } from '@/lib/reception/intake';
import { onlyOwn } from '@/lib/queue/pauseAndPartners';
import { scheduleAt, preOpeningChoice } from '@/lib/queue/shiftSchedule';
import { useState, useRef, useMemo, useEffect, type Dispatch, type SetStateAction } from 'react';
import { UserPlus, Phone, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, Clock, Search, EyeOff, Eye, Zap, UserCheck, UserX, Building2, Trash2, X } from 'lucide-react';
import { supabase, type Broker, type Visit, type VisitReason, type Agency, type QueueEntry } from '@/lib/supabase';
import {
  REASONS,
  dispatchBroker,
  isArrivalOrderDispatchActive,
} from '@/lib/queueEngine';
import { busyReceptionIds, receptionDestination, receptionRoster, resolveReceptionDispatch, copyQuickPhone } from '@/lib/reception/fallbackOrchestrator';
import { claimReceptionCall, saveDirectLead } from '@/lib/reception/fallbackStore';
import { useSim } from '@/lib/simContext';

type QuickReason = VisitReason;
export type QuickEntryLog = { name: string; phone: string };

type Props = {
  brokers: Broker[];
  visits: Visit[];
  queue: QueueEntry[];
  allowTestControls: boolean;
  quickLog: QuickEntryLog[];
  setQuickLog: Dispatch<SetStateAction<QuickEntryLog[]>>;
};

export default function RecepcaoPanel({ brokers, visits, queue, allowTestControls, quickLog, setQuickLog }: Props) {
  const [customerName, setCustomerName] = useState('');
  const [mediaChannel, setMediaChannel] = useState('');
  const [mediaChannelDetail, setMediaChannelDetail] = useState('');
  const [phone, setPhone] = useState('');
  const [noPhone, setNoPhone] = useState(false);
  const [returnMatch, setReturnMatch] = useState<Awaited<ReturnType<typeof lookupReturn>>>(null);
  const submitLock = useRef(false);
  useEffect(() => {
    let active = true;
    setReturnMatch(null);
    lookupReturn(noPhone ? '' : phone).then(match => {
      if (!active) return;
      setReturnMatch(match);
      if (match) { setReason('Retorno'); setReferredBrokerId(match.ownerId); }
    }).catch(() => { if (active) setMessage({ type: 'error', text: 'Não foi possível verificar o retorno. Tente novamente.' }); });
    return () => { active = false; };
  }, [phone, noPhone]);
  const [reason, setReason] = useState<VisitReason>('Primeira visita');
  const [referredBrokerId, setReferredBrokerId] = useState<string>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { currentShift, simSeconds, getCurrentTime, isHoliday, setIsHoliday, isExtendedShift, plantaoDate } = useSim();

  // Predictive search state
  const [brokerSearch, setBrokerSearch] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [selectedBroker, setSelectedBroker] = useState<Broker | null>(null);

  // Manual broker entry fallback state (when broker is not found in the database)
  const [manualBrokerName, setManualBrokerName] = useState('');
  const [manualBrokerEquipe, setManualBrokerEquipe] = useState('');
  const [manualBrokerAgency, setManualBrokerAgency] = useState<Agency>('Viva Imóveis');

  // Apenas Imobiliária company picker
  const [apenasImobiliariaAgency, setApenasImobiliariaAgency] = useState<Agency>('Viva Imóveis');

  // Quick entry state
  const [quickReason, setQuickReason] = useState<QuickReason>('Primeira visita');
  const [quickBrokerId, setQuickBrokerId] = useState<string>('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
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
  // Predictive search results — scans ALL internal brokers (present + absent + external team)
  const searchResults = useMemo(() => {
    if (!brokerSearch.trim() || brokerSearch.trim().length < 2) return [];
    const query = brokerSearch.toLowerCase().trim();
    return allInternalBrokers
      .filter((b) => b.operational_name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [brokerSearch, allInternalBrokers]);

  const isParceria = reason === 'Parceria';
  const isDecorado = reason === 'Visita ao Decorado';
  const isIndicacaoForm = reason === 'Indicação';
  const isManualEntry = isIndicacaoForm && !selectedBroker && brokerSearch.trim().length >= 2 && searchResults.length === 0;

  const partnerBrokers = brokers.filter((b) => b.is_external_partner);

  const filteredVisits = recentVisits(visits);
  const clock = { seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate };
  const busyIds = busyReceptionIds(queue);
  const roster = receptionRoster(brokers, clock);
  const partnershipUsesFallback = receptionDestination(roster, busyIds, null) !== 'normal';

  function handleReasonChange(newReason: VisitReason) {
    setReason(newReason);
    setRevealed(false);
    setMessage(null);
    setReferredBrokerId('');
    setBrokerSearch('');
    setSelectedBroker(null);
    setShowResults(false);
    setManualBrokerName('');
    setManualBrokerEquipe('');
    setManualBrokerAgency('Viva Imóveis');
  }

  function selectBroker(broker: Broker) {
    setSelectedBroker(broker);
    setReferredBrokerId(broker.id);
    setBrokerSearch(broker.operational_name);
    setShowResults(false);
  }

  function clearBrokerSearch() {
    setBrokerSearch('');
    setSelectedBroker(null);
    setReferredBrokerId('');
    setShowResults(false);
    setManualBrokerName('');
    setManualBrokerEquipe('');
  }

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitLock.current) return;
    setMessage(null);
    if (!customerName.trim()) { setMessage({ type: 'error', text: 'Informe o nome do cliente.' }); return; }
    if (!scheduleAt({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate }).acceptingClients) { setMessage({ type: 'warning', text: 'Entrada de novos clientes encerrada.' }); return; }
    submitLock.current = true;
    setSubmitting(true);
    let createdId: string | null = null;
    try {
      const previous = await lookupReturn(noPhone ? '' : phone);
      const route = intakeRoute(phone, noPhone, reason, referredBrokerId || null, previous);
      const destination = receptionDestination(roster, busyIds, route.referred_broker_id);
      if (route.visit_reason === 'Parceria' && destination === 'normal') {
        throw new Error('Há corretor livre. Use o cadastro de Parceria Externa para chamar a gerência.');
      }
      const timestamp = getCurrentTime().toISOString();
      const media = mediaChannelFields(mediaChannel, mediaChannelDetail);
      if (destination === 'direct') {
        await saveDirectLead({ ...media, customer_name: customerName.trim(), phone: route.phone,
          visit_reason: route.visit_reason, created_at: timestamp, shift: currentShift });
        setMessage({ type: 'success', text: 'Cliente cadastrado na base da Incorporadora.' });
      } else {
        if (['Indicação', 'Retorno'].includes(route.visit_reason) && !route.referred_broker_id) throw new Error('Selecione o corretor original.');
        const preOpeningAssignee = destination === 'normal' ? choosePreOpeningBroker(route.referred_broker_id) : null;
        const { queue_type: originalQueueType, ...visit } = route;
        const queue_type: QueueEntry['queue_type'] = route.visit_reason === 'Parceria' ? 'parceria' : originalQueueType === 'decorado' ? 'decorado' : 'geral';
        const result = await supabase.from('visits').insert({ ...visit, ...media, customer_name: customerName.trim(), pre_opening_assignee: preOpeningAssignee, status: 'aguardando', created_at: timestamp }).select().single();
        if (result.error || !result.data) throw result.error || new Error('Não foi possível cadastrar a visita.');
        createdId = result.data.id;
        const queued = await supabase.from('queue_entries').insert({ visit_id: createdId, agency: brokers.find(b => b.id === route.referred_broker_id)?.agency ?? 'Viva Imóveis', queue_status: 'aguardando', attempts: 0, queue_type, reception_waiting: destination === 'waiting', shift: currentShift, created_at: timestamp }).select().single();
        if (queued.error || !queued.data) throw new Error(queued.error?.message ?? 'Falha ao criar fila.');
        createdId = null;
        if (destination === 'normal' && route.referred_broker_id) {
          const { broker, split } = resolveReceptionDispatch({ ...queued.data, visit: result.data }, brokers, clock, busyIds, () =>
            dispatchBroker(brokers, queue_type, simSeconds, busyIds, null, preOpeningAssignee ?? route.referred_broker_id).broker,
          );
          if (broker && split) await claimReceptionCall(queued.data, broker, true, timestamp);
        }
        setMessage({ type: 'success', text: destination === 'waiting'
          ? 'Cliente cadastrado na Fila de Espera Geral.'
          : `${firstName(customerName)} entrou na fila como ${route.visit_reason}.` });
      }
      setCustomerName(''); setMediaChannel(''); setMediaChannelDetail(''); setPhone(''); setNoPhone(false); setReason('Primeira visita'); setReferredBrokerId(''); setSelectedBroker(null); setBrokerSearch(''); setReturnMatch(null);
    } catch (error) {
      if (createdId) await supabase.from('visits').delete().eq('id', createdId);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Não foi possível concluir o cadastro. Tente novamente.' });
    } finally { submitLock.current = false; setSubmitting(false); }
  }

  async function handleQuickEntry() {
    if (!allowTestControls || !scheduleAt(clock).acceptingClients) return;
    setQuickSubmitting(true);
    quickCounterRef.current += 1;
    try { localStorage.setItem('global_client_counter', String(quickCounterRef.current)); } catch { /* ignore */ }
    const seq = quickCounterRef.current;
    const fakeName = `Cliente #${String(seq).padStart(2, '0')}`;
    const phoneSuffix = String(Date.now()).slice(-8);
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
      setQuickLog(items => [{ name: fakeName, phone: fakePhone }, ...items]);
    } catch (error) {
      if (visitId) await supabase.from('visits').delete().eq('id', visitId);
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Falha ao simular entrada.' });
    } finally {
      setQuickSubmitting(false);
    }
  }

  async function handleDiscardClients() {
    if (!allowTestControls || discardCount < 1) return;
    setDiscarding(true);
    const recentVisits = visits.filter(visit => visit.is_test).reverse().slice(0, discardCount);
    const visitIds = recentVisits.map((v) => v.id);
    if (visitIds.length > 0) {
      await supabase.from('queue_entries').delete().in('visit_id', visitIds);
      await supabase.from('visits').delete().in('id', visitIds);
    }
    const removed = new Set(recentVisits.map(visit => visit.phone));
    setQuickLog(items => items.filter(item => !removed.has(item.phone)));
    if (visits.filter(visit => visit.is_test).length <= discardCount) {
      quickCounterRef.current = 0;
      try { localStorage.setItem('global_client_counter', '0'); } catch { /* ignore */ }
    }
    setDiscarding(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3">
        <div className="flex items-center justify-between gap-3 bg-slate-900 rounded-2xl border border-slate-800 px-5 py-3 mb-4">
          <div>
            <p className="text-sm font-medium text-slate-200">Marcar Feriado</p>
            <p className="text-xs text-slate-500">Feriado ou fim de semana operam em turno único estendido, sem sorteio da tarde.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isHoliday}
            onClick={() => setIsHoliday(!isHoliday)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${isHoliday ? 'bg-amber-500' : 'bg-slate-700'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${isHoliday ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {allowTestControls && <>
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

          {quickLog.length > 0 && <div aria-label="Telefones de teste" className="mt-3">
            <ul>{quickLog.map(item => <li key={item.phone} className="flex gap-3 text-sm">
              <span>{item.name}</span>
              <button type="button" title="Copiar telefone" className="text-sky-300 underline" onClick={() =>
                void copyQuickPhone(item.phone, value => navigator.clipboard.writeText(value))
                  .then(() => setCopyStatus('Telefone copiado.'))
                  .catch(() => setCopyStatus('Selecione o número para copiar manualmente.'))
              }>{item.phone}</button>
            </li>)}</ul>
            <p role="status" className="text-sm">{copyStatus}</p>
          </div>}

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
        </>}

        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-amber-500/10 p-3 rounded-xl">
              <UserPlus className="h-6 w-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Cadastro de Chegada</h2>
              <p className="text-sm text-slate-400">Registre o cliente — a imobiliária e o corretor são definidos pelo sistema</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-3 items-end">
              <label className="block text-sm font-medium text-slate-300">Canal de Mídia (opcional)
                <select aria-label="Canal de Mídia" value={mediaChannel} onChange={e => { setMediaChannel(e.target.value); setMediaChannelDetail(''); }} className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white">
                  <option value="">Não informado</option>
                  {MEDIA_CHANNELS.map(channel => <option key={channel} value={channel}>{channel}</option>)}
                </select>
              </label>
              {mediaChannel === 'Outros' && <label className="block text-sm font-medium text-slate-300">Especifique a ação de captação (opcional)
                <input aria-label="Detalhe do canal Outros" type="text" value={mediaChannelDetail} onChange={e => setMediaChannelDetail(e.target.value)} placeholder="Ex.: ação em evento local" className="mt-2 w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white" />
              </label>}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Nome do cliente</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Nome completo"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Telefone com DDD
                <span className="ml-2 text-xs text-slate-500">identificação automática de retorno</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => { setPhone(maskPhone(e.target.value)); setReason('Primeira visita'); setReferredBrokerId(''); }}
                  disabled={noPhone}
                  placeholder="(XX) XXXXX-XXXX"
                  className={`w-full bg-slate-800 border rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 transition ${
                    returnMatch
                      ? 'border-red-500/50 focus:ring-red-500'
                      : 'border-slate-700 focus:ring-amber-500'
                  }`}
                />
              </div>
              <label className="flex gap-2 mt-2 text-sm"><input type="checkbox" checked={noPhone} onChange={e => { setNoPhone(e.target.checked); setPhone(''); setReason('Visita ao Decorado'); setReferredBrokerId(''); }} />Cliente não forneceu telefone</label>
              {(!normalizePhone(phone) || noPhone) && <p className="text-sm text-amber-300">Sem telefone: atendimento obrigatório pela Fila Inversa (Visita ao Decorado).</p>}
              {returnMatch && <p className="text-sm text-emerald-300">Retorno identificado. Corretor original: {brokers.find(b => b.id === returnMatch.ownerId)?.operational_name ?? 'vinculado ao cadastro anterior'}.</p>}

            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Motivo da visita</label>
              <select
                value={noPhone || !normalizePhone(phone) ? 'Visita ao Decorado' : reason}
                disabled={noPhone || !normalizePhone(phone) || !!returnMatch}
                onChange={(e) => handleReasonChange(e.target.value as VisitReason)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              >
                {REASONS.filter(r => r !== 'Parceria' || partnershipUsesFallback || reason === 'Parceria').map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {isParceria && partnershipUsesFallback && (
              <p className="text-sm text-sky-300">Cadastre aqui os dados completos da visita de parceria.</p>
            )}

            {isParceria && !partnershipUsesFallback && (
              <div className="bg-sky-500/5 border border-sky-500/20 rounded-xl p-4 space-y-3">
                <p className="text-sm text-sky-400">
                  <strong>Parceria:</strong> o atendimento será direcionado ao Gerente de Parcerias.
                  O corretor parceiro não consome vez na fila geral nem tem acesso ao CRM.
                </p>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Corretor parceiro (opcional)</label>
                  <select
                    value={referredBrokerId}
                    onChange={(e) => setReferredBrokerId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-sky-500 transition"
                  >
                    <option value="">Sem corretor parceiro específico</option>
                    {partnerBrokers.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.operational_name} {b.external_company ? `(${b.external_company})` : ''}
                      </option>
                    ))}
                  </select>
                  {partnerBrokers.length === 0 && (
                    <p className="text-xs text-slate-500 mt-1.5">
                      Nenhum corretor parceiro cadastrado. Cadastre no painel Corretor / Gerente.
                    </p>
                  )}
                </div>
              </div>
            )}

            {isDecorado && (
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
                <p className="text-sm text-amber-400">
                  <strong>Visita ao Decorado:</strong> o sistema chamará automaticamente o primeiro corretor
                  disponível do topo da Fila Inversa Geral.
                </p>
              </div>
            )}

            {/* PREDICTIVE AUTOCOMPLETE SEARCH for Indicação */}
            {isIndicacaoForm && !isParceria && !isDecorado && (
              <div className="bg-slate-800/40 border border-amber-500/20 rounded-xl p-4 space-y-3">
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  Buscar corretor indicante (digite o nome)
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                  <input
                    type="text"
                    value={brokerSearch}
                    onChange={(e) => {
                      setBrokerSearch(e.target.value);
                      setShowResults(true);
                      setSelectedBroker(null);
                      setReferredBrokerId('');
                    }}
                    onFocus={() => setShowResults(true)}
                    onBlur={() => setTimeout(() => setShowResults(false), 200)}
                    placeholder="Digite o nome do corretor…"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-10 pr-10 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                  />
                  {brokerSearch && (
                    <button
                      type="button"
                      onClick={clearBrokerSearch}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}

                  {/* Autocomplete dropdown */}
                  {showResults && searchResults.length > 0 && (
                    <div className="absolute z-20 mt-1 w-full bg-slate-800 border border-slate-600 rounded-xl shadow-xl max-h-[280px] overflow-y-auto">
                      {searchResults.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onMouseDown={() => selectBroker(b)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-700/50 transition text-left border-b border-slate-700/30 last:border-0"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-white text-sm font-medium truncate">{b.operational_name}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${b.presence_status === 'presente' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                                {b.presence_status === 'presente' ? 'Presente' : b.presence_status === 'pausa' ? 'Pausa' : 'Ausente'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                              <span className={`px-1.5 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/10 text-amber-400' : 'bg-sky-500/10 text-sky-400'}`}>{b.agency}</span>
                              <span>Equipe: {b.equipe}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {showResults && brokerSearch.length >= 2 && searchResults.length === 0 && (
                    <div className="absolute z-20 mt-1 w-full bg-slate-800 border border-slate-600 rounded-xl shadow-xl p-4">
                      <p className="text-sm text-slate-400 mb-3">Nenhum corretor encontrado com esse nome.</p>
                      <p className="text-xs text-slate-500 mb-3">
                        Cadastre manualmente o corretor informando o nome, equipe e imobiliária, ou use "Apenas Imobiliária" no Simular Entrada Rápida.
                      </p>
                    </div>
                  )}
                </div>

                {/* Manual broker entry fallback — when broker is not found in the database */}
                {isManualEntry && (
                  <div className="bg-slate-900/60 border border-amber-500/20 rounded-lg p-4 space-y-3">
                    <p className="text-xs text-amber-400 font-medium">Cadastro manual de corretor indicante</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-1">
                        <label className="block text-xs text-slate-400 mb-1">Nome do corretor</label>
                        <input
                          type="text"
                          value={manualBrokerName || brokerSearch}
                          onChange={(e) => setManualBrokerName(e.target.value)}
                          placeholder="Nome digitado"
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                      <div className="sm:col-span-1">
                        <label className="block text-xs text-slate-400 mb-1">Equipe</label>
                        <input
                          type="text"
                          value={manualBrokerEquipe}
                          onChange={(e) => setManualBrokerEquipe(e.target.value)}
                          placeholder="Nome da equipe"
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                        />
                      </div>
                      <div className="sm:col-span-1">
                        <label className="block text-xs text-slate-400 mb-1">Imobiliária</label>
                        <select
                          value={manualBrokerAgency}
                          onChange={(e) => setManualBrokerAgency(e.target.value as Agency)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                        >
                          <option value="Viva Imóveis">Viva Imóveis (Empresa A)</option>
                          <option value="Casa Nobre">Casa Nobre (Empresa B)</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Ausente</span>
                      <span className="text-slate-400">
                        Transbordo: Mesma Equipe ({manualBrokerEquipe || '—'}) → Mesma Empresa ({manualBrokerAgency})
                      </span>
                    </div>
                  </div>
                )}

                {/* Selected broker card with real-time status */}
                {selectedBroker && (
                  <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-medium">{selectedBroker.operational_name}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${selectedBroker.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>
                          {selectedBroker.agency}
                        </span>
                        <span className="text-xs text-slate-400">Equipe: {selectedBroker.equipe}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      {selectedBroker.presence_status === 'presente' ? (
                        <>
                          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Presente</span>
                          {selectedBroker.attendance_status === 'livre' && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Livre — dispatch direto</span>
                          )}
                          {selectedBroker.attendance_status === 'em_mesa' && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">Ocupado — transbordo hierárquico</span>
                          )}
                          {selectedBroker.attendance_status === 'em_atendimento' && (
                            <span className="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400">Em Atendimento — transbordo hierárquico</span>
                          )}
                          {selectedBroker.attendance_status === 'apenas_indicacao' && (
                            <span className="px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400">Apenas Indicação — dispatch direto</span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">{selectedBroker.presence_status === 'pausa' ? 'Pausa' : 'Ausente'}</span>
                          <span className="text-slate-400">
                            Transbordo: Mesma Equipe ({selectedBroker.equipe}) → Mesma Empresa ({selectedBroker.agency})
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Apenas Imobiliária fallback */}
                <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-800/40 rounded-lg p-2.5">
                  <Building2 className="h-4 w-4 shrink-0" />
                  <span>
                    Não lembra o corretor? Use a opção <strong className="text-amber-400">"Indicação: Só a Imobiliária"</strong> no Simular Entrada Rápida acima para selecionar apenas a empresa.
                  </span>
                </div>
              </div>
            )}

            {reason === 'Retorno' && !isParceria && !isDecorado && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Corretor original</label>
                <select
                  value={referredBrokerId}
                  disabled={!!returnMatch}
                  onChange={(e) => setReferredBrokerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                >
                  <option value="">Selecione o corretor original</option>
                  {allInternalBrokers.map((b) => (
                    <option key={b.id} value={b.id}>{b.operational_name} ({b.agency} · {b.equipe})</option>
                  ))}
                </select>
              </div>
            )}

            {!revealed && !isParceria && !isDecorado && (
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-800/40 rounded-lg p-2.5">
                <EyeOff className="h-4 w-4 shrink-0" />
                <span>A imobiliária e o corretor da vez são ocultados até o cadastro ser concluído. O sistema define tudo automaticamente.</span>
              </div>
            )}

            {revealed && message?.type === 'success' && !isParceria && !isDecorado && (
              <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-lg p-2.5">
                <Eye className="h-4 w-4 shrink-0" />
                <span>Cliente na fila. O corretor da vez será definido pelo Motor da Fila.</span>
              </div>
            )}

            {message && (
              <div
                className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
                  message.type === 'success'
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : message.type === 'warning'
                    ? 'text-amber-400 bg-amber-500/10'
                    : message.type === 'info'
                    ? 'text-sky-400 bg-sky-500/10'
                    : 'text-red-400 bg-red-500/10'
                }`}
              >
                {message.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <span>{message.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <UserPlus className="h-5 w-5" />
              {submitting ? 'Cadastrando…' : 'Cadastrar visita'}
            </button>
          </form>
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 h-full">
          <h2 className="text-lg font-bold mb-4">Visitas recentes</h2>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {filteredVisits.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">Nenhuma visita registrada.</p>
            ) : (
              filteredVisits.map((v) => (
                <div key={v.id} className="bg-slate-800/60 rounded-xl p-3 border border-slate-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-white text-sm">{firstName(v.customer_name)}</span>
                    <StatusBadge status={v.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(v.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="mt-1.5 text-xs text-amber-400/80">{v.visit_reason}</div><p className="text-xs text-slate-300 mt-2">{attendanceTrace(queue.filter(e => e.visit_id === v.id).sort((a,b) => b.created_at.localeCompare(a.created_at))[0], brokers)}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Visit['status'] }) {
  const styles: Record<Visit['status'], string> = {
    aguardando: 'bg-amber-500/15 text-amber-400',
    aguardando_chamada: 'bg-orange-500/15 text-orange-400',
    em_atendimento: 'bg-sky-500/15 text-sky-400',
    encerrado: 'bg-slate-600/30 text-slate-400',
    recusado: 'bg-red-500/15 text-red-400',
  };
  const labels: Record<Visit['status'], string> = {
    aguardando: 'Aguardando',
    aguardando_chamada: 'Aguardando chamada',
    em_atendimento: 'Em atendimento',
    encerrado: 'Encerrado',
    recusado: 'Recusado',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}
