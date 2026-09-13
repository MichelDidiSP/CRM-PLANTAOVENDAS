import { useEffect, useState, useRef, useCallback } from 'react';
import { Building2, DoorOpen, Tv, Users, ListOrdered, Zap, Clock, Plus, Shuffle, ClipboardList, RefreshCw, FileText, X, Trophy } from 'lucide-react';
import { supabase, type Broker, type QueueEntry, type Visit } from '@/lib/supabase';
import { fetchAll, interleaveQueue, executeSorteio, reiniciarPlantao, type SorteioResult } from '@/lib/queueEngine';
import { SimProvider, useSim } from '@/lib/simContext';

import RecepcaoPanel from '@/components/RecepcaoPanel';
import ChamadasPanel from '@/components/ChamadasPanel';
import CorretorPanel from '@/components/CorretorPanel';
import FilaPanel from '@/components/FilaPanel';

type View = 'recepcao' | 'chamadas' | 'corretor' | 'fila' | 'auditoria';

function AppContent() {
  const { clockDisplay, setStartTime, addMinute, testMode, setTestMode, sorteioTriggered, resetClock, simSeconds } = useSim();
  const [view, setView] = useState<View>('recepcao');
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sorteioResult, setSorteioResult] = useState<SorteioResult | null>(null);
  const [reiniciarDialog, setReiniciarDialog] = useState(false);
  const [attendanceReport, setAttendanceReport] = useState<QueueEntry[] | null>(null);
  const [reiniciando, setReiniciando] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);
  const sorteioExecutedRef = useRef(false);

  const load = useCallback(async () => {
    const data = await fetchAll();
    if (data.error) return;
    setBrokers(data.brokers);
    setVisits(data.visits);
    setQueue(data.queue);
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

  // Sorteio automático às 08:46:00
  useEffect(() => {
    if (sorteioTriggered && !sorteioExecutedRef.current && brokers.length > 0) {
      sorteioExecutedRef.current = true;
      executeSorteio(brokers, simSeconds).then((result) => {
        if (result) {
          setSorteioResult(result);
          load();
        }
      });
    }
  }, [sorteioTriggered, brokers, simSeconds, load]);

  // Reset sorteio flag when clock is reset
  useEffect(() => {
    if (!sorteioTriggered) {
      sorteioExecutedRef.current = false;
    }
  }, [sorteioTriggered]);

  const sortedQueue = interleaveQueue(queue, brokers);

  async function handleReiniciar() {
    setReiniciando(true);
    // Coletar dados do relatório ANTES de limpar
    const concluded = queue.filter((e) => e.queue_status === 'concluido' || e.queue_status === 'em_atendimento');
    setAttendanceReport(concluded);

    await reiniciarPlantao(brokers);
    resetClock();
    setSorteioResult(null);
    sorteioExecutedRef.current = false;
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

            <div className="flex items-center gap-2 flex-wrap justify-end">
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

              <button onClick={addMinute} className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg text-sm font-medium transition" title="Avançar 1 minuto">
                <Plus className="h-4 w-4" /> +1 min
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

          {sorteioTriggered && sorteioResult && (
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2 mb-2 text-sm text-emerald-400">
              <Shuffle className="h-4 w-4 shrink-0" />
              <span><strong className="text-emerald-300">Sorteio automático executado às 08:46:00</strong> — {sorteioResult.vivaBrokers.length} corretores Viva + {sorteioResult.nobreBrokers.length} Casa Nobre intercalados. <strong className="text-amber-300">Sorteio entre Empresas: {sorteioResult.desempateWinner} ganhou a preferência</strong> e inicia a intercalação. {sorteioResult.lateBrokers.length} atrasado(s) no fim da fila.</span>
            </div>
          )}

          {!sorteioTriggered && (
            <div className="flex items-center gap-2 bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2 mb-2 text-sm text-slate-400">
              <Clock className="h-4 w-4 shrink-0 text-amber-400" />
              <span>Sorteio automático às <strong className="text-amber-400">08:46:00</strong>. Marque os corretores como presentes antes deste horário.</span>
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
            <p className="text-sm text-slate-500 mt-1">Aguarde o relógio chegar a 08:46:00 ou avance o tempo manualmente.</p>
          </div>
        ) : (
          <div className="space-y-6">
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

            {/* Fila Geral unificada */}
            <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-4">
              <h3 className="font-bold text-slate-200 mb-3 flex items-center gap-2"><ListOrdered className="h-4 w-4" /> Fila Geral Unificada (intercalada)</h3>
              <div className="space-y-1.5">
                {sorteioResult.interleavedBrokers.map((b, i) => {
                  const isLate = sorteioResult.lateBrokers.includes(b);
                  return (
                    <div key={b.id} className="flex items-center gap-3 bg-slate-900/60 rounded-lg p-2.5">
                      <span className="font-mono text-sm text-slate-500 w-8 text-center">{i + 1}.</span>
                      <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
                      {isLate && <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">Atrasado</span>}
                    </div>
                  );
                })}
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

      {/* Estado atual dos corretores */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6">
        <h3 className="font-bold text-slate-200 mb-4">Estado atual dos corretores</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {brokers.filter((b) => !b.is_external_partner).map((b) => (
            <div key={b.id} className="flex items-center gap-3 bg-slate-800/50 rounded-lg p-3">
              <span className="text-white text-sm font-medium flex-1">{b.operational_name}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${b.agency === 'Viva Imóveis' ? 'bg-amber-500/15 text-amber-400' : 'bg-sky-500/15 text-sky-400'}`}>{b.agency}</span>
              {b.sorteio_order != null && <span className="text-xs text-slate-400">Posição: {b.sorteio_order}</span>}
              <span className={`text-xs px-2 py-0.5 rounded-full ${b.presence_status === 'presente' ? 'bg-emerald-500/15 text-emerald-400' : b.presence_status === 'pausa' ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-600/30 text-slate-400'}`}>{b.presence_status}</span>
            </div>
          ))}
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
