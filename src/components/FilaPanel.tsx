import { Bell, RotateCcw, X, CheckCircle2, Eye, ArrowLeftRight, Clock, AlertTriangle, UserCheck } from 'lucide-react';
import { supabase, type Broker, type QueueEntry } from '@/lib/supabase';
import { isLateForSort } from '@/lib/queueEngine';

type Props = {
  queue: QueueEntry[];
  brokers: Broker[];
  allQueue: QueueEntry[];
};

export default function FilaPanel({ queue, brokers, allQueue }: Props) {
  const waiting = queue.filter((e) => e.queue_status === 'aguardando');
  const calling = allQueue.filter((e) => e.queue_status === 'chamando');
  const inAttendance = allQueue.filter((e) => e.queue_status === 'em_atendimento');
  const absent = allQueue.filter((e) => e.queue_status === 'ausente');
  const done = allQueue.filter((e) => e.queue_status === 'concluido');

  const nextEntry = waiting[0];

  /**
   * Passo 1 — Chamar: atribui automaticamente o próximo corretor disponível
   * da mesma imobiliária, coloca a visita em "aguardando_chamada" e o corretor
   * em "em_mesa". A TV começa a contar 2 minutos.
   */
  async function callNext(entry: QueueEntry) {
    // Se a visita tem corretor referenciado (Retorno/Indicação), chamar esse corretor.
    // Caso contrário, procurar o próximo corretor livre da mesma imobiliária.
    const referredBrokerId = entry.visit?.referred_broker_id ?? null;
    let brokerId: string | null = referredBrokerId;

    if (!brokerId) {
      const availableBroker = brokers.find(
        (b) =>
          b.agency === entry.agency &&
          b.presence_status === 'presente' &&
          b.attendance_status === 'livre',
      );
      brokerId = availableBroker?.id ?? null;
    }

    const attempts = entry.attempts + 1;

    await supabase
      .from('queue_entries')
      .update({
        queue_status: 'chamando',
        broker_id: brokerId,
        attempts,
        called_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id);

    if (entry.visit_id) {
      await supabase
        .from('visits')
        .update({ status: 'aguardando_chamada' })
        .eq('id', entry.visit_id);
    }

    if (brokerId) {
      await supabase
        .from('brokers')
        .update({
          attendance_status: 'em_mesa',
          last_status_update: new Date().toISOString(),
        })
        .eq('id', brokerId);
    }
  }

  /**
   * Passo 2 — Confirmar Presença: o corretor compareceu. A visita entra em
   * "em_atendimento" e o corretor permanece "em_mesa".
   */
  async function confirmPresence(entry: QueueEntry) {
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'em_atendimento', updated_at: new Date().toISOString() })
      .eq('id', entry.id);

    if (entry.visit_id) {
      await supabase
        .from('visits')
        .update({ status: 'em_atendimento' })
        .eq('id', entry.visit_id);
    }
  }

  /**
   * Passo 3 — Ausente / Penalização: se ainda há tentativas, o corretor volta
   * para "livre" e o cliente vai para reentrada. Após 3 tentativas, o cliente
   * é recusado e o corretor volta a "livre".
   */
  async function markAbsent(entry: QueueEntry) {
    if (entry.broker_id) {
      await supabase
        .from('brokers')
        .update({
          attendance_status: 'livre',
          last_status_update: new Date().toISOString(),
        })
        .eq('id', entry.broker_id);
    }

    if (entry.attempts >= 3) {
      await supabase
        .from('queue_entries')
        .update({ queue_status: 'concluido', updated_at: new Date().toISOString() })
        .eq('id', entry.id);
      if (entry.visit_id) {
        await supabase.from('visits').update({ status: 'recusado' }).eq('id', entry.visit_id);
      }
    } else {
      await supabase
        .from('queue_entries')
        .update({
          queue_status: 'ausente',
          reentry_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', entry.id);
      if (entry.visit_id) {
        await supabase.from('visits').update({ status: 'aguardando' }).eq('id', entry.visit_id);
      }
    }
  }

  async function reentry(entry: QueueEntry) {
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'aguardando', updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando' }).eq('id', entry.visit_id);
    }
  }

  async function conclude(entry: QueueEntry) {
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'concluido', updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'encerrado' }).eq('id', entry.visit_id);
    }
    if (entry.broker_id) {
      await supabase
        .from('brokers')
        .update({ attendance_status: 'livre', last_status_update: new Date().toISOString() })
        .eq('id', entry.broker_id);
    }
  }

  async function cancelCall(entry: QueueEntry) {
    await supabase
      .from('queue_entries')
      .update({ queue_status: 'aguardando', updated_at: new Date().toISOString() })
      .eq('id', entry.id);
    if (entry.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando' }).eq('id', entry.visit_id);
    }
    if (entry.broker_id) {
      await supabase
        .from('brokers')
        .update({ attendance_status: 'livre', last_status_update: new Date().toISOString() })
        .eq('id', entry.broker_id);
    }
  }

  return (
    <div className="space-y-6">
      {/* Explanation */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
        <div className="flex items-start gap-3">
          <ArrowLeftRight className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300 space-y-1">
            <p><strong className="text-white">Intercalação:</strong> as listas de Viva Imóveis e Casa Nobre são mescladas alternadamente para formar a fila geral.</p>
            <p><strong className="text-white">Fluxo de chamada:</strong> Chamar → TV exibe corretor com cronômetro de 2 min → Confirmar Presença → Em Atendimento → Concluir.</p>
            <p><strong className="text-white">Reentrada:</strong> corretores ausentes vão para o final da fila, ordenados por carimbo de data/hora. Após 3 tentativas, o cliente é recusado.</p>
            <p><strong className="text-white">Penalização:</strong> chegadas após 08:45:59 perdem prioridade e vão para o fim do seu grupo.</p>
          </div>
        </div>
      </div>

      {/* Next call highlight */}
      {nextEntry && (
        <div className="bg-gradient-to-r from-amber-500/10 to-sky-500/10 rounded-2xl border border-amber-500/20 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-amber-500/20 p-3 rounded-xl">
              <Bell className="h-6 w-6 text-amber-400" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Próximo a ser chamado</p>
              <p className="text-xl font-bold text-white">{nextEntry.visit?.customer_name ?? '—'}</p>
              <p className="text-sm text-slate-400">{nextEntry.agency} · {nextEntry.visit?.visit_reason}</p>
            </div>
          </div>
          <button
            onClick={() => callNext(nextEntry)}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-6 py-3 rounded-xl transition"
          >
            <Bell className="h-5 w-5" />
            Chamar agora
          </button>
        </div>
      )}

      {/* Currently calling */}
      {calling.length > 0 && (
        <Section title="Chamando agora — aguardando presença do corretor" icon={<Bell className="h-5 w-5 text-amber-400" />} count={calling.length}>
          {calling.map((entry) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            const late = broker ? isLateForSort(broker.arrived_at) : false;
            return (
              <QueueRow key={entry.id} entry={entry} brokerName={broker?.operational_name} late={late}>
                <button onClick={() => confirmPresence(entry)} className="action-btn bg-sky-500 hover:bg-sky-400 text-slate-950">
                  <UserCheck className="h-4 w-4" /> Confirmar presença
                </button>
                <button onClick={() => markAbsent(entry)} className="action-btn bg-slate-700 hover:bg-slate-600 text-white">
                  <AlertTriangle className="h-4 w-4" /> {entry.attempts >= 3 ? 'Recusar (3/3)' : 'Ausente'}
                </button>
                <button onClick={() => cancelCall(entry)} className="action-btn bg-slate-800 hover:bg-slate-700 text-slate-400">
                  <X className="h-4 w-4" /> Cancelar
                </button>
              </QueueRow>
            );
          })}
        </Section>
      )}

      {/* Waiting queue */}
      <Section title="Fila de espera" icon={<Clock className="h-5 w-5 text-slate-400" />} count={waiting.length}>
        {waiting.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6">Ninguém aguardando.</p>
        ) : (
          waiting.map((entry, i) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            const late = broker ? isLateForSort(broker.arrived_at) : false;
            return (
              <QueueRow key={entry.id} entry={entry} position={i + 1} brokerName={broker?.operational_name} late={late}>
                <button onClick={() => callNext(entry)} className="action-btn bg-amber-500 hover:bg-amber-400 text-slate-950">
                  <Bell className="h-4 w-4" /> Chamar
                </button>
              </QueueRow>
            );
          })
        )}
      </Section>

      {/* In attendance */}
      {inAttendance.length > 0 && (
        <Section title="Em atendimento" icon={<Eye className="h-5 w-5 text-sky-400" />} count={inAttendance.length}>
          {inAttendance.map((entry) => {
            const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
            return (
              <QueueRow key={entry.id} entry={entry} brokerName={broker?.operational_name}>
                <button onClick={() => conclude(entry)} className="action-btn bg-emerald-500 hover:bg-emerald-400 text-slate-950">
                  <CheckCircle2 className="h-4 w-4" /> Concluir
                </button>
              </QueueRow>
            );
          })}
        </Section>
      )}

      {/* Absent / reentry */}
      {absent.length > 0 && (
        <Section title="Ausentes — reentrada pendente" icon={<RotateCcw className="h-5 w-5 text-red-400" />} count={absent.length}>
          {absent.map((entry) => (
            <QueueRow key={entry.id} entry={entry} brokerName={brokers.find((b) => b.id === entry.broker_id)?.operational_name}>
              <button onClick={() => reentry(entry)} className="action-btn bg-amber-500 hover:bg-amber-400 text-slate-950">
                <RotateCcw className="h-4 w-4" /> Reentrar na fila
              </button>
            </QueueRow>
          ))}
        </Section>
      )}

      {/* Done */}
      {done.length > 0 && (
        <Section title="Concluídos" icon={<CheckCircle2 className="h-5 w-5 text-emerald-400" />} count={done.length}>
          {done.slice().reverse().map((entry) => (
            <QueueRow key={entry.id} entry={entry} brokerName={brokers.find((b) => b.id === entry.broker_id)?.operational_name} />
          ))}
        </Section>
      )}

      <style>{`
        .action-btn {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.5rem 0.875rem;
          border-radius: 0.5rem;
          font-size: 0.8125rem;
          font-weight: 600;
          transition: all 0.15s;
          white-space: nowrap;
        }
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

function QueueRow({
  entry,
  position,
  brokerName,
  late,
  children,
}: {
  entry: QueueEntry;
  position?: number;
  brokerName?: string;
  late?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-slate-800/50 rounded-xl p-3 border border-slate-700/30">
      {position !== undefined && (
        <span className="text-slate-500 font-mono text-sm w-6 text-center">{position}</span>
      )}
      <div className="flex-1 min-w-[160px]">
        <span className="text-white text-sm font-medium block">{entry.visit?.customer_name ?? '—'}</span>
        <div className="flex items-center gap-2 text-xs mt-0.5">
          <span className={entry.agency === 'Viva Imóveis' ? 'text-amber-400' : 'text-sky-400'}>{entry.agency}</span>
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">{entry.visit?.visit_reason}</span>
          {brokerName && (
            <>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{brokerName}</span>
            </>
          )}
          {late && <span className="text-red-400 flex items-center gap-0.5"><AlertTriangle className="h-3 w-3" /> atrasado</span>}
        </div>
      </div>
      {entry.attempts > 0 && (
        <span className="text-xs text-slate-500">Tentativas: {entry.attempts}/3</span>
      )}
      {entry.reentry_at && (
        <span className="text-xs text-red-400/80">
          Reentra: {new Date(entry.reentry_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      <div className="flex items-center gap-2 ml-auto">{children}</div>
    </div>
  );
}
