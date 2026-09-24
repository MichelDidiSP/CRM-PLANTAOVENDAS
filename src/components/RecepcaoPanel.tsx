import { useState, useRef } from 'react';
import { UserPlus, Phone, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, Clock, Search, EyeOff, Eye, Zap, UserCheck, UserX, Building2, Trash2 } from 'lucide-react';
import { supabase, type Broker, type Visit, type VisitReason, type Agency } from '@/lib/supabase';
import { REASONS, QUICK_REASONS, sanitizePhone, formatPhoneDisplay, lastBrokerFromAgency, nextBrokerFromAgency, nextBrokerByArrival, nextBrokerFromInverseTop, nextBrokerByArrivalAnyAgency, nextBrokerByArrivalInverse, nextBrokerForGeneralQueue, dispatchBroker, isArrivalOrderDispatchActive } from '@/lib/queueEngine';
import { useSim } from '@/lib/simContext';

type QuickReason = VisitReason;

type Props = {
  brokers: Broker[];
  visits: Visit[];
};

export default function RecepcaoPanel({ brokers, visits }: Props) {
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState<VisitReason>('Primeira visita');
  const [referredBrokerId, setReferredBrokerId] = useState<string>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchPhone, setSearchPhone] = useState('');
  const [revealed, setRevealed] = useState(false);
  const { currentShift, isPreSorteio, simSeconds, getCurrentTime } = useSim();

  // Quick entry state
  const [quickReason, setQuickReason] = useState<QuickReason>('Primeira visita');
  const [quickBrokerId, setQuickBrokerId] = useState<string>('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const quickCounterRef = useRef(() => {
    try {
      const stored = localStorage.getItem('global_client_counter');
      return stored ? parseInt(stored, 10) : 0;
    } catch { return 0; }
  }());
  const [discardCount, setDiscardCount] = useState(5);
  const [discarding, setDiscarding] = useState(false);

  const isIndicacaoPresente = quickReason === 'Indicação Presente';
  const isIndicacaoAusente = quickReason === 'Indicação Ausente';
  const isIndicacaoImobiliaria = quickReason === 'Indicação Imobiliária';
  const isAnyIndicacao = isIndicacaoPresente || isIndicacaoAusente || isIndicacaoImobiliaria;
  const needsBrokerSelect = isIndicacaoPresente || isIndicacaoAusente;

  const presentBrokers = brokers.filter(
    (b) => !b.is_external_partner && b.presence_status === 'presente',
  );
  const allInternalBrokers = brokers.filter(
    (b) => !b.is_external_partner,
  );

  const normalizedPhone = sanitizePhone(phone);
  const duplicate = visits.find((v) => v.phone === normalizedPhone && v.status !== 'encerrado' && normalizedPhone.length > 0);

  const isParceria = reason === 'Parceria';
  const isDecorado = reason === 'Visita ao Decorado';

  const partnerBrokers = brokers.filter((b) => b.is_external_partner);

  const filteredVisits = searchPhone
    ? visits.filter((v) => v.phone.includes(sanitizePhone(searchPhone)))
    : visits;

  function handleReasonChange(newReason: VisitReason) {
    setReason(newReason);
    setRevealed(false);
    setMessage(null);
    setReferredBrokerId('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);

    if (!customerName.trim() || normalizedPhone.length < 10) {
      setMessage({ type: 'error', text: 'Preencha o nome e um telefone válido com DDD.' });
      return;
    }

    if (duplicate) {
      setMessage({
        type: 'warning',
        text: `Cliente já cadastrado: ${duplicate.customer_name} — ${formatPhoneDisplay(duplicate.phone)} (${duplicate.visit_reason}).`,
      });
      return;
    }

    setSubmitting(true);

    const simTimestamp = getCurrentTime().toISOString();
    const queueType = isParceria ? 'parceria' : isDecorado ? 'decorado' : 'geral';

    // Agency is hidden from reception — determined by system rules
    // For Parceria: Externo; for Decorado: system picks from inverse queue; for Geral: system alternates
    const entryAgency: Agency = isParceria ? 'Externo' : 'Viva Imóveis';

    const { data: visitData, error: visitError } = await supabase
      .from('visits')
      .insert({
        customer_name: customerName.trim(),
        phone: normalizedPhone,
        visit_reason: reason,
        referred_broker_id: referredBrokerId || null,
        status: 'aguardando',
        created_at: simTimestamp,
      })
      .select()
      .single();

    if (visitError || !visitData) {
      setMessage({ type: 'error', text: 'Erro ao cadastrar visita. Tente novamente.' });
      setSubmitting(false);
      return;
    }

    const { error: queueError } = await supabase.from('queue_entries').insert({
      visit_id: visitData.id,
      agency: entryAgency,
      queue_status: 'aguardando',
      attempts: 0,
      queue_type: queueType,
      shift: currentShift,
      created_at: simTimestamp,
    });

    if (queueError) {
      setMessage({ type: 'error', text: 'Visita criada, mas erro ao entrar na fila.' });
    } else {
      const successMsg = isParceria
        ? `${customerName.trim()} foi cadastrado como Parceria e será direcionado ao Gerente de Parcerias.`
        : isDecorado
        ? `${customerName.trim()} foi cadastrado para Visita ao Decorado. O sistema chamará o próximo corretor da Fila Inversa.`
        : `${customerName.trim()} foi cadastrado e entrou na fila. A imobiliária e o corretor serão definidos pelo sistema.`;

      setMessage({ type: 'success', text: successMsg });
      setRevealed(true);
      setCustomerName('');
      setPhone('');
      setReferredBrokerId('');
    }
    setSubmitting(false);
  }

  async function handleQuickEntry() {
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

    // Determine referred broker and visit reason for DB
    let referredBrokerId: string | null = null;
    let dbVisitReason: VisitReason = quickReason;

    // Determine which agency the referred broker belongs to (for Rule 2)
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
    }

    // Entry agency: for parceria it's Externo; for indicacao use the referred broker's agency;
    // for geral/decorado the system will determine at call time
    const entryAgency: Agency = isParceriaQuick ? 'Externo' : targetAgency;

    const { data: visitData, error: visitError } = await supabase
      .from('visits')
      .insert({
        customer_name: fakeName,
        phone: fakePhone,
        visit_reason: dbVisitReason,
        referred_broker_id: referredBrokerId,
        status: 'aguardando',
        created_at: simTimestamp,
      })
      .select()
      .single();

    if (visitError || !visitData) {
      setQuickSubmitting(false);
      return;
    }

    // Determine broker assignment for the queue entry
    let assignedBrokerId: string | null = null;
    const busyIds = new Set<string>(
      brokers.filter((b) => b.attendance_status === 'em_mesa' || b.attendance_status === 'decorado').map((b) => b.id),
    );

    if (isIndicacaoPresente) {
      // Rule 5: goes directly to the referred broker, does NOT consume their vez
      const referred = brokers.find((b) => b.id === quickBrokerId);
      if (referred && referred.presence_status === 'presente' && referred.attendance_status === 'livre') {
        assignedBrokerId = referred.id;
      }
    } else if (isIndicacaoAusente) {
      // Rule 6: referred broker is absent → LAST available broker of same agency
      const lastBroker = lastBrokerFromAgency(brokers, targetAgency, busyIds);
      assignedBrokerId = lastBroker?.id ?? null;
    } else if (isIndicacaoImobiliaria) {
      // Rule: only knows agency → last available broker of that agency
      // Since reception can't pick agency, default to Viva for quick test
      const lastBroker = lastBrokerFromAgency(brokers, 'Viva Imóveis', busyIds);
      assignedBrokerId = lastBroker?.id ?? null;
    } else if (isDecoradoQuick) {
      // Decorado: pre-sorteio uses inverse arrival order; post-sorteio uses inverse sorteio
      if (isArrivalOrderDispatchActive(simSeconds)) {
        const broker = nextBrokerByArrivalInverse(brokers, busyIds);
        assignedBrokerId = broker?.id ?? null;
      } else {
        const broker = nextBrokerFromInverseTop(brokers, busyIds);
        assignedBrokerId = broker?.id ?? null;
      }
    } else if (!isParceriaQuick) {
      // Geral: pre-sorteio uses pure arrival order across all agencies;
      // post-sorteio scans the intercalated queue top-to-bottom for first 'Livre' broker
      if (isArrivalOrderDispatchActive(simSeconds)) {
        const broker = nextBrokerByArrivalAnyAgency(brokers, busyIds);
        assignedBrokerId = broker?.id ?? null;
      } else {
        const { broker } = nextBrokerForGeneralQueue(brokers, null, busyIds);
        assignedBrokerId = broker?.id ?? null;
      }
    }

    const insertData: Record<string, unknown> = {
      visit_id: visitData.id,
      agency: entryAgency,
      queue_status: assignedBrokerId ? 'chamando' : 'aguardando',
      attempts: assignedBrokerId ? 1 : 0,
      queue_type: queueType,
      shift: currentShift,
      broker_id: assignedBrokerId,
      called_at: assignedBrokerId ? simTimestamp : null,
      created_at: simTimestamp,
    };

    await supabase.from('queue_entries').insert(insertData);

    if (assignedBrokerId) {
      await supabase
        .from('brokers')
        .update({ attendance_status: 'em_mesa', last_status_update: simTimestamp })
        .eq('id', assignedBrokerId);
      await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', visitData.id);
    }

    setQuickSubmitting(false);
  }

  async function handleDiscardClients() {
    if (discardCount < 1) return;
    setDiscarding(true);
    const recentVisits = [...visits].reverse().slice(0, discardCount);
    const visitIds = recentVisits.map((v) => v.id);
    if (visitIds.length > 0) {
      await supabase.from('queue_entries').delete().in('visit_id', visitIds);
      await supabase.from('visits').delete().in('id', visitIds);
    }
    setDiscarding(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3">
        {/* Simular Entrada Rápida */}
        <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-2xl border border-amber-500/30 p-5 mb-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-500/20 p-2.5 rounded-xl">
              <Zap className="h-6 w-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-amber-400">Simular Entrada Rápida</h2>
              <p className="text-sm text-slate-400">Gera um cliente fictício e envia direto para a fila — funciona em qualquer horário</p>
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
                <option value="Parceria">Parceria</option>
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
                  {(isIndicacaoPresente ? presentBrokers : allInternalBrokers.filter((b) => b.presence_status === 'ausente')).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.operational_name} ({b.agency}) {b.presence_status === 'presente' ? '· Presente' : '· Ausente'}
                    </option>
                  ))}
                </select>
                {isIndicacaoPresente && presentBrokers.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">Nenhum corretor marcou presença ainda.</p>
                )}
                {isIndicacaoAusente && allInternalBrokers.filter((b) => b.presence_status === 'ausente').length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">Nenhum corretor ausente para indicar.</p>
                )}
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
                  Regra 6: Corretor ausente → último disponível da mesma imobiliária. Consome a vez.
                </span>
              )}
              {isIndicacaoImobiliaria && (
                <span className="flex items-center gap-1.5 text-xs bg-sky-500/10 text-sky-400 px-3 py-1.5 rounded-lg">
                  <Building2 className="h-3.5 w-3.5" />
                  Regra: Só a marca → último disponível da imobiliária. Consome a vez.
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
                Telefone com DDD <span className="text-amber-400">*</span>
                <span className="ml-2 text-xs text-slate-500">chave anti-duplicidade (apenas números)</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Digite o telefone livremente (ex: 11912345678)"
                  className={`w-full bg-slate-800 border rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 transition ${
                    duplicate
                      ? 'border-red-500/50 focus:ring-red-500'
                      : 'border-slate-700 focus:ring-amber-500'
                  }`}
                />
              </div>
              {duplicate && (
                <div className="mt-2 flex items-start gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Duplicidade detectada: <strong>{duplicate.customer_name}</strong> já está no plantão
                    ({duplicate.visit_reason}).
                  </span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Motivo da visita</label>
              <select
                value={reason}
                onChange={(e) => handleReasonChange(e.target.value as VisitReason)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
              >
                {REASONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* NO AGENCY SELECTOR — completely hidden from reception */}

            {isParceria && (
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

            {(reason === 'Indicação' || reason === 'Retorno') && !isParceria && !isDecorado && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Corretor indicante (opcional)</label>
                <select
                  value={referredBrokerId}
                  onChange={(e) => setReferredBrokerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                >
                  <option value="">Sem corretor específico</option>
                  {presentBrokers.map((b) => (
                    <option key={b.id} value={b.id}>{b.operational_name} ({b.agency})</option>
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
              disabled={submitting || !!duplicate}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-bold py-3.5 rounded-xl transition-all flex items-center justify-center gap-2"
            >
              <UserPlus className="h-5 w-5" />
              {submitting ? 'Cadastrando…' : 'Cadastrar e enviar para fila'}
            </button>
          </form>
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 h-full">
          <h2 className="text-lg font-bold mb-4">Visitas recentes</h2>

          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={searchPhone}
              onChange={(e) => setSearchPhone(e.target.value)}
              placeholder="Buscar por telefone…"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {filteredVisits.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">Nenhuma visita registrada.</p>
            ) : (
              filteredVisits.slice().reverse().map((v) => (
                <div key={v.id} className="bg-slate-800/60 rounded-xl p-3 border border-slate-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-white text-sm">{v.customer_name}</span>
                    <StatusBadge status={v.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {formatPhoneDisplay(v.phone)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(v.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="mt-1.5 text-xs text-amber-400/80">{v.visit_reason}</div>
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
