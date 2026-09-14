import { useState, useRef } from 'react';
import { UserPlus, Phone, TriangleAlert as AlertTriangle, CircleCheck as CheckCircle2, Clock, Search, EyeOff, Eye, Zap, UserCheck, UserX, Building2 } from 'lucide-react';
import { supabase, type Broker, type Visit, type VisitReason, type Agency } from '@/lib/supabase';
import { REASONS, sanitizePhone, formatPhoneDisplay, lastBrokerFromAgency } from '@/lib/queueEngine';
import { useSim } from '@/lib/simContext';

type QuickReason = VisitReason | 'Indicação Presente' | 'Indicação Ausente' | 'Indicação Imobiliária';

type Props = {
  brokers: Broker[];
  visits: Visit[];
};

export default function RecepcaoPanel({ brokers, visits }: Props) {
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState<VisitReason>('Primeira visita');
  const [agency, setAgency] = useState<Agency>('Viva Imóveis');
  const [referredBrokerId, setReferredBrokerId] = useState<string>('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchPhone, setSearchPhone] = useState('');
  const [revealed, setRevealed] = useState(false);
  const { currentShift } = useSim();
  const [quickReason, setQuickReason] = useState<QuickReason>('Primeira visita');
  const [quickAgency, setQuickAgency] = useState<Agency>('Viva Imóveis');
  const [quickBrokerId, setQuickBrokerId] = useState<string>('');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const quickCounterRef = useRef(0);

  const isIndicacaoPresente = quickReason === 'Indicação Presente';
  const isIndicacaoAusente = quickReason === 'Indicação Ausente';
  const isIndicacaoImobiliaria = quickReason === 'Indicação Imobiliária';
  const isAnyIndicacao = isIndicacaoPresente || isIndicacaoAusente || isIndicacaoImobiliaria;
  const needsBrokerSelect = isIndicacaoPresente || isIndicacaoAusente;
  const needsAgencySelect = !isIndicacaoPresente && quickReason !== 'Parceria' && quickReason !== 'Visita ao Decorado';

  const availableBrokersForQuick = brokers.filter(
    (b) => !b.is_external_partner && b.agency === quickAgency && b.presence_status !== 'ausente',
  );
  const presentBrokersForQuick = brokers.filter(
    (b) => !b.is_external_partner && b.agency === quickAgency && b.presence_status === 'presente',
  );

  const normalizedPhone = sanitizePhone(phone);
  const duplicate = visits.find((v) => v.phone === normalizedPhone && v.status !== 'encerrado' && normalizedPhone.length > 0);

  const isParceria = reason === 'Parceria';
  const isDecorado = reason === 'Visita ao Decorado';

  const partnerBrokers = brokers.filter((b) => b.is_external_partner);
  const agencyBrokers = brokers.filter((b) => b.agency === agency && !b.is_external_partner);

  const filteredVisits = searchPhone
    ? visits.filter((v) => v.phone.includes(sanitizePhone(searchPhone)))
    : visits;

  function handleReasonChange(newReason: VisitReason) {
    setReason(newReason);
    setRevealed(false);
    setMessage(null);
    if (newReason === 'Parceria') {
      setAgency('Externo');
    } else if (newReason === 'Visita ao Decorado') {
      setAgency('Viva Imóveis');
    }
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

    const queueType = isParceria ? 'parceria' : isDecorado ? 'decorado' : 'geral';

    const { data: visitData, error: visitError } = await supabase
      .from('visits')
      .insert({
        customer_name: customerName.trim(),
        phone: normalizedPhone,
        visit_reason: reason,
        referred_broker_id: referredBrokerId || null,
        status: 'aguardando',
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
      agency,
      queue_status: 'aguardando',
      attempts: 0,
      queue_type: queueType,
    });

    if (queueError) {
      setMessage({ type: 'error', text: 'Visita criada, mas erro ao entrar na fila.' });
    } else {
      const successMsg = isParceria
        ? `${customerName.trim()} foi cadastrado como Parceria e será direcionado ao Gerente de Parcerias.`
        : isDecorado
        ? `${customerName.trim()} foi cadastrado para Visita ao Decorado. O sistema chamará o próximo corretor da fila inversa.`
        : `${customerName.trim()} foi cadastrado e entrou na fila.`;

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
    const seq = quickCounterRef.current;
    const fakeName = `Cliente Rápido #${seq}`;
    const fakePhone = `119${String(90000000 + seq).padStart(8, '0')}`;

    const isParceriaQuick = quickReason === 'Parceria';
    const isDecoradoQuick = quickReason === 'Visita ao Decorado';
    const queueType = isParceriaQuick ? 'parceria' : isDecoradoQuick ? 'decorado' : 'geral';
    const entryAgency: Agency = isParceriaQuick ? 'Externo' : isDecoradoQuick ? 'Viva Imóveis' : quickAgency;

    // Determine referred broker and visit reason for DB
    let referredBrokerId: string | null = null;
    let dbVisitReason: VisitReason = quickReason as VisitReason;

    if (isIndicacaoPresente) {
      referredBrokerId = quickBrokerId || null;
      dbVisitReason = 'Indicação';
    } else if (isIndicacaoAusente) {
      referredBrokerId = quickBrokerId || null;
      dbVisitReason = 'Indicação';
    } else if (isIndicacaoImobiliaria) {
      dbVisitReason = 'Indicação';
    }

    const { data: visitData, error: visitError } = await supabase
      .from('visits')
      .insert({
        customer_name: fakeName,
        phone: fakePhone,
        visit_reason: dbVisitReason,
        referred_broker_id: referredBrokerId,
        status: 'aguardando',
      })
      .select()
      .single();

    if (visitError || !visitData) {
      setQuickSubmitting(false);
      return;
    }

    // Determine broker assignment for the queue entry
    let assignedBrokerId: string | null = null;
    let skipPositionConsumption = false;

    if (isIndicacaoPresente) {
      // Rule 1: goes directly to the referred broker, does NOT consume their vez
      const referred = brokers.find((b) => b.id === quickBrokerId);
      if (referred && referred.presence_status === 'presente' && referred.attendance_status === 'livre') {
        assignedBrokerId = referred.id;
        skipPositionConsumption = true;
      }
    } else if (isIndicacaoAusente) {
      // Rule 2: referred broker is absent → last available broker of same agency
      const referred = brokers.find((b) => b.id === quickBrokerId);
      const targetAgency = referred?.agency ?? quickAgency;
      const busyIds = new Set<string>();
      const lastBroker = lastBrokerFromAgency(brokers, targetAgency, busyIds);
      assignedBrokerId = lastBroker?.id ?? null;
    } else if (isIndicacaoImobiliaria) {
      // Rule 3: only knows agency → last available broker of that agency
      const busyIds = new Set<string>();
      const lastBroker = lastBrokerFromAgency(brokers, quickAgency, busyIds);
      assignedBrokerId = lastBroker?.id ?? null;
    }

    const insertData: Record<string, unknown> = {
      visit_id: visitData.id,
      agency: entryAgency,
      queue_status: assignedBrokerId ? 'chamando' : 'aguardando',
      attempts: assignedBrokerId ? 1 : 0,
      queue_type: queueType,
      shift: currentShift,
      broker_id: assignedBrokerId,
      called_at: assignedBrokerId ? new Date().toISOString() : null,
    };

    await supabase.from('queue_entries').insert(insertData);

    if (assignedBrokerId) {
      await supabase
        .from('brokers')
        .update({ attendance_status: 'em_mesa', last_status_update: new Date().toISOString() })
        .eq('id', assignedBrokerId);
      if (visitData.id) {
        await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', visitData.id);
      }
    }

    setQuickSubmitting(false);
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
              <p className="text-sm text-slate-400">Gera um cliente fictício e envia direto para a fila — para testes de mesa</p>
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
                <option value="Indicação Presente">Indicação: Sabe Corretor (Presente)</option>
                <option value="Indicação Ausente">Indicação: Sabe Corretor (Ausente)</option>
                <option value="Indicação Imobiliária">Indicação: Sabe Apenas a Imobiliária</option>
              </select>
            </div>

            {needsAgencySelect && (
              <div className="min-w-[140px]">
                <label className="block text-xs text-slate-400 mb-1">Imobiliária</label>
                <select
                  value={quickAgency}
                  onChange={(e) => { setQuickAgency(e.target.value as Agency); setQuickBrokerId(''); }}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="Viva Imóveis">Viva Imóveis</option>
                  <option value="Casa Nobre">Casa Nobre</option>
                </select>
              </div>
            )}

            {needsBrokerSelect && (
              <div className="min-w-[180px]">
                <label className="block text-xs text-slate-400 mb-1">Corretor indicado</label>
                <select
                  value={quickBrokerId}
                  onChange={(e) => setQuickBrokerId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="">Selecione um corretor…</option>
                  {(isIndicacaoAusente ? availableBrokersForQuick : presentBrokersForQuick).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.operational_name} {b.presence_status === 'presente' ? '(Presente)' : '(Ausente)'}
                    </option>
                  ))}
                </select>
                {isIndicacaoAusente && availableBrokersForQuick.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">Nenhum corretor cadastrado nesta imobiliária.</p>
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
                  Regra 1: Vai direto ao corretor. Não consome a vez na roleta.
                </span>
              )}
              {isIndicacaoAusente && (
                <span className="flex items-center gap-1.5 text-xs bg-orange-500/10 text-orange-400 px-3 py-1.5 rounded-lg">
                  <UserX className="h-3.5 w-3.5" />
                  Regra 2: Corretor ausente → último disponível da mesma imobiliária. Consome a vez.
                </span>
              )}
              {isIndicacaoImobiliaria && (
                <span className="flex items-center gap-1.5 text-xs bg-sky-500/10 text-sky-400 px-3 py-1.5 rounded-lg">
                  <Building2 className="h-3.5 w-3.5" />
                  Regra 3: Só a marca → último disponível da imobiliária. Consome a vez.
                </span>
              )}
            </div>
          )}
        </div>

        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-amber-500/10 p-3 rounded-xl">
              <UserPlus className="h-6 w-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Cadastro de Chegada</h2>
              <p className="text-sm text-slate-400">Registre o cliente e envie para a fila</p>
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

              {!isParceria && !isDecorado && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Imobiliária da fila</label>
                  <select
                    value={agency}
                    onChange={(e) => setAgency(e.target.value as Agency)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                  >
                    <option value="Viva Imóveis">Viva Imóveis</option>
                    <option value="Casa Nobre">Casa Nobre</option>
                  </select>
                </div>
              )}
            </div>

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
                  {agencyBrokers.map((b) => (
                    <option key={b.id} value={b.id}>{b.operational_name}</option>
                  ))}
                </select>
              </div>
            )}

            {!revealed && !isParceria && !isDecorado && (
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-800/40 rounded-lg p-2.5">
                <EyeOff className="h-4 w-4 shrink-0" />
                <span>A imobiliária e o corretor da vez são ocultados até o cadastro ser concluído.</span>
              </div>
            )}

            {revealed && message?.type === 'success' && !isParceria && !isDecorado && (
              <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-lg p-2.5">
                <Eye className="h-4 w-4 shrink-0" />
                <span>Cliente na fila da <strong>{agency}</strong>. O corretor da vez será definido no Motor da Fila.</span>
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
