import ShiftClosingDashboard from '@/components/ShiftClosingDashboard';
import { resetSimulatorReport } from '@/lib/reports/reportStore';
import OfficialClosingPanel from '@/components/OfficialClosingPanel';
import { isPlantaoClosed } from '@/lib/reports/officialClosing';
import { visibleDraws } from '@/lib/reception/fallbackOrchestrator';
import { dispatchGeneralWaiting } from '@/lib/reception/fallbackStore';
import PauseAuditPanel from '@/components/PauseAuditPanel';
import { enforcePauses, resetPauseState } from '@/lib/queue/pauseAndPartnersStore';
import { onlyOwn } from '@/lib/queue/pauseAndPartners';
import ExternalPartnerPanel from '@/components/ExternalPartnerPanel';
import { advanceSchedule } from '@/lib/queue/shiftScheduleStore';
import { scheduleAt, type ShiftDraw } from '@/lib/queue/shiftSchedule';
import PendingShiftQueues from '@/components/PendingShiftQueues';
import { useEffect, useState, useRef, useCallback } from 'react';
import { Building2, DoorOpen, Tv, Users, ListOrdered, Zap, Clock, Plus, Shuffle, ClipboardList, RefreshCw, X, Trophy, Calendar, Sun, Moon, ArrowRight, Home, Database, TriangleAlert as AlertTriangle } from 'lucide-react';
import { supabase, dbReady, type Broker, type QueueEntry, type Visit, type PlantaoSession } from '@/lib/supabase';
import { setCompanyDrawOrder, setCompanyRotationIndex, fetchAll, interleaveQueue, reiniciarPlantao, isLateForSort } from '@/lib/queueEngine';
import { SimProvider, useSim } from '@/lib/simContext';

import RecepcaoPanel, { type QuickEntryLog } from '@/components/RecepcaoPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import CorretorPanel from '@/components/CorretorPanel';
import FilaPanel from '@/components/ScheduledFilaPanel';

type View = 'recepcao' | 'chamadas' | 'corretor' | 'fila' | 'auditoria';

function AppContent() {
  const { clockDisplay, setStartTime, addMinute, jumpToAfternoon, testMode, setTestMode, sorteioTriggered, resetClock, simSeconds, currentShift, isWeekday, plantaoDate, setPlantaoDate, isPreSorteio, isCheckinOpen, isAtendimentoActive, isShiftTransition, isAfternoonActive, isMorningQueueActive, isExtendedShift, getCurrentTime } = useSim();
  const schedule = scheduleAt({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate });
  const [morningDraw, setMorningDraw] = useState<ShiftDraw | null>(null);
  const [afternoonDraw, setAfternoonDraw] = useState<ShiftDraw | null>(null);
  const [closedDay, setClosedDay] = useState<string | null>(null);
  const closed = closedDay === plantaoDate;
  const publishedDraws = visibleDraws(simSeconds, isExtendedShift, morningDraw, afternoonDraw);
  const scheduleRunning = useRef(false);
  const [view, setView] = useState<View>('recepcao');
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [activeSession, setActiveSession] = useState<PlantaoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [reiniciarDialog, setReiniciarDialog] = useState(false);
  const [quickLog, setQuickLog] = useState<QuickEntryLog[]>([]);
  const [reiniciando, setReiniciando] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbConnected, setDbConnected] = useState<boolean | null>(null);

  useEffect(() => { dbReady.then((isReal) => setDbConnected(isReal)); }, []);

  const load = useCallback(async () => {
    const data = await fetchAll();
    let dayClosed: boolean;
    try { dayClosed = await isPlantaoClosed(plantaoDate); }
    catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Não foi possível consultar o fechamento do plantão.');
      setLoading(false);
      return;
    }
    setClosedDay(dayClosed ? plantaoDate : null);
    if (data.error) {
      setLoadError('Não foi possível conectar ao banco de dados. Verifique a conexão e tente novamente.');
      setLoading(false);
      return;
    }
    setLoadError(null);
    setBrokers(data.brokers);
    setVisits(data.visits);
    setQueue(data.queue);
    setActiveSession(data.activeSession);
    const draws = await supabase.from('plantao_sessions').select('*').eq('plantao_date', plantaoDate);
    if (draws.error) { setLoadError('Não foi possível carregar os sorteios.'); setLoading(false); return; }
    setMorningDraw(draws.data?.find((e: { id: string }) => e.id === `schedule_${plantaoDate}_morning`)?.schedule_data ?? null);
    setAfternoonDraw(draws.data?.find((e: { id: string }) => e.id === `schedule_${plantaoDate}_afternoon`)?.schedule_data ?? null);
    setLoading(false);
    return dayClosed ? undefined : data;
  }, [plantaoDate]);

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

  useEffect(() => {
    if (loading || closed || scheduleRunning.current) return;
    scheduleRunning.current = true;
    advanceSchedule({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate }, { deferClosing: true })
      .then(async () => {
        const at = getCurrentTime().toISOString();
        await enforcePauses({ at, shift: currentShift });
        const live = await load();
        if (live && await dispatchGeneralWaiting(live.queue, live.brokers,
          { seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate }, at)) await load();
      })
      .catch(error => setLoadError(`Erro na agenda do plantão: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { scheduleRunning.current = false; });
  }, [simSeconds, isExtendedShift, plantaoDate, loading, closed, load, getCurrentTime, currentShift]);

  useEffect(() => {
    const session = activeSession as (PlantaoSession & { schedule_data?: ShiftDraw }) | null;
    if (!session?.schedule_data || localStorage.getItem('schedule_rotation_session') === session.id) return;
    const first = session.schedule_data.firstAgency;
    setCompanyDrawOrder([first, first === 'Viva Imóveis' ? 'Casa Nobre' : 'Viva Imóveis']);
    setCompanyRotationIndex(0);
    localStorage.setItem('schedule_rotation_session', session.id);
  }, [activeSession]);

  const sortedQueue = interleaveQueue(queue, brokers, activeSession?.last_called_agency ?? null);

  async function handleReiniciar() {
    if (dbConnected !== false) return;
    setReiniciando(true);
    try {
      await resetPauseState();
      await reiniciarPlantao(brokers);
      await supabase.from('plantao_daily_closures').delete().eq('date', plantaoDate);
      await supabase.from('incorporadora_direct_leads').delete().eq('is_test', true);
      resetSimulatorReport(plantaoDate);
      setQuickLog([]);
      resetClock();
      await load();
      setReiniciarDialog(false);
    } finally {
      setReiniciando(false);
    }
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
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-amber-400 border-t-transparent mb-4" />
          <div className="text-slate-400 text-lg">A carregar plantão…</div>
        </div>
      </div>
    );
  }

  if (loadError && brokers.length === 0) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center max-w-md mx-4">
          <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-8">
            <h2 className="text-xl font-bold text-red-400 mb-2">Erro de conexão</h2>
            <p className="text-slate-400 text-sm mb-4">{loadError}</p>
            <button onClick={() => { setLoading(true); load(); }} className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-6 py-2.5 rounded-xl transition">
              Tentar novamente
            </button>
          </div>
        </div>
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

              {dbConnected === false && <button
                onClick={() => setReiniciarDialog(true)}
                className="flex items-center gap-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-2 rounded-lg text-sm font-medium transition border border-red-500/20"
                title="Reiniciar plantão para novo teste"
              >
                <RefreshCw className="h-4 w-4" /> Reiniciar Plantão
              </button>}
            </div>
            </div>

          {/* Status banners */}
          {schedule.overtime && <p className="text-amber-300 py-2">Hora extra opcional até 21h. Para dar saída, use “Encerrar expediente” no painel do corretor.</p>}
          {schedule.closed && <p className="text-amber-300 py-2">Expediente encerrado. Os atendimentos em curso podem ser finalizados.</p>}
          {schedule.coexistence && <p className="text-indigo-300 py-2">As filas da manhã seguem ativas. As três filas da tarde aguardam 14:00:01 na Auditoria.</p>}
          {isPreSorteio && (
            <div className="flex items-center gap-2 bg-sky-500/10 border border-sky-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-sky-400">
              <Clock className="h-4 w-4 shrink-0" />
              <span><strong className="text-sky-300">Período Pré-Sorteio</strong> — Atendimento por Ordem de Chegada. O primeiro corretor disponível que registrou presença atende. Sorteio automático às {currentShift === 'manha' ? '08:46:00' : '13:46:00'}.</span>
            </div>
          )}

          {!sorteioTriggered && !isPreSorteio && (
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
        {loadError && <p role="alert" className="text-red-400 mb-4">{loadError}</p>}
        {view === 'auditoria' && <ShiftClosingDashboard />}
        {view === 'auditoria' && <PauseAuditPanel brokers={brokers} />}
        {(view === 'recepcao' || view === 'corretor') && <OfficialClosingPanel key={plantaoDate}
          date={plantaoDate} closed={closed} onClosed={() => setClosedDay(plantaoDate)} />}
        {closed && <p role="status" className="mb-4 text-amber-300">Plantão encerrado para esta data.</p>}
        {publishedDraws.morning && <PendingShiftQueues draw={publishedDraws.morning} brokers={brokers}
          title={schedule.preOpening ? 'Sorteio da manhã — ordem de chegada até 08:59:59' : 'Sorteio da manhã'} />}
        {publishedDraws.afternoon && <PendingShiftQueues draw={publishedDraws.afternoon} brokers={brokers}
          title={schedule.coexistence ? 'Sorteio da tarde — fila da manhã ainda em operação' : 'Sorteio da tarde'} />}
        {view === 'auditoria' && <section className="mb-6 grid md:grid-cols-2 gap-4">{(['manha', 'tarde'] as const).filter(shift => !isExtendedShift || shift === 'manha').map(shift => <div key={shift}><h2 className="font-bold">Inscritos — {shift === 'manha' ? 'Manhã / Integral' : 'Tarde'}</h2><ul>{brokers.filter(b => !b.is_external_partner && (shift === 'manha' ? (morningDraw && [...morningDraw.viva, ...morningDraw.nobre].includes(b.id)) || b.shift === 'manha' && b.arrived_at?.startsWith(plantaoDate) : (b as Broker & { afternoon_enrolled_at?: string }).afternoon_enrolled_at?.startsWith(plantaoDate) || b.shift === 'tarde' && b.arrived_at)).map(b => <li key={b.id}>{b.operational_name} · {b.agency}</li>)}</ul></div>)}</section>}
        {view === 'recepcao' && !closed && <><ExternalPartnerPanel /><RecepcaoPanel brokers={brokers} visits={visits} queue={queue}
          allowTestControls={dbConnected === false || import.meta.env.VITE_PLANTAO_TEST_DATABASE === 'true'} quickLog={quickLog} setQuickLog={setQuickLog} /></>}
        {view === 'chamadas' && !closed && <><ExternalPartnerPanel callsOnly /><ChamadasPanel queue={queue} brokers={brokers} /></>}
        {view === 'corretor' && !closed && <><CorretorPanel brokers={brokers} /><ExternalPartnerPanel managementOnly /></>}
        {view === 'fila' && !closed && <FilaPanel queue={sortedQueue} brokers={brokers} allQueue={queue} />}
        {view === 'auditoria' && <AuditoriaPanel brokers={brokers.filter(b => !onlyOwn(b))} queue={queue} isAfternoonActive={isAfternoonActive} isMorningQueueActive={isMorningQueueActive} />}
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
                <span>O histórico de visitas fica disponível para testar Retorno e Duplicidade.</span>
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

function brokerStatusBadge(b: Broker): { label: string; color: string } {
  if (b.presence_status === 'pausa') return { label: 'Pausado', color: 'bg-red-500/15 text-red-400' };
  switch (b.attendance_status) {
    case 'livre': return { label: 'Livre', color: 'bg-emerald-500/15 text-emerald-400' };
    case 'em_mesa': return { label: 'Chamado', color: 'bg-amber-500/15 text-amber-400' };
    case 'em_atendimento': return { label: 'Em Atendimento', color: 'bg-sky-500/15 text-sky-400' };
    case 'decorado': return { label: 'Decorado', color: 'bg-indigo-500/15 text-indigo-400' };
    case 'encerrado': return { label: 'Encerrado', color: 'bg-slate-600/30 text-slate-400' };
    case 'apenas_indicacao': return { label: 'Apenas Indicação', color: 'bg-purple-500/15 text-purple-400' };
    default: return { label: b.attendance_status, color: 'bg-slate-600/30 text-slate-400' };
  }
}

function AuditoriaPanel({ brokers, queue, isAfternoonActive, isMorningQueueActive }: {
  brokers: Broker[];
  queue: QueueEntry[];
  isAfternoonActive: boolean;
  isMorningQueueActive: boolean;
}) {
  const { isPreSorteio: isPreOpening } = useSim();
  return (
    <div className="space-y-6">
      {/* FILA DE ORDEM DE CHEGADA — fixada para auditoria */}
      {isPreOpening && (
      <div className="bg-slate-900 rounded-2xl border border-sky-500/20 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="bg-sky-500/10 p-3 rounded-xl"><Clock className="h-6 w-6 text-sky-400" /></div>
          <div>
            <h2 className="text-xl font-bold text-sky-400">Fila de Ordem de Chegada</h2>
            <p className="text-sm text-slate-400">Ordem cronológica do ponto (timestamp de check-in) — válida até 09:00h</p>
          </div>
        </div>
        <div className="space-y-2">
          {[...brokers]
            .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.arrived_at)
            .sort((a, b) => new Date(a.arrived_at!).getTime() - new Date(b.arrived_at!).getTime())
            .map((b, i) => {
              const late = isLateForSort(b.arrived_at, b.shift ?? 'manha');
              return (
                <div key={b.id} className={`flex items-center gap-3 rounded-lg p-3 border ${late ? 'bg-red-500/5 border-red-500/20' : 'bg-slate-800/50 border-sky-500/10'}`}>
                  <span className="font-mono text-sm text-sky-400/60 w-8 text-center font-bold">{i + 1}.</span>
                  <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
                  <span className="text-xs text-slate-500 font-mono">{new Date(b.arrived_at!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  {late && <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Atrasado</span>}
                </div>
              );
            })}
          {brokers.filter((b) => !b.is_external_partner && b.presence_status === 'presente' && b.arrived_at).length === 0 && (
            <p className="text-sm text-slate-500 text-center py-6">Nenhum corretor registrou presença ainda.</p>
          )}
        </div>
      </div>
      )}

      {/* TRÊS FILAS ISOLADAS — Tempo Real */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tabela 1: Fila Direta — Empresa A (Viva) */}
        <div className={`bg-slate-900 rounded-2xl border p-6 ${isAfternoonActive ? 'border-indigo-500/20' : 'border-amber-500/20'}`}>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl ${isAfternoonActive ? 'bg-indigo-500/10' : 'bg-amber-500/10'}`}><ListOrdered className={`h-6 w-6 ${isAfternoonActive ? 'text-indigo-400' : 'text-amber-400'}`} /></div>
              <div>
                <h2 className={`text-xl font-bold ${isAfternoonActive ? 'text-indigo-400' : 'text-amber-400'}`}>Fila Direta — Empresa A{isAfternoonActive ? ' · Tarde' : ''}</h2>
                <p className="text-sm text-slate-400">Viva Imóveis · Vez Geral</p>
              </div>
            </div>
            <span className={`text-2xl font-bold tabular-nums ${isAfternoonActive ? 'text-indigo-400' : 'text-amber-400'}`}>
              {brokers.filter((b) => !b.is_external_partner && b.agency === 'Viva Imóveis' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length}
            </span>
          </div>
          <div className="space-y-2">
            {[...brokers]
              .filter((b) => !b.is_external_partner && b.agency === 'Viva Imóveis' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha'))
              .sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999))
              .map((b, i) => {
                const { label, color } = brokerStatusBadge(b);
                return (
                  <div key={b.id} className={`flex items-center gap-3 bg-slate-800/50 rounded-lg p-3 border ${isAfternoonActive ? 'border-indigo-500/10' : 'border-amber-500/10'}`}>
                    <span className={`font-mono text-sm w-8 text-center font-bold ${isAfternoonActive ? 'text-indigo-400/60' : 'text-amber-400/60'}`}>{i + 1}.</span>
                    <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                    <span className="text-xs text-slate-500 hidden sm:inline">{b.equipe}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>{label}</span>
                  </div>
                );
              })}
            {brokers.filter((b) => !b.is_external_partner && b.agency === 'Viva Imóveis' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length === 0 && (
              <p className="text-sm text-slate-500 text-center py-6">Nenhum corretor presente.</p>
            )}
          </div>
        </div>

        {/* Tabela 2: Fila Direta — Empresa B (Nobre) */}
        <div className={`bg-slate-900 rounded-2xl border p-6 ${isAfternoonActive ? 'border-indigo-500/20' : 'border-sky-500/20'}`}>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl ${isAfternoonActive ? 'bg-indigo-500/10' : 'bg-sky-500/10'}`}><ListOrdered className={`h-6 w-6 ${isAfternoonActive ? 'text-indigo-400' : 'text-sky-400'}`} /></div>
              <div>
                <h2 className={`text-xl font-bold ${isAfternoonActive ? 'text-indigo-400' : 'text-sky-400'}`}>Fila Direta — Empresa B{isAfternoonActive ? ' · Tarde' : ''}</h2>
                <p className="text-sm text-slate-400">Casa Nobre · Vez Geral</p>
              </div>
            </div>
            <span className={`text-2xl font-bold tabular-nums ${isAfternoonActive ? 'text-indigo-400' : 'text-sky-400'}`}>
              {brokers.filter((b) => !b.is_external_partner && b.agency === 'Casa Nobre' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length}
            </span>
          </div>
          <div className="space-y-2">
            {[...brokers]
              .filter((b) => !b.is_external_partner && b.agency === 'Casa Nobre' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha'))
              .sort((a, b) => (a.sorteio_order ?? 999) - (b.sorteio_order ?? 999))
              .map((b, i) => {
                const { label, color } = brokerStatusBadge(b);
                return (
                  <div key={b.id} className={`flex items-center gap-3 bg-slate-800/50 rounded-lg p-3 border ${isAfternoonActive ? 'border-indigo-500/10' : 'border-sky-500/10'}`}>
                    <span className={`font-mono text-sm w-8 text-center font-bold ${isAfternoonActive ? 'text-indigo-400/60' : 'text-sky-400/60'}`}>{i + 1}.</span>
                    <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                    <span className="text-xs text-slate-500 hidden sm:inline">{b.equipe}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>{label}</span>
                  </div>
                );
              })}
            {brokers.filter((b) => !b.is_external_partner && b.agency === 'Casa Nobre' && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length === 0 && (
              <p className="text-sm text-slate-500 text-center py-6">Nenhum corretor presente.</p>
            )}
          </div>
        </div>

        {/* Tabela 3: Fila Inversa Geral (Decorado) */}
        <div className={`bg-slate-900 rounded-2xl border p-6 ${isAfternoonActive ? 'border-indigo-500/20' : 'border-orange-500/20'}`}>
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-xl ${isAfternoonActive ? 'bg-indigo-500/10' : 'bg-orange-500/10'}`}><Home className={`h-6 w-6 ${isAfternoonActive ? 'text-indigo-400' : 'text-orange-400'}`} /></div>
              <div>
                <h2 className={`text-xl font-bold ${isAfternoonActive ? 'text-indigo-400' : 'text-orange-400'}`}>Fila Inversa Geral{isAfternoonActive ? ' · Tarde' : ''}</h2>
                <p className="text-sm text-slate-400">Decorado · Índice independente</p>
              </div>
            </div>
            <span className={`text-2xl font-bold tabular-nums ${isAfternoonActive ? 'text-indigo-400' : 'text-orange-400'}`}>
              {brokers.filter((b) => !b.is_external_partner && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length}
            </span>
          </div>
          <div className="space-y-2">
            {[...brokers]
              .filter((b) => !b.is_external_partner && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha'))
              .sort((a, b) => (a.inverse_order ?? 999_999) - (b.inverse_order ?? 999_999))
              .map((b, i) => {
                const { label, color } = brokerStatusBadge(b);
                return (
                  <div key={b.id} className={`flex items-center gap-3 bg-slate-800/50 rounded-lg p-3 border ${isAfternoonActive ? 'border-indigo-500/10' : 'border-orange-500/10'}`}>
                    <span className={`font-mono text-sm w-8 text-center font-bold ${isAfternoonActive ? 'text-indigo-400/60' : 'text-orange-400/60'}`}>{i + 1}.</span>
                    <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                    <span className="text-xs text-slate-500 hidden lg:inline">{b.equipe}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>{label}</span>
                  </div>
                );
              })}
            {brokers.filter((b) => !b.is_external_partner && b.presence_status === 'presente' && (isAfternoonActive ? b.shift === 'tarde' : b.shift === 'manha')).length === 0 && (
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
