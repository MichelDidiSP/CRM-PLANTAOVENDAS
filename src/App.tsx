import { useEffect, useState, useRef } from 'react';
import { Building2, DoorOpen, Tv, Users, ListOrdered, Zap, Clock } from 'lucide-react';
import { supabase, type Broker, type QueueEntry, type Visit } from '@/lib/supabase';
import { fetchAll, interleaveQueue } from '@/lib/queueEngine';
import { SimProvider, useSim } from '@/lib/simContext';

import RecepcaoPanel from '@/components/RecepcaoPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import CorretorPanel from '@/components/CorretorPanel';
import FilaPanel from '@/components/FilaPanel';

type View = 'recepcao' | 'chamadas' | 'corretor' | 'fila';

function AppContent() {
  const { simulatedTime, setSimulatedTime, testMode, setTestMode } = useSim();
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
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <Building2 className="h-8 w-8 text-amber-400" />
              <div>
                <h1 className="text-lg font-bold tracking-tight">Plantão Imobiliário</h1>
                <p className="text-xs text-slate-400 hidden sm:block">Gestão integrada de atendimento</p>
              </div>
            </div>

            {/* Simulation controls */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-slate-800 rounded-lg px-3 py-1.5">
                <Clock className="h-4 w-4 text-amber-400" />
                <input
                  type="time"
                  value={simulatedTime ?? ''}
                  onChange={(e) => setSimulatedTime(e.target.value || null)}
                  className="bg-transparent text-sm text-white focus:outline-none w-[90px]"
                  title="Hora simulada do sistema"
                />
                {simulatedTime && (
                  <button
                    onClick={() => setSimulatedTime(null)}
                    className="text-xs text-slate-500 hover:text-white"
                    title="Voltar à hora real"
                  >
                    limpar
                  </button>
                )}
              </div>
              <button
                onClick={() => setTestMode(!testMode)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  testMode
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
                title="Reduz o tempo da chamada de 2 min para 20 seg"
              >
                <Zap className="h-4 w-4" />
                {testMode ? 'Teste rápido ON' : 'Teste rápido'}
              </button>
            </div>
          </div>
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
        {testMode && <span className="ml-2 text-amber-400">· Modo de teste rápido activo</span>}
        {simulatedTime && <span className="ml-2 text-amber-400">· Hora simulada: {simulatedTime}</span>}
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
