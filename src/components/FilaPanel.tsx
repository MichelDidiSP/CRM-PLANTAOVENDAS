import { Bell, CheckCircle2, Eye, ArrowLeftRight, Clock, AlertTriangle, UserCheck, History, Home } from 'lucide-react';
import { supabase, type Broker, type QueueEntry } from '@/lib/supabase';
import { isLateForSort, interleaveQueue, reverseInterleaveQueue, nextBrokerFromInverseQueue } from '@/lib/queueEngine';

type Props = {
  queue: QueueEntry[];
  brokers: Broker[];
  allQueue: QueueEntry[];
};

export default function FilaPanel({ queue, brokers, allQueue }: Props) {
  const waiting = queue.filter((e) => e.queue_status === 'aguardando');
  const calling = allQueue.filter((e) => e.queue_status === 'chamando');
  const inAttendance = allQueue.filter((e) => e.queue_status === 'em_atendimento');
  const done = allQueue.filter((e) => e.queue_status === 'concluido');

  const geralWaiting = waiting.filter((e) => e.queue_type === 'geral');
  const decoradoWaiting = waiting.filter((e) => e.queue_type === 'decorado');
  const parceriaWaiting = waiting.filter((e) => e.queue_type === 'parceria');

  const nextEntry = geralWaiting[0];
  const nextDecorado = decoradoWaiting[0];
  const nextParceria = parceriaWaiting[0];

  const reverseQueue = reverseInterleaveQueue(allQueue, brokers);
  const reverseWaiting = reverseQueue.filter((e) => e.queue_status === 'aguardando');

  async function updateEntryToCalling(entry: QueueEntry, brokerId: string | null) {
    const attempts = entry.attempts + 1;
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'chamando', broker_id: brokerId, attempts, called_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', entry.visit_id);
    }
    if (brokerId) {
      await supabase.from('brokers').update({ attendance_status: 'em_mesa', last_status_update: new Date().toISOString() }).eq('id', brokerId);
    }
  }

  async function callNext(entry: QueueEntry) {
    const referredBrokerId = entry.visit?.referred_broker_id ?? null;
    let brokerId: string | null = referredBrokerId;
    if (!brokerId) {
      const availableBroker = brokers.find(
        (b) => !b.is_external_partner && b.agency === entry.agency && b.presence_status === 'presente' && b.attendance_status === 'livre',
      );
      brokerId = availableBroker?.id ?? null;
    }
    await updateEntryToCalling(entry, brokerId);
  }

  async function callDecorado(entry: QueueEntry) {
    const broker = nextBrokerFromInverseQueue(brokers, queue);
    await updateEntryToCalling(entry, broker?.id ?? null);
  }

  async function callParceria(entry: QueueEntry) {
    await updateEntryToCalling(entry, null);
  }

  async function confirmPresence(entry: QueueEntry) {
    await supabase.from('queue_entries').update({ queue_status: 'em_atendimento', updated_at: new Date().toISOString() }).eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'em_atendimento' }).eq('id', entry.visit_id);
    }
  }

  async function markAbsent(entry: QueueEntry) {
    if (entry.broker_id) {
      await supabase.from('brokers').update({ presence_status: 'pausa', attendance_status: 'livre', last_status_update: new Date().toISOString() }).eq('id', entry.broker_id);
    }
    const wasLastAttempt = entry.attempts >= 3;
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'aguardando', broker_id: null, attempts: wasLastAttempt ? 0 : entry.attempts, updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando' }).eq('id', entry.visit_id);
    }
    setTimeout(() => autoRecall(entry, wasLastAttempt), 500);
  }

  async function autoRecall(entry: QueueEntry, _wasLast: boolean) {
    if (entry.queue_type === 'decorado') {
      await callDecorado(entry);
    } else if (entry.queue_type === 'parceria') {
      await callParceria(entry);
    } else {
      await callNext(entry);
    }
  }

  async function conclude(entry: QueueEntry) {
    await supabase.from('queue_entries').update({ queue_status: 'concluido', updated_at: new Date().toISOString() }).eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'encerrado' }).eq('id', entry.visit_id);
    }
    if (entry.broker_id) {
      await supabase.from('brokers').update({ attendance_status: 'livre', last_status_update: new Date().toISOString() }).eq('id', entry.broker_id);
    }
  }

  async function cancelCall(entry: QueueEntry) {
    await supabase.from('queue_entries').update({ queue_status: 'aguardando', updated_at: new Date().toISOString() }).eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando' }).eq('id', entry.visit_id);
    }
    if (entry.broker_id) {
      await supabase.from('brokers').update({ attendance_status: 'livre', last_status_update: new Date().toISOString() }).eq('id', entry.broker_id);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
        <div className="flex items-start gap-3">
          <ArrowLeftRight className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300 space-y-1">
            <p><strong className="text-white">Intercalação:</strong> as listas de Viva Imóveis e Casa Nobre são mescladas alternadamente para formar a Fila Geral.</p>
            <p><strong className="text-white">Visita ao Decorado:</strong> chama o primeiro corretor disponível do topo da Fila Inversa Geral.</p>
            <p><strong className="text-white">Transbordo:</strong> após 3 chamadas sem comparecimento, o corretor é pausado e o sistema chama automaticamente o próximo. O cliente continua ativo.</p>
            <p><strong className="text-white">Parceria:</strong> direcione ao Gerente de Parcerias, sem consumir vez da fila geral.</p>
            <p><strong className="text-white">Penalização:</strong> chegadas após 08:45:59 perdem prioridade e vão para o fim do seu grupo.</p>
          </div>
        </div>
      </div>

      {nextEntry && (
        <div className="bg-gradient-to-r from-amber-500/10 to-sky-500/10 rounded-2xl border border-amber-500/20 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-amber-500/20 p-3 rounded-xl"><Bell className="h-6 w-6 text-amber-400" /></div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Próximo da Fila Geral</p>
              <p className="text-xl font-bold text-white">{nextEntry.visit?.customer_name ?? '—'}</p>
              <p className="text-sm text-slate-400">{nextEntry.agency} · {nextEntry.visit?.visit_reason}</p>
            </div>
          </div>
          <button onClick={() => callNext(nextEntry)} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-6 py-3 rounded-xl transition">
            <Bell className="h-5 w-5" /> Chamar agora
          </button>
        </div>
      )}

      {nextDecorado && (
        <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 rounded-2xl border border-orange-500/20 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-orange-500/20 p-3 rounded-xl"><Home className="h-6 w-6 text-orange-400" /></div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Visita ao Decorado — Fila Inversa</p>
              <p className="text-xl font-bold text-white">{nextDecorado.visit?.customer_name ?? '—'}</p>
              <p className="text-sm text-slate-400">Será chamado o primeiro corretor da fila inversa</p>
            </div>
          </div>
          <button onClick={() => callDecorado(nextDecorado)} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-slate-950 font-bold px-6 py-3 rounded-xl transition">
            <Home className="h-5 w-5" /> Chamar do decorado
          </button>
        </div>
      )}

      {nextParceria && (
        <div className="bg-gradient-to-r from-sky-500/10 to-sky-500/10 rounded-2xl border border-sky-500/20 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-sky-500/20 p-3 rounded-xl"><ArrowLeftRight className="h-6 w-6 text-sky-400" /></div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Parceria — Gerente de Parcerias</p>
              <p className="text-xl font-bold text-white">{nextParceria.visit?.customer_name ?? '—'}</p>
              <p className="text-sm text-slate-400">Não consome vez da fila geral</p>
            </div>
          </div>
          <button onClick={() => callParceria(nextParceria)} className="flex items-center gap-2 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold px-6 py-3 rounded-xl transition">
            <ArrowLeftRight className="h-5 w-5" /> Direcionar ao gerente
          </button>
        </div>
      )}

      {calling.length > 0 && (
        <Section title="Chamando agora — aguardando presença do corretor" icon={<Bell className="h-5 w-5 text-amber-400" />} count={calling.length}>
          {calling.map((entry) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            const late = broker ? isLateForSort(broker.arrived_at) : false;
            const queueLabel = entry.queue_type === 'decorado' ? 'Decorado' : entry.queue_type === 'parceria' ? 'Parceria' : 'Geral';
            return (
              <QueueRow key={entry.id} entry={entry} brokerName={broker?.operational_name} late={late} queueLabel={queueLabel}>
                <button onClick={() => confirmPresence(entry)} className="action-btn bg-sky-500 hover:bg-sky-400 text-slate-950"><UserCheck className="h-4 w-4" /> Confirmar presença</button>
                <button onClick={() => markAbsent(entry)} className="action-btn bg-slate-700 hover:bg-slate-600 text-white"><AlertTriangle className="h-4 w-4" /> {entry.attempts >= 3 ? 'Ausente (3/3) — auto-rechamada' : 'Ausente'}</button>
                <button onClick={() => cancelCall(entry)} className="action-btn bg-slate-800 hover:bg-slate-700 text-slate-400">Cancelar</button>
              </QueueRow>
            );
          })}
        </Section>
      )}

      <Section title="Fila de espera — Geral" icon={<Clock className="h-5 w-5 text-slate-400" />} count={geralWaiting.length}>
        {geralWaiting.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">Ninguém aguardando na fila geral.</p>
        ) : (
          geralWaiting.map((entry, i) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            const late = broker ? isLateForSort(broker.arrived_at) : false;
            return (
              <QueueRow key={entry.id} entry={entry} position={i + 1} brokerName={broker?.operational_name} late={late}>
                <button onClick={() => callNext(entry)} className="action-btn bg-amber-500 hover:bg-amber-400 text-slate-950"><Bell className="h-4 w-4" /> Chamar</button>
              </QueueRow>
            );
          })
        )}
      </Section>

      {inAttendance.length > 0 && (
        <Section title="Em atendimento" icon={<Eye className="h-5 w-5 text-sky-400" />} count={inAttendance.length}>
          {inAttendance.map((entry) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            return (
              <QueueRow key={entry.id} entry={entry} brokerName={broker?.operational_name}>
                <button onClick={() => conclude(entry)} className="action-btn bg-emerald-500 hover:bg-emerald-400 text-slate-950"><CheckCircle2 className="h-4 w-4" /> Concluir</button>
              </QueueRow>
            );
          })}
        </Section>
      )}

      {done.length > 0 && (
        <Section title="Concluídos" icon={<CheckCircle2 className="h-5 w-5 text-emerald-400" />} count={done.length}>
          {done.slice().reverse().map((entry) => (
            <QueueRow key={entry.id} entry={entry} brokerName={brokers.find((b) => b.id === entry.broker_id)?.operational_name} />
          ))}
        </Section>
      )}

      <Section title="Histórico e Auditoria — Fila Inversa Geral" icon={<History className="h-5 w-5 text-slate-400" />} count={reverseWaiting.length}>
        {reverseWaiting.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">Fila inversa vazia.</p>
        ) : (
          reverseWaiting.map((entry, i) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            return (
              <QueueRow key={entry.id} entry={entry} position={i + 1} brokerName={broker?.operational_name} queueLabel="Inversa" />
            );
          })
        )}
      </Section>

      <style>{`
        .action-btn { display: flex; align-items: center; gap: 0.375rem; padding: 0.5rem 0.875rem; border-radius: 0.5rem; font-size: 0.8125rem; font-weight: 600; transition: all 0.15s; white-space: nowrap; }
      `}</style>
    </div>
  );
}

function Section({ title, icon, count, children }: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="font-bold text-slate-200">{title}</h3>
        <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">{count}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function QueueRow({ entry, position, brokerName, late, queueLabel, children }: {
  entry: QueueEntry; position?: number; brokerName?: string; late?: boolean; queueLabel?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-slate-800/50 rounded-xl p-3 border border-slate-700/30">
      {position !== undefined && <span className="text-slate-500 font-mono text-sm w-6 text-center">{position}</span>}
      <div className="flex-1 min-w-[160px]">
        <span className="text-white text-sm font-medium block">{entry.visit?.customer_name ?? '—'}</span>
        <div className="flex items-center gap-2 text-xs mt-0.5">
          <span className={entry.agency === 'Viva Imóveis' ? 'text-amber-400' : entry.agency === 'Casa Nobre' ? 'text-sky-400' : 'text-slate-400'}>{entry.agency}</span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">{entry.visit?.visit_reason}</span>
          {brokerName && (<><span className="text-slate-500">·</span><span className="text-slate-400">{brokerName}</span></>)}
          {queueLabel && (<><span className="text-slate-500">·</span><span className="text-slate-500">{queueLabel}</span></>)}
          {late && <span className="text-red-400 flex items-center gap-0.5"><AlertTriangle className="h-3 w-3" /> atrasado</span>}
        </div>
      </div>
      {entry.attempts > 0 && <span className="text-xs text-slate-500">Tentativas: {entry.attempts}/3</span>}
      <div className="flex items-center gap-2 ml-auto">{children}</div>
    </div>
  );
}
