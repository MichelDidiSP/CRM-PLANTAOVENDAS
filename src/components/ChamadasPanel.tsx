import { useEffect, useState, useRef } from 'react';
import { Volume2, VolumeX, Timer, Users, Building2, Zap } from 'lucide-react';
import type { Broker, QueueEntry } from '@/lib/supabase';
import { formatTime } from '@/lib/queueEngine';
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
  const intervalRef = useRef<number | undefined>(undefined);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const calling_entry = queue.find((e) => e.queue_status === 'chamando');
    if (calling_entry && (!currentCall || currentCall.id !== calling_entry.id)) {
      setCurrentCall(calling_entry);
      setRemaining(callDuration);
      setAttempts(calling_entry.attempts);
      setCalling(true);
      playAlert();
    } else if (!calling_entry && currentCall) {
      setCurrentCall(null);
      setCalling(false);
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

  const nextEntries = queue.filter((e) => e.queue_status === 'aguardando').slice(0, 5);
  const totalWaiting = queue.filter((e) => e.queue_status === 'aguardando').length;
  const vivaWaiting = queue.filter((e) => e.queue_status === 'aguardando' && e.agency === 'Viva Imóveis').length;
  const nobreWaiting = queue.filter((e) => e.queue_status === 'aguardando' && e.agency === 'Casa Nobre').length;

  const broker = currentCall?.broker_id ? brokers.find((b) => b.id === currentCall.broker_id) : undefined;
  const brokerName = broker?.operational_name ?? 'A definir';
  const brokerAgency = broker?.agency ?? currentCall?.agency ?? '—';
  const visitReason = currentCall?.visit?.visit_reason ?? '—';

  const timerPercent = (remaining / callDuration) * 100;
  const isUrgent = remaining <= Math.min(30, callDuration / 4) && remaining > 0;

  return (
    <div className="space-y-6">
      {/* TV Display */}
      <div className="bg-slate-900 rounded-3xl border border-slate-800 p-8 min-h-[400px] flex flex-col items-center justify-center relative overflow-hidden">
        {/* Background pulse for active calls */}
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
            </div>
          ) : (
            <>
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

              {/* Timer bar */}
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
    </div>
  );
}
