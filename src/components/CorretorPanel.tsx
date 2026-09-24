import { useState } from 'react';
import { UserCheck, UserX, Clock, Coffee, Table2, Chrome as Home, CircleCheck as CheckCircle, Plus, Trash2, ExternalLink, Users as Users2, Sun, Moon, Bookmark } from 'lucide-react';
import { supabase, type Broker, type BrokerPresence, type AttendanceStatus, type Agency, type Shift } from '@/lib/supabase';
import { AGENCIES, isLateForSort } from '@/lib/queueEngine';
import { useSim } from '@/lib/simContext';

type Props = { brokers: Broker[] };

export default function CorretorPanel({ brokers }: Props) {
  const { getCurrentTime, clockDisplay, currentShift, isCheckinOpen, isPreSorteio } = useSim();
  const [showAdd, setShowAdd] = useState(false);
  const [showAddPartner, setShowAddPartner] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAgency, setNewAgency] = useState<Agency>('Viva Imóveis');
  const [partnerName, setPartnerName] = useState('');
  const [partnerCompany, setPartnerCompany] = useState('');
  const [error, setError] = useState<string | null>(null);

  const internalBrokers = brokers.filter((b) => !b.is_external_partner);
  const partnerBrokersList = brokers.filter((b) => b.is_external_partner);

  const present = internalBrokers.filter((b) => b.presence_status !== 'ausente');
  const absent = internalBrokers.filter((b) => b.presence_status === 'ausente');
  const lateCount = present.filter((b) => isLateForSort(b.arrived_at, b.shift ?? currentShift)).length;
  const reservedCount = internalBrokers.filter((b) => b.afternoon_reserved).length;

  async function updatePresence(broker: Broker, status: BrokerPresence) {
    const now = getCurrentTime().toISOString();
    const updates: Partial<Broker> & { last_status_update: string } = { presence_status: status, last_status_update: now };
    if (status === 'presente' && !broker.arrived_at) {
      updates.arrived_at = now;
      updates.shift = currentShift;
      const isLate = isLateForSort(now, currentShift);
      if (isLate) {
        const sameShift = internalBrokers.filter((b) => b.shift === currentShift && b.sorteio_order != null);
        const maxOrder = sameShift.length > 0 ? Math.max(...sameShift.map((b) => b.sorteio_order ?? 0)) : 0;
        updates.sorteio_order = maxOrder + 1;
      }
    }
    await supabase.from('brokers').update(updates).eq('id', broker.id);
  }

  async function updateAttendance(broker: Broker, status: AttendanceStatus) {
    await supabase.from('brokers').update({ attendance_status: status, last_status_update: getCurrentTime().toISOString() }).eq('id', broker.id);
  }

  async function addBroker(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const { error } = await supabase.from('brokers').insert({ operational_name: newName.trim(), agency: newAgency, presence_status: 'ausente', attendance_status: 'livre', is_external_partner: false });
    if (error) { setError('Erro ao adicionar corretor.'); }
    else { setNewName(''); setShowAdd(false); setError(null); }
  }

  async function addPartnerBroker(e: React.FormEvent) {
    e.preventDefault();
    if (!partnerName.trim()) return;
    const { error } = await supabase.from('brokers').insert({ operational_name: partnerName.trim(), agency: 'Externo', presence_status: 'ausente', attendance_status: 'parceiro', is_external_partner: true, external_company: partnerCompany.trim() || null });
    if (error) { setError('Erro ao adicionar corretor parceiro.'); }
    else { setPartnerName(''); setPartnerCompany(''); setShowAddPartner(false); setError(null); }
  }

  async function removeBroker(id: string) {
    await supabase.from('brokers').delete().eq('id', id);
  }

  const sorteioTime = currentShift === 'manha' ? '08:46:00' : '13:46:00';
  const checkinLabel = currentShift === 'manha' ? '08:00–08:45:59' : '13:00–13:45:59';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <SummaryCard icon={<UserCheck className="h-5 w-5" />} label="Presentes" value={present.length} color="text-emerald-400" />
        <SummaryCard icon={<UserX className="h-5 w-5" />} label="Ausentes" value={absent.length} color="text-slate-400" />
        <SummaryCard icon={<Clock className="h-5 w-5" />} label="Atrasados" value={lateCount} color="text-red-400" />
        <SummaryCard icon={<Coffee className="h-5 w-5" />} label="Em pausa" value={present.filter((b) => b.presence_status === 'pausa').length} color="text-amber-400" />
        <SummaryCard icon={<ExternalLink className="h-5 w-5" />} label="Parceiros" value={partnerBrokersList.length} color="text-sky-400" />
        <SummaryCard icon={<Bookmark className="h-5 w-5" />} label="Vagas reservadas" value={reservedCount} color="text-indigo-400" />
      </div>

      {/* Shift info banner */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 flex items-center gap-3">
        {currentShift === 'manha' ? <Sun className="h-5 w-5 text-amber-400 shrink-0" /> : <Moon className="h-5 w-5 text-indigo-400 shrink-0" />}
        <p className="text-sm text-slate-300">
          <strong className="text-white">Turno {currentShift === 'manha' ? 'Manhã' : 'Tarde'}:</strong> Check-in válido de {checkinLabel}. Sorteio automático às <strong className="text-amber-400">{sorteioTime}</strong>.
          {isPreSorteio && <span className="block mt-1 text-sky-400">Período Pré-Sorteio ativo — atendimento por ordem de chegada.</span>}
          {!isCheckinOpen && !isPreSorteio && <span className="block mt-1 text-slate-500">Check-in fechado neste horário.</span>}
          <span className="block mt-1 text-amber-400">Relógio do plantão: {clockDisplay}</span>
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {showAdd ? (
          <form onSubmit={addBroker} className="bg-slate-900 rounded-2xl border border-slate-800 p-5 flex flex-wrap items-end gap-3 w-full">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm text-slate-400 mb-1">Nome operacional</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nome do corretor" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Imobiliária</label>
              <select value={newAgency} onChange={(e) => setNewAgency(e.target.value as Agency)} className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-amber-500">
                {AGENCIES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <button type="submit" className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-5 py-2.5 rounded-xl transition">Adicionar</button>
            <button type="button" onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white px-3 py-2.5">Cancelar</button>
            {error && <p className="w-full text-sm text-red-400">{error}</p>}
          </form>
        ) : (
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium px-5 py-2.5 rounded-xl transition">
            <Plus className="h-5 w-5" /> Adicionar corretor
          </button>
        )}

        {showAddPartner ? (
          <form onSubmit={addPartnerBroker} className="bg-slate-900 rounded-2xl border border-sky-500/20 p-5 flex flex-wrap items-end gap-3 w-full">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm text-slate-400 mb-1">Nome do corretor parceiro</label>
              <input type="text" value={partnerName} onChange={(e) => setPartnerName(e.target.value)} placeholder="Nome do corretor autônomo ou externo" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-sm text-slate-400 mb-1">Empresa / Imobiliária externa (opcional)</label>
              <input type="text" value={partnerCompany} onChange={(e) => setPartnerCompany(e.target.value)} placeholder="Ex: Imobiliária ABC ou Autônomo" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500" />
            </div>
            <button type="submit" className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold px-5 py-2.5 rounded-xl transition">Adicionar parceiro</button>
            <button type="button" onClick={() => setShowAddPartner(false)} className="text-slate-400 hover:text-white px-3 py-2.5">Cancelar</button>
          </form>
        ) : (
          <button onClick={() => setShowAddPartner(true)} className="flex items-center gap-2 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 font-medium px-5 py-2.5 rounded-xl transition border border-sky-500/20">
            <ExternalLink className="h-5 w-5" /> Adicionar corretor parceiro externo
          </button>
        )}
      </div>

      <div>
        <h3 className="text-sm font-bold text-slate-300 mb-3 flex items-center gap-2"><Users2 className="h-4 w-4" /> Corretores internos</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {internalBrokers.map((broker) => {
            const late = broker.presence_status === 'presente' && isLateForSort(broker.arrived_at, broker.shift ?? currentShift);
            return (
              <div key={broker.id} className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-bold text-white text-lg">{broker.operational_name}</h3>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${broker.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{broker.agency}</span>
                      {late && <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Atrasado</span>}
                      {broker.afternoon_reserved && <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400">Vaga reservada tarde</span>}
                      {broker.shift && <span className={`text-xs px-2 py-0.5 rounded-full ${broker.shift === 'manha' ? 'bg-amber-500/15 text-amber-400' : 'bg-indigo-500/15 text-indigo-400'}`}>{broker.shift === 'manha' ? 'Manhã' : 'Tarde'}</span>}
                    </div>
                    {broker.arrived_at && <p className="text-xs text-slate-500 mt-1">Chegada: {new Date(broker.arrived_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>}
                  </div>
                  <button onClick={() => removeBroker(broker.id)} className="text-slate-600 hover:text-red-400 transition p-1" title="Remover corretor"><Trash2 className="h-4 w-4" /></button>
                </div>
                <div className="mb-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Presença</p>
                  <div className="flex gap-2">
                    <PresenceButton active={broker.presence_status === 'presente'} onClick={() => updatePresence(broker, 'presente')} icon={<UserCheck className="h-4 w-4" />} label="Presente" color="emerald" />
                    <PresenceButton active={broker.presence_status === 'pausa'} onClick={() => updatePresence(broker, 'pausa')} icon={<Coffee className="h-4 w-4" />} label="Pausa" color="amber" />
                    <PresenceButton active={broker.presence_status === 'ausente'} onClick={() => updatePresence(broker, 'ausente')} icon={<UserX className="h-4 w-4" />} label="Ausente" color="slate" />
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Atendimento</p>
                  <div className="flex flex-wrap gap-2">
                    <AttendanceButton active={broker.attendance_status === 'livre'} onClick={() => updateAttendance(broker, 'livre')} icon={<UserCheck className="h-4 w-4" />} label="Livre" />
                    <AttendanceButton active={broker.attendance_status === 'em_mesa'} onClick={() => updateAttendance(broker, 'em_mesa')} icon={<Table2 className="h-4 w-4" />} label="Em mesa" />
                    <AttendanceButton active={broker.attendance_status === 'decorado'} onClick={() => updateAttendance(broker, 'decorado')} icon={<Home className="h-4 w-4" />} label="Decorado" />
                    <AttendanceButton active={broker.attendance_status === 'encerrado'} onClick={() => updateAttendance(broker, 'encerrado')} icon={<CheckCircle className="h-4 w-4" />} label="Encerrado" />
                  </div>
                </div>
              </div>
            );
          })}
          {internalBrokers.length === 0 && <div className="col-span-2 text-center py-12 text-slate-500">Nenhum corretor interno cadastrado. Clique em "Adicionar corretor" para começar.</div>}
        </div>
      </div>

      {partnerBrokersList.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-slate-300 mb-3 flex items-center gap-2"><ExternalLink className="h-4 w-4 text-sky-400" /> Corretores parceiros externos</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {partnerBrokersList.map((broker) => (
              <div key={broker.id} className="bg-slate-900 rounded-2xl border border-sky-500/20 p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-bold text-white text-lg">{broker.operational_name}</h3>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400">Parceiro Externo</span>
                    {broker.external_company && <p className="text-xs text-slate-500 mt-1">{broker.external_company}</p>}
                  </div>
                  <button onClick={() => removeBroker(broker.id)} className="text-slate-600 hover:text-red-400 transition p-1" title="Remover corretor"><Trash2 className="h-4 w-4" /></button>
                </div>
                <p className="text-xs text-slate-400">Atendimento via Gerente de Parcerias. Não consome vez na fila geral nem tem acesso ao CRM.</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
      <div className={`flex items-center gap-2 mb-2 ${color}`}>{icon}<span className="text-sm text-slate-400">{label}</span></div>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function PresenceButton({ active, onClick, icon, label, color }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; color: 'emerald' | 'amber' | 'slate' }) {
  const colors = {
    emerald: active ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-emerald-400',
    amber: active ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-amber-400',
    slate: active ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white',
  };
  return <button onClick={onClick} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${colors[color]}`}>{icon}{label}</button>;
}

function AttendanceButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return <button onClick={onClick} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${active ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-sky-400'}`}>{icon}{label}</button>;
}
