import { useState } from 'react';
import { UserPlus, Phone, AlertTriangle, CheckCircle2, Clock, Search } from 'lucide-react';
import { supabase, type Broker, type Visit, type VisitReason, type Agency } from '@/lib/supabase';
import { REASONS, AGENCIES, formatPhoneDisplay } from '@/lib/queueEngine';

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
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchPhone, setSearchPhone] = useState('');

  const normalizedPhone = phone.replace(/\D/g, '');
  const duplicate = visits.find((v) => v.phone === normalizedPhone && v.status !== 'encerrado');

  const agencyBrokers = brokers.filter((b) => b.agency === agency);
  const filteredVisits = searchPhone
    ? visits.filter((v) => v.phone.includes(searchPhone.replace(/\D/g, '')))
    : visits;

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
    });

    if (queueError) {
      setMessage({ type: 'error', text: 'Visita criada, mas erro ao entrar na fila.' });
    } else {
      setMessage({ type: 'success', text: `${customerName.trim()} foi cadastrado e entrou na fila da ${agency}.` });
      setCustomerName('');
      setPhone('');
      setReferredBrokerId('');
    }
    setSubmitting(false);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3">
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
                <span className="ml-2 text-xs text-slate-500">chave anti-duplicidade</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-500" />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(11) 91234-5678"
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
                  onChange={(e) => setReason(e.target.value as VisitReason)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                >
                  {REASONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Imobiliária da fila</label>
                <select
                  value={agency}
                  onChange={(e) => setAgency(e.target.value as Agency)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 transition"
                >
                  {AGENCIES.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            </div>

            {(reason === 'Indicação' || reason === 'Retorno') && (
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

            {message && (
              <div
                className={`flex items-start gap-2 text-sm rounded-lg p-3 ${
                  message.type === 'success'
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : message.type === 'warning'
                    ? 'text-amber-400 bg-amber-500/10'
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
