import { useEffect, useState, useRef, useCallback } from 'react';
import { Volume2, VolumeX, Timer, Users, Building2, Zap, Chrome as Home, ArrowLeftRight, TriangleAlert as AlertTriangle, History } from 'lucide-react';
import { supabase, type Broker, type QueueEntry, type Agency } from '@/lib/supabase';
import { formatTime, nextBrokerFromInverseTop, nextBrokerFromAgency, nextBrokerByArrival } from '@/lib/queueEngine';
import { useSim } from '@/lib/simContext';

type Props = {
  queue: QueueEntry[];
  brokers: Broker[];
};

export default function ChamadasPanel({ queue, brokers }: Props) {
  const { callDuration, testMode } = useSim();
  const [currentCall, setCurrentCall] = useState<QueueEntry | null>(null);
  const [remaining, setRemaining] = useState(callDuration);
  const [attempts, setAttempts] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [calling, setCalling] = useState(false);
  const [autoRecallNotice, setAutoRecallNotice] = useState<string | null>(null);
  const intervalRef = useRef<number | undefined>(undefined);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timeoutFiredRef = useRef(false);

  useEffect(() => {
    const calling_entry = queue.find((e) => e.queue_status === 'chamando');
    if (calling_entry && (!currentCall || currentCall.id !== calling_entry.id)) {
      setCurrentCall(calling_entry);
      setRemaining(callDuration);
      setAttempts(calling_entry.attempts);
      setCalling(true);
      setAutoRecallNotice(null);
      timeoutFiredRef.current = false;
      playAlert();
    } else if (!calling_entry && currentCall) {
      setCurrentCall(null);
      setCalling(false);
      setAutoRecallNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, currentCall]);

  useEffect(() => {
    if (calling && remaining > 0) {
      intervalRef.current = window.setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            window.clearInterval(intervalRef.current);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
      return () => {
        if (intervalRef.current) window.clearInterval(intervalRef.current);
      };
    }
  }, [calling, remaining]);

  const handleTimeout = useCallback(async () => {
    if (!currentCall || timeoutFiredRef.current) return;
    timeoutFiredRef.current = true;

    // Pausar o corretor que não compareceu
    if (currentCall.broker_id) {
      await supabase
        .from('brokers')
        .update({
          presence_status: 'pausa',
          attendance_status: 'livre',
          last_status_update: new Date().toISOString(),
        })
        .eq('id', currentCall.broker_id);
    }

    const wasLastAttempt = currentCall.attempts >= 3;

    // Cliente continua ativo — volta para aguardando
    await supabase
      .from('queue_entries')
      .update({
        queue_status: 'aguardando',
        broker_id: null,
        attempts: wasLastAttempt ? 0 : currentCall.attempts,
        updated_at: new Date().toISOString(),
      })
      .eq('id', currentCall.id);

    if (currentCall.visit_id) {
      await supabase.from('visits').update({ status: 'aguardando' }).eq('id', currentCall.visit_id);
    }

    setAutoRecallNotice(
      wasLastAttempt
        ? `Corretor não compareceu após 3 chamadas. Corretor pausado. Sistema a chamar próximo corretor automaticamente...`
        : `Corretor não compareceu. Sistema a chamar próximo corretor automaticamente...`,
    );

    // Auto-recall: dispara nova chamada para o próximo corretor da respectiva fila
    setTimeout(async () => {
      // Recarregar a entrada atualizada do queue
      const { data: refreshedQueue } = await supabase
        .from('queue_entries')
        .select('*, visit:visits(*), broker:brokers(*)')
        .eq('id', currentCall.id)
        .maybeSingle();

      if (!refreshedQueue) return;

      const entry = refreshedQueue as QueueEntry;
      let nextBrokerId: string | null = null;

      const busyIds = new Set(
        brokers.filter((b) => b.attendance_status === 'em_mesa' || b.attendance_status === 'decorado').map((b) => b.id),
      );

      if (entry.queue_type === 'decorado') {
        // Fila inversa: primeiro corretor disponível do topo da inversa
        const broker = nextBrokerFromInverseTop(brokers, busyIds);
        nextBrokerId = broker?.id ?? null;
      } else if (entry.queue_type === 'parceria') {
        nextBrokerId = null;
      } else {
        // Fila geral: próximo corretor livre da mesma imobiliária
        let available = nextBrokerFromAgency(brokers, entry.agency, busyIds);
        if (!available) {
          const otherAgency: Agency = entry.agency === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis';
          available = nextBrokerFromAgency(brokers, otherAgency, busyIds);
        }
        nextBrokerId = available?.id ?? null;
      }

      await supabase
        .from('queue_entries')
        .update({
          queue_status: 'chamando',
          broker_id: nextBrokerId,
          attempts: (entry.attempts ?? 0) + 1,
          called_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', entry.id);

      if (entry.visit_id) {
        await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', entry.visit_id);
      }

      if (nextBrokerId) {
        await supabase
          .from('brokers')
          .update({ attendance_status: 'em_mesa', last_status_update: new Date().toISOString() })
          .eq('id', nextBrokerId);
      }
    }, 1500);
  }, [currentCall, brokers, queue]);

  // When remaining hits 0, auto-trigger transbordo
  useEffect(() => {
    if (calling && remaining === 0 && !timeoutFiredRef.current) {
      handleTimeout();
    }
  }, [remaining, calling, handleTimeout]);

  function playAlert() {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.5);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.5 + 0.3);
        osc.start(ctx.currentTime + i * 0.5);
        osc.stop(ctx.currentTime + i * 0.5 + 0.3);
      }
    } catch {
      // Audio not available
    }
  }

  const nextEntries = queue.filter((e) => e.queue_status === 'aguardando' && e.queue_type === 'geral').slice(0, 5);
  const totalWaiting = queue.filter((e) => e.queue_status === 'aguardando').length;
  const vivaWaiting = queue.filter((e) => e.queue_status === 'aguardando' && e.agency === 'Viva Imóveis').length;
  const nobreWaiting = queue.filter((e) => e.queue_status === 'aguardando' && e.agency === 'Casa Nobre').length;

  // Histórico das últimas 5 chamadas realizadas
  const callHistory = queue
    .filter((e) => e.called_at && (e.queue_status === 'em_atendimento' || e.queue_status === 'concluido' || e.queue_status === 'chamando'))
    .sort((a, b) => new Date(b.called_at!).getTime() - new Date(a.called_at!).getTime())
    .slice(0, 5);

  const broker = currentCall?.broker_id ? brokers.find((b) => b.id === currentCall.broker_id) : undefined;
  const brokerName = broker?.operational_name ?? 'A definir';
  const brokerAgency = broker?.agency ?? currentCall?.agency ?? '—';
  const visitReason = currentCall?.visit?.visit_reason ?? '—';
  const queueTypeLabel = currentCall?.queue_type === 'decorado' ? 'Fila Inversa (Decorado)' : currentCall?.queue_type === 'parceria' ? 'Parceria' : 'Fila Geral';

  const timerPercent = (remaining / callDuration) * 100;
  const isUrgent = remaining <= Math.min(30, callDuration / 4) && remaining > 0;

  return (
    <div className="space-y-6">
      {/* TV Display */}
      <div className="bg-slate-900 rounded-3xl border border-slate-800 p-8 min-h-[400px] flex flex-col items-center justify-center relative overflow-hidden">
        {calling && (
          <div className={`absolute inset-0 ${isUrgent ? 'bg-red-500/5' : 'bg-amber-500/5'} animate-pulse`} />
        )}

        <div className="relative z-10 text-center w-full">
          {!calling ? (
            <div className="py-12">
              <VolumeX className="h-16 w-16 text-slate-600 mx-auto mb-4" />
              <h2 className="text-3xl font-bold text-slate-400">Aguardando chamada</h2>
              <p className="text-slate-500 mt-2">{totalWaiting} cliente(s) na fila</p>
              {testMode && (
                <div className="mt-4 inline-flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-3 py-1.5 rounded-lg text-sm">
                  <Zap className="h-4 w-4" />
                  Modo de teste rápido — {callDuration}s por chamada
                </div>
              )}
              {autoRecallNotice && (
                <div className="mt-4 inline-flex items-center gap-2 bg-orange-500/10 text-orange-400 px-4 py-2 rounded-lg text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  {autoRecallNotice}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Queue type badge */}
              <div className="mb-4">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                  currentCall?.queue_type === 'decorado' ? 'bg-orange-500/15 text-orange-400' :
                  currentCall?.queue_type === 'parceria' ? 'bg-sky-500/15 text-sky-400' :
                  'bg-amber-500/15 text-amber-400'
                }`}>
                  {currentCall?.queue_type === 'decorado' && <Home className="h-3 w-3" />}
                  {currentCall?.queue_type === 'parceria' && <ArrowLeftRight className="h-3 w-3" />}
                  {queueTypeLabel}
                </span>
              </div>

              <div className="mb-6">
                <p className="text-sm uppercase tracking-widest text-slate-400 mb-1">Corretor</p>
                <h1 className="text-4xl sm:text-5xl font-bold text-white">{brokerName}</h1>
                <div className="flex items-center justify-center gap-2 mt-3">
                  <Building2 className="h-5 w-5 text-amber-400" />
                  <span className="text-xl text-amber-400">{brokerAgency}</span>
                </div>
              </div>

              <div className="mb-6">
                <p className="text-sm uppercase tracking-widest text-slate-400 mb-1">Motivo</p>
                <p className="text-2xl text-slate-200">{visitReason}</p>
              </div>

              <div className="flex items-center justify-center gap-4 mb-6">
                <div className={`text-6xl font-mono font-bold ${isUrgent ? 'text-red-400' : 'text-white'}`}>
                  {formatTime(remaining)}
                </div>
              </div>

              <div className="max-w-md mx-auto mb-6">
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                      isUrgent ? 'bg-red-500' : 'bg-amber-500'
                    }`}
                    style={{ width: `${timerPercent}%` }}
                  />
                </div>
              </div>

              {/* Attempt dots */}
              <div className="flex items-center justify-center gap-3">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 ${
                      i < attempts ? 'text-red-400' : i === attempts ? 'text-amber-400' : 'text-slate-600'
                    }`}
                  >
                    <div
                      className={`h-3 w-3 rounded-full ${
                        i < attempts ? 'bg-red-500' : i === attempts ? 'bg-amber-400 animate-pulse' : 'bg-slate-700'
                      }`}
                    />
                    <span className="text-xs font-medium">Tentativa {i + 1}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={playAlert}
          disabled={!soundEnabled}
          className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 text-slate-950 font-bold px-6 py-3 rounded-xl transition"
        >
          {soundEnabled ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          Testar alerta sonoro
        </button>
        <button
          onClick={() => setSoundEnabled((s) => !s)}
          className={`flex items-center gap-2 px-5 py-3 rounded-xl font-medium transition ${
            soundEnabled ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-800 text-slate-500 hover:bg-slate-700'
          }`}
        >
          {soundEnabled ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          Som {soundEnabled ? 'ligado' : 'desligado'}
        </button>
      </div>

      {/* Queue summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Users className="h-5 w-5" />
            <span className="text-sm">Total na fila</span>
          </div>
          <p className="text-3xl font-bold text-white">{totalWaiting}</p>
        </div>
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Building2 className="h-5 w-5" />
            <span className="text-sm">Viva Imóveis</span>
          </div>
          <p className="text-3xl font-bold text-amber-400">{vivaWaiting}</p>
        </div>
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Building2 className="h-5 w-5" />
            <span className="text-sm">Casa Nobre</span>
          </div>
          <p className="text-3xl font-bold text-sky-400">{nobreWaiting}</p>
        </div>
      </div>

      {/* Upcoming */}
      {nextEntries.length > 0 && (
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Timer className="h-5 w-5 text-slate-400" />
            <h3 className="font-bold text-slate-200">Próximos na fila</h3>
          </div>
          <div className="space-y-2">
            {nextEntries.map((entry, i) => (
              <div key={entry.id} className="flex items-center gap-3 bg-slate-800/50 rounded-xl p-3">
                <span className="text-slate-500 font-mono text-sm w-6">{i + 1}.</span>
                <span className="text-white text-sm flex-1">{entry.visit?.customer_name ?? '—'}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${entry.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>
                  {entry.agency}
                </span>
                <span className="text-xs text-slate-400">{entry.visit?.visit_reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Histórico de Últimas Chamadas */}
      {callHistory.length > 0 && (
        <div className="bg-slate-900 rounded-2xl border border-amber-500/20 p-5">
          <div className="flex items-center gap-2 mb-4">
            <History className="h-5 w-5 text-amber-400" />
            <h3 className="font-bold text-amber-400">Últimas Chamadas</h3>
          </div>
          <div className="space-y-2">
            {callHistory.map((entry) => {
              const histBroker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
              const reasonLabel = entry.queue_type === 'decorado' ? 'Decorado' : entry.queue_type === 'parceria' ? 'Parceria' : entry.visit?.visit_reason ?? 'Vez Geral';
              const callTime = entry.called_at ? new Date(entry.called_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
              return (
                <div key={entry.id} className="flex items-center gap-3 bg-slate-800/50 rounded-xl p-3">
                  <span className="text-white text-sm font-medium flex-1">{histBroker?.operational_name ?? '—'}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${entry.queue_type === 'decorado' ? 'bg-orange-500/15 text-orange-400' : entry.queue_type === 'parceria' ? 'bg-sky-500/15 text-sky-400' : 'bg-amber-500/15 text-amber-400'}`}>{reasonLabel}</span>
                  <span className="text-xs text-slate-400 font-mono">{callTime}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
