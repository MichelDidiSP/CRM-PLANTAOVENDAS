import { useEffect, useState, useRef, useCallback } from 'react';
import { Building2, DoorOpen, Tv, Users, ListOrdered, Zap, Clock, Plus, Shuffle, ClipboardList, RefreshCw, FileText, X, Trophy, Calendar, Sun, Moon, ArrowRight, Home } from 'lucide-react';
import { supabase, type Broker, type QueueEntry, type Visit, type PlantaoSession } from '@/lib/supabase';
import { fetchAll, interleaveQueue, executeSorteio, reiniciarPlantao, transitionToAfternoon, type SorteioResult } from '@/lib/queueEngine';
import { SimProvider, useSim } from '@/lib/simContext';

import RecepcaoPanel from '@/components/RecepcaoPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import CorretorPanel from '@/components/CorretorPanel';
import FilaPanel from '@/components/FilaPanel';

type View = 'recepcao' | 'chamadas' | 'corretor' | 'fila' | 'auditoria';

function AppContent() {
  const { clockDisplay, setStartTime, addMinute, jumpToAfternoon, testMode, setTestMode, sorteioTriggered, resetClock, simSeconds, currentShift, isWeekday, plantaoDate, setPlantaoDate, isPreSorteio, isCheckinOpen, isAtendimentoActive, isShiftTransition } = useSim();
  const [view, setView] = useState<View>('recepcao');
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [activeSession, setActiveSession] = useState<PlantaoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [sorteioResult, setSorteioResult] = useState<SorteioResult | null>(null);
  const [reiniciarDialog, setReiniciarDialog] = useState(false);
  const [attendanceReport, setAttendanceReport] = useState<QueueEntry[] | null>(null);
  const [reiniciando, setReiniciando] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);
  const sorteioExecutedRef = useRef(false);
  const transitionExecutedRef = useRef(false);

  const load = useCallback(async () => {
    const data = await fetchAll();
    if (data.error) return;
    setBrokers(data.brokers);
    setVisits(data.visits);
    setQueue(data.queue);
    setActiveSession(data.activeSession);
    setLoading(false);
  }, []);

  useEffect(() => {
    let mounted = true;
    load();
    pollRef.current = window.setInterval(() => { if (mounted) load(); }, 3000);

    const channel = supabase
      .channel('plantao-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brokers' }, () => { if (mounted) load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, () => { if (mounted) load(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_entries' }, () => { if (mounted) load(); })
      .subscribe();

    return () => {
      mounted = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      supabase.removeChannel(channel);
    };
  }, [load]);

  // Sorteio automático
  useEffect(() => {
    if (sorteioTriggered && !sorteioExecutedRef.current && brokers.length > 0) {
      sorteioExecutedRef.current = true;
      executeSorteio(brokers, simSeconds, currentShift).then((result) => {
        if (result) {
          setSorteioResult(result);
          load();
        }
      });
    }
  }, [sorteioTriggered, brokers, simSeconds, currentShift, load]);

  // Reset sorteio flag when clock is reset
  useEffect(() => {
    if (!sorteioTriggered) {
      sorteioExecutedRef.current = false;
    }
  }, [sorteioTriggered]);

  // Auto-transition at 14:00h
  useEffect(() => {
    if (isShiftTransition && !transitionExecutedRef.current && brokers.length > 0) {
      transitionExecutedRef.current = true;
      setTransitioning(true);
      transitionToAfternoon(brokers).then(() => {
        setSorteioResult(null);
        sorteioExecutedRef.current = false;
        load().then(() => setTransitioning(false));
      });
    }
    if (!isShiftTransition) {
      transitionExecutedRef.current = false;
    }
  }, [isShiftTransition, brokers, load]);

  const sortedQueue = interleaveQueue(queue, brokers, activeSession?.last_called_agency ?? null);

  async function handleReiniciar() {
    setReiniciando(true);
    const concluded = queue.filter((e) => e.queue_status === 'concluido' || e.queue_status === 'em_atendimento');
    setAttendanceReport(concluded);

    await reiniciarPlantao(brokers);
    resetClock();
    setSorteioResult(null);
    sorteioExecutedRef.current = false;
    transitionExecutedRef.current = false;
    await load();
    setReiniciando(false);
    setReiniciarDialog(false);
    setView('auditoria');
  }

  const navItems: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'recepcao', label: 'Recepção', icon: <DoorOpen className="h-5 w-5" /> },
    { id: 'chamadas', label: 'Chamadas (TV)', icon: <Tv className="h-5 w-5" /> },
    { id: 'corretor', label: 'Corretor / Gerente', icon: <Users className="h-5 w-5" /> },
    { id: 'fila', label: 'Motor da Fila', icon: <ListOrdered className="h-5 w-5" /> },
    { id: 'auditoria', label: 'Auditoria', icon: <ClipboardList className="h-5 w-5" /> },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-lg">A carregar plantão…</div>
      </div>
    );
  }

  const shiftLabel = currentShift === 'manha' ? 'Manhã' : 'Tarde';
  const shiftIcon = currentShift === 'manha' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex flex-col gap-2 py-2">
            {/* Title row */}
            <div className="flex items-center gap-3 shrink-0">
              <Building2 className="h-7 w-7 text-amber-400" />
              <div>
                <h1 className="text-lg font-bold tracking-tight">Plantão Imobiliário</h1>
                <p className="text-xs text-slate-400 hidden sm:block">Gestão integrada de atendimento</p>
              </div>
            </div>

            {/* Top row: clock left, controls right */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* Relógio do simulador — topo esquerdo, alto contraste */}
              <div className="flex items-center gap-3 bg-slate-950 border-2 border-amber-400 rounded-xl px-5 py-2 shrink-0 shadow-lg shadow-amber-500/20">
                <Clock className="h-7 w-7 text-amber-400 shrink-0" />
                <div className="flex flex-col items-center">
                  <span className="font-mono text-3xl font-bold text-amber-300 tabular-nums leading-none tracking-wider drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]">{clockDisplay}</span>
                  <input
                    type="time"
                    step="1"
                    onChange={(e) => e.target.value && setStartTime(e.target.value)}
                    className="text-[10px] text-amber-200/60 bg-transparent focus:outline-none mt-1 w-[70px] text-center"
                    title="Definir hora inicial"
                  />
                </div>
                <div className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium ${currentShift === 'manha' ? 'bg-amber-500/20 text-amber-300' : 'bg-indigo-500/20 text-indigo-300'}`}>
                  {shiftIcon}
                  {shiftLabel}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap justify-end">
              {/* Calendar / Date Picker */}
              <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-3 py-1.5">
                <Calendar className="h-5 w-5 text-amber-400 shrink-0" />
                <input
                  type="date"
                  value={plantaoDate}
                  onChange={(e) => setPlantaoDate(e.target.value)}
                  className="text-sm text-slate-300 bg-transparent focus:outline-none"
                  title="Data do plantão"
                />
                <span className={`text-xs px-2 py-0.5 rounded-full ${isWeekday ? 'bg-emerald-500/15 text-emerald-400' : 'bg-orange-500/15 text-orange-400'}`}>
                  {isWeekday ? 'Dia útil' : 'Fim de semana'}
                </span>
              </div>

              <button onClick={addMinute} className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg text-sm font-medium transition" title="Avançar 1 minuto">
                <Plus className="h-4 w-4" /> +1 min
              </button>

              <button
                onClick={jumpToAfternoon}
                className="flex items-center gap-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 px-3 py-2 rounded-lg text-sm font-medium transition border border-indigo-500/20"
                title="Pular para a Tarde (13:40h)"
              >
                <ArrowRight className="h-4 w-4" /> Pular para a Tarde
              </button>

              <button
                onClick={() => setTestMode(!testMode)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition ${testMode ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                title="Reduz o tempo da chamada de 2 min para 10 seg"
              >
                <Zap className="h-4 w-4" /> {testMode ? 'Teste ON' : 'Teste rápido'}
              </button>

              <button
                onClick={() => setReiniciarDialog(true)}
                className="flex items-center gap-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm font-medium transition border border-red-500/20"
                title="Reiniciar plantão para novo teste"
              >
                <RefreshCw className="h-4 w-4" /> Reiniciar Plantão
              </button>
            </div>
            </div>

          {/* Status banners */}
          {transitioning && (
            <div className="flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-indigo-400">
              <ArrowRight className="h-4 w-4 shrink-0 animate-pulse" />
              <span><strong className="text-indigo-300">Transição de turno às 14:00h</strong> — Fila da manhã extinta. Corretores em atendimento continuam com vaga reservada na tarde.</span>
            </div>
          )}

          {sorteioTriggered && sorteioResult && !transitioning && (
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-emerald-400">
              <Shuffle className="h-4 w-4 shrink-0" />
              <span><strong className="text-emerald-300">Sorteio executado — Turno {sorteioResult.shift === 'manha' ? 'Manhã' : 'Tarde'}</strong> — {sorteioResult.vivaBrokers.length} corretores Viva + {sorteioResult.nobreBrokers.length} Casa Nobre intercalados. <strong className="text-amber-300">Desempate: {sorteioResult.desempateWinner} ganhou a preferência</strong>. {sorteioResult.lateBrokers.length} atrasado(s) no fim.</span>
            </div>
          )}

          {!sorteioTriggered && isPreSorteio && (
            <div className="flex items-center gap-2 bg-sky-500/10 border border-sky-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-sky-400">
              <Clock className="h-4 w-4 shrink-0" />
              <span><strong className="text-sky-300">Período Pré-Sorteio</strong> — Atendimento por Ordem de Chegada. O primeiro corretor disponível que registrou presença atende. Sorteio automático às {currentShift === 'manha' ? '08:46:00' : '13:46:00'}.</span>
            </div>
          )}

          {!sorteioTriggered && !isPreSorteio && !transitioning && (
            <div className="flex items-center gap-2 bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2 mb-2 text-sm text-slate-400">
              <Clock className="h-4 w-4 shrink-0 text-amber-400" />
              <span>Sorteio automático às <strong className="text-amber-400">{currentShift === 'manha' ? '08:46:00' : '13:46:00'}</strong>. {isCheckinOpen ? 'Check-in aberto — marque os corretores como presentes.' : 'Aguarde abertura do check-in.'}</span>
            </div>
          )}

          <nav className="flex gap-1 overflow-x-auto pb-2 -mb-px">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${view === item.id ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        {view === 'recepcao' && <RecepcaoPanel brokers={brokers} visits={visits} />}
        {view === 'chamadas' && <ChamadasPanel queue={queue} brokers={brokers} />}
        {view === 'corretor' && <CorretorPanel brokers={brokers} />}
        {view === 'fila' && <FilaPanel queue={sortedQueue} brokers={brokers} allQueue={queue} />}
        {view === 'auditoria' && <AuditoriaPanel sorteioResult={sorteioResult} brokers={brokers} queue={queue} attendanceReport={attendanceReport} />}
      </main>

      <footer className="border-t border-slate-800 py-3 text-center text-xs text-slate-500">
        Plantão Imobiliário — Sistema operacional de venda directa
        {testMode && <span className="ml-2 text-amber-400">· Modo de teste rápido: 10s por chamada</span>}
      </footer>

      {/* Dialog: Reiniciar Plantão */}
      {reiniciarDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-900 rounded-2xl border border-slate-700 p-6 max-w-md w-full mx-4">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="bg-red-500/10 p-3 rounded-xl"><RefreshCw className="h-6 w-6 text-red-400" /></div>
                <div>
                  <h2 className="text-xl font-bold">Reiniciar Plantão</h2>
                  <p className="text-sm text-slate-400">Prepara um novo teste de sorteio</p>
                </div>
              </div>
              <button onClick={() => setReiniciarDialog(false)} className="text-slate-500 hover:text-white"><X className="h-5 w-5" /></button>
            </div>

            <div className="space-y-3 mb-6">
              <div className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-amber-400 mt-0.5">1.</span>
                <span>A <strong className="text-white">Fila Geral atual</strong> será limpa e o relógio voltará às <strong className="text-amber-400">08:30:00</strong>.</span>
              </div>
              <div className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-amber-400 mt-0.5">2.</span>
                <span>Todos os corretores voltam a <strong className="text-white">ausente/livre</strong> para um novo sorteio.</span>
              </div>
              <div className="flex items-start gap-2 text-sm text-slate-300">
                <span className="text-amber-400 mt-0.5">3.</span>
                <span>Um <strong className="text-white">Relatório de Atendimentos</strong> do teste será exibido na aba Auditoria.</span>
              </div>
              <div className="flex items-start gap-2 text-sm text-emerald-400 bg-emerald-500/10 rounded-lg p-2.5">
                <span className="mt-0.5"><FileText className="h-4 w-4" /></span>
                <span>O <strong>Banco de Dados de Clientes</strong> (histórico e telefones) <strong>não será apagado</strong> — permanece para validação de Retorno, Indicação, Parceria e Duplicidade.</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={handleReiniciar} disabled={reiniciando} className="flex-1 bg-red-500 hover:bg-red-400 disabled:bg-slate-700 text-white font-bold py-3 rounded-xl transition flex items-center justify-center gap-2">
                <RefreshCw className={`h-5 w-5 ${reiniciando ? 'animate-spin' : ''}`} />
                {reiniciando ? 'Reiniciando…' : 'Confirmar reinício'}
              </button>
              <button onClick={() => setReiniciarDialog(false)} className="px-5 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditoriaPanel({ sorteioResult, brokers, queue, attendanceReport }: {
  sorteioResult: SorteioResult | null;
  brokers: Broker[];
  queue: QueueEntry[];
  attendanceReport: QueueEntry[] | null;
}) {
  return (
    <div className="space-y-6">
      {/* Sorteio Visual */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-amber-500/10 p-3 rounded-xl"><Shuffle className="h-6 w-6 text-amber-400" /></div>
          <div>
            <h2 className="text-xl font-bold">Sorteio Interno — Intercalação Real</h2>
            <p className="text-sm text-slate-400">Resultado visual do embaralhamento e intercalação das duas imobiliárias</p>
          </div>
        </div>

        {!sorteioResult ? (
          <div className="text-center py-12">
            <Clock className="h-12 w-12 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">O sorteio ainda não foi executado.</p>
            <p className="text-sm text-slate-500 mt-1">Aguarde o relógio chegar ao horário do sorteio ou avance o tempo manualmente.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Shift badge */}
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs px-3 py-1 rounded-full font-medium ${sorteioResult.shift === 'manha' ? 'bg-amber-500/15 text-amber-400' : 'bg-indigo-500/15 text-indigo-400'}`}>
                {sorteioResult.shift === 'manha' ? 'Turno Manhã' : 'Turno Tarde'}
              </span>
            </div>

            {/* Sorteio entre Empresas — banner em destaque */}
            <div className={`rounded-xl p-5 border-2 ${sorteioResult.desempateWinner === 'Viva Imóveis' ? 'bg-amber-500/10 border-amber-500/40' : 'bg-sky-500/10 border-sky-500/40'}`}>
              <div className="flex items-center gap-3">
                <div className={`p-3 rounded-xl ${sorteioResult.desempateWinner === 'Viva Imóveis' ? 'bg-amber-500/20' : 'bg-sky-500/20'}`}>
                  <Trophy className={`h-8 w-8 ${sorteioResult.desempateWinner === 'Viva Imóveis' ? 'text-amber-400' : 'text-sky-400'}`} />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Sorteio entre Empresas (Desempate)</p>
                  <p className="text-xl font-bold text-white">
                    <span className={sorteioResult.desempateWinner === 'Viva Imóveis' ? 'text-amber-400' : 'text-sky-400'}>{sorteioResult.desempateWinner}</span> ganhou a preferência e inicia a intercalação do plantão
                  </p>
                  <p className="text-sm text-slate-400 mt-1">
                    Ordem de intercalação: {sorteioResult.desempateWinner === 'Viva Imóveis' ? 'A1, B1, A2, B2…' : 'B1, A1, B2, A2…'}
                  </p>
                </div>
              </div>
            </div>

            {/* Listas individuais */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
                <h3 className="font-bold text-amber-400 mb-3 flex items-center gap-2"><Building2 className="h-4 w-4" /> Viva Imóveis (embaralhado)</h3>
                <div className="space-y-2">
                  {sorteioResult.vivaBrokers.map((b, i) => (
                    <div key={b.id} className="flex items-center gap-2 bg-slate-800/50 rounded-lg p-2.5">
                      <span className="font-mono text-sm text-slate-500 w-6">{i + 1}.</span>
                      <span className="text-white text-sm">{b.operational_name}</span>
                    </div>
                  ))}
                  {sorteioResult.vivaBrokers.length === 0 && <p className="text-sm text-slate-500">Nenhum corretor presente.</p>}
                </div>
              </div>

              <div className="bg-sky-500/5 border border-sky-500/20 rounded-xl p-4">
                <h3 className="font-bold text-sky-400 mb-3 flex items-center gap-2"><Building2 className="h-4 w-4" /> Casa Nobre (embaralhado)</h3>
                <div className="space-y-2">
                  {sorteioResult.nobreBrokers.map((b, i) => (
                    <div key={b.id} className="flex items-center gap-2 bg-slate-800/50 rounded-lg p-2.5">
                      <span className="font-mono text-sm text-slate-500 w-6">{i + 1}.</span>
                      <span className="text-white text-sm">{b.operational_name}</span>
                    </div>
                  ))}
                  {sorteioResult.nobreBrokers.length === 0 && <p className="text-sm text-slate-500">Nenhum corretor presente.</p>}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Relatório de Atendimentos */}
      {attendanceReport && (
        <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-emerald-500/10 p-3 rounded-xl"><FileText className="h-6 w-6 text-emerald-400" /></div>
            <div>
              <h2 className="text-xl font-bold">Relatório de Atendimentos</h2>
              <p className="text-sm text-slate-400">Histórico do teste que foi encerrado</p>
            </div>
          </div>

          {attendanceReport.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-8">Nenhum atendimento concluído neste teste.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left">
                    <th className="py-2 px-3 text-slate-400 font-medium">#</th>
                    <th className="py-2 px-3 text-slate-400 font-medium">Cliente</th>
                    <th className="py-2 px-3 text-slate-400 font-medium">Corretor</th>
                    <th className="py-2 px-3 text-slate-400 font-medium">Imobiliária</th>
                    <th className="py-2 px-3 text-slate-400 font-medium">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {attendanceReport.map((entry, i) => {
                    const broker = entry.broker_id ? brokers.find((b) => b.id === entry.broker_id) : undefined;
                    return (
                      <tr key={entry.id} className="border-b border-slate-800/50">
                        <td className="py-2.5 px-3 text-slate-500 font-mono">{i + 1}</td>
                        <td className="py-2.5 px-3 text-white font-medium">{entry.visit?.customer_name ?? '—'}</td>
                        <td className="py-2.5 px-3 text-slate-300">{broker?.operational_name ?? '—'}</td>
                        <td className="py-2.5 px-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${entry.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : entry.agency === 'Casa Nobre' ? 'bg-sky-500/15 text-sky-400' : 'bg-slate-600/30 text-slate-400'}`}>{entry.agency}</span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-400">{entry.visit?.visit_reason ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* DUAS FILAS INDEPENDENTES — Tempo Real */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tabela 1: Fila Geral Direta */}
        <div className="bg-slate-900 rounded-2xl border border-amber-500/20 p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="bg-amber-500/10 p-3 rounded-xl"><ListOrdered className="h-6 w-6 text-amber-400" /></div>
            <div>
              <h2 className="text-xl font-bold text-amber-400">Fila Geral Direta</h2>
              <p className="text-sm text-slate-400">Vez Geral / Primeira Visita</p>
            </div>
          </div>
          <div className="space-y-2">
            {[...brokers]
              .filter((b) => !b.is_external_partner && b.presence_status === 'presente')
              .sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999))
              .map((b, i) => {
                const statusLabel = b.attendance_status === 'em_mesa' ? 'Chamado' : b.attendance_status === 'livre' ? 'Livre' : b.attendance_status === 'decorado' ? 'Em Atendimento' : b.presence_status === 'pausa' ? 'Pausado' : b.attendance_status;
                const statusColor = b.attendance_status === 'livre' ? 'bg-emerald-500/15 text-emerald-400' : b.attendance_status === 'em_mesa' ? 'bg-amber-500/15 text-amber-400' : b.attendance_status === 'decorado' ? 'bg-sky-500/15 text-sky-400' : b.presence_status === 'pausa' ? 'bg-red-500/15 text-red-400' : 'bg-slate-600/30 text-slate-400';
                return (
                  <div key={b.id} className="flex items-center gap-3 bg-slate-800/50 rounded-lg p-3 border border-amber-500/10">
                    <span className="font-mono text-sm text-amber-400/60 w-8 text-center font-bold">{i + 1}.</span>
                    <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>{statusLabel}</span>
                  </div>
                );
              })}
            {brokers.filter((b) => !b.is_external_partner && b.presence_status === 'presente').length === 0 && (
              <p className="text-sm text-slate-500 text-center py-6">Nenhum corretor presente.</p>
            )}
          </div>
        </div>

        {/* Tabela 2: Fila Inversa Geral */}
        <div className="bg-slate-900 rounded-2xl border border-orange-500/20 p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="bg-orange-500/10 p-3 rounded-xl"><Home className="h-6 w-6 text-orange-400" /></div>
            <div>
              <h2 className="text-xl font-bold text-orange-400">Fila Inversa Geral</h2>
              <p className="text-sm text-slate-400">Visita ao Decorado</p>
            </div>
          </div>
          <div className="space-y-2">
            {[...brokers]
              .filter((b) => !b.is_external_partner && b.presence_status === 'presente')
              .sort((a, b) => (b.sorteio_order ?? 0) - (a.sorteio_order ?? 0))
              .map((b, i) => {
                const statusLabel = b.attendance_status === 'em_mesa' ? 'Chamado' : b.attendance_status === 'livre' ? 'Livre' : b.attendance_status === 'decorado' ? 'Em Atendimento' : b.presence_status === 'pausa' ? 'Pausado' : b.attendance_status;
                const statusColor = b.attendance_status === 'livre' ? 'bg-emerald-500/15 text-emerald-400' : b.attendance_status === 'em_mesa' ? 'bg-amber-500/15 text-amber-400' : b.attendance_status === 'decorado' ? 'bg-sky-500/15 text-sky-400' : b.presence_status === 'pausa' ? 'bg-red-500/15 text-red-400' : 'bg-slate-600/30 text-slate-400';
                return (
                  <div key={b.id} className="flex items-center gap-3 bg-slate-800/50 rounded-lg p-3 border border-orange-500/10">
                    <span className="font-mono text-sm text-orange-400/60 w-8 text-center font-bold">{i + 1}.</span>
                    <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor}`}>{statusLabel}</span>
                  </div>
                );
              })}
            {brokers.filter((b) => !b.is_external_partner && b.presence_status === 'presente').length === 0 && (
              <p className="text-sm text-slate-500 text-center py-6">Nenhum corretor presente.</p>
            )}
          </div>
        </div>
      </div>
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
