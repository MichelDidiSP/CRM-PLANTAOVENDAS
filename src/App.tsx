import { useEffect, useState, useRef } from 'react';
import { Building2, DoorOpen, Tv, Users, ListOrdered, Zap, Clock, Plus, Shuffle } from 'lucide-react';
import { supabase, type Broker, type QueueEntry, type Visit } from '@/lib/supabase';
import { fetchAll, interleaveQueue } from '@/lib/queueEngine';
import { SimProvider, useSim } from '@/lib/simContext';

import RecepcaoPanel from '@/components/RecepcaoPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import CorretorPanel from '@/components/CorretorPanel';
import FilaPanel from '@/components/FilaPanel';

type View = 'recepcao' | 'chamadas' | 'corretor' | 'fila';

function AppContent() {
  const { clockDisplay, setStartTime, addMinute, testMode, setTestMode, sorteioTriggered } = useSim();
  const [view, setView] = useState<View>('recepcao');
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { brokers, visits, queue, error } = await fetchAll();
      if (!mounted || error) return;
      setBrokers(brokers);
      setVisits(visits);
      setQueue(queue);
      setLoading(false);
    }

    load();
    pollRef.current = window.setInterval(load, 3000);

    const channel = supabase
      .channel('plantao-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brokers' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_entries' }, load)
      .subscribe();

    return () => {
      mounted = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      supabase.removeChannel(channel);
    };
  }, []);

  const sortedQueue = interleaveQueue(queue, brokers);

  const navItems: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'recepcao', label: 'Recepção', icon: <DoorOpen className="h-5 w-5" /> },
    { id: 'chamadas', label: 'Chamadas (TV)', icon: <Tv className="h-5 w-5" /> },
    { id: 'corretor', label: 'Corretor / Gerente', icon: <Users className="h-5 w-5" /> },
    { id: 'fila', label: 'Motor da Fila', icon: <ListOrdered className="h-5 w-5" /> },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-lg">A carregar plantão…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16 gap-4">
            <div className="flex items-center gap-3 shrink-0">
              <Building2 className="h-8 w-8 text-amber-400" />
              <div>
                <h1 className="text-lg font-bold tracking-tight">Plantão Imobiliário</h1>
                <p className="text-xs text-slate-400 hidden sm:block">Gestão integrada de atendimento</p>
              </div>
            </div>

            {/* Relógio e controlos de simulação */}
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {/* Relógio ao vivo + campo editável */}
              <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-1.5">
                <Clock className="h-5 w-5 text-amber-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-mono text-lg font-bold text-white tabular-nums leading-none">{clockDisplay}</span>
                  <input
                    type="time"
                    step="1"
                    onChange={(e) => e.target.value && setStartTime(e.target.value)}
                    className="text-[10px] text-slate-500 bg-transparent focus:outline-none mt-0.5 w-[70px]"
                    title="Definir hora inicial"
                  />
                </div>
              </div>

              {/* Botão +1 Minuto */}
              <button
                onClick={addMinute}
                className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg text-sm font-medium transition"
                title="Avançar 1 minuto"
              >
                <Plus className="h-4 w-4" />
                +1 min
              </button>

              {/* Botão Modo de Teste Rápido */}
              <button
                onClick={() => setTestMode(!testMode)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${
                  testMode
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
                title="Reduz o tempo da chamada de 2 min para 10 seg"
              >
                <Zap className="h-4 w-4" />
                {testMode ? 'Teste ON' : 'Teste rápido'}
              </button>
            </div>
          </div>

          {/* Notificação de sorteio automático */}
          {sorteioTriggered && (
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-emerald-400">
              <Shuffle className="h-4 w-4 shrink-0" />
              <span><strong className="text-emerald-300">Sorteio automático executado</strong> — a Fila Geral foi gerada por intercalação das duas imobiliárias.</span>
            </div>
          )}

          <nav className="flex gap-1 overflow-x-auto pb-2 -mb-px">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                  view === item.id
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        {view === 'recepcao' && <RecepcaoPanel brokers={brokers} visits={visits} />}
        {view === 'chamadas' && <ChamadasPanel queue={queue} brokers={brokers} />}
        {view === 'corretor' && <CorretorPanel brokers={brokers} />}
        {view === 'fila' && <FilaPanel queue={sortedQueue} brokers={brokers} allQueue={queue} />}
      </main>

      <footer className="border-t border-slate-800 py-3 text-center text-xs text-slate-500">
        Plantão Imobiliário — Sistema operacional de venda directa
        {testMode && <span className="ml-2 text-amber-400">· Modo de teste rápido: 10s por chamada</span>}
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <SimProvider>
      <AppContent />
    </SimProvider>
  );
}
