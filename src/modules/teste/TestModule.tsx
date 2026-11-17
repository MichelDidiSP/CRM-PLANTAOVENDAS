import { useLayoutEffect, useState } from 'react';
import { useSim } from '@/lib/simContext';
import { supabase, type Broker, type QueueEntry, type Visit } from '@/lib/supabase';
import { reiniciarPlantao } from '@/lib/queueEngine';
import { resetPauseState } from '@/lib/queue/pauseAndPartnersStore';
import { loadReportRows } from '@/lib/reports/reportStore';
import { createVirtualClock } from './virtualClock';
import QuickEntryPanel from './QuickEntryPanel';
import TestCustomers from './TestCustomers';

type Props = {
  brokers: Broker[]; visits: Visit[]; queue: QueueEntry[]; closed: boolean; dbConnected: boolean | null;
  onChanged: () => Promise<unknown>; runMaintenance: (work: () => Promise<void>) => Promise<void>;
};
export default function TestModule({ brokers, visits, queue, closed, dbConnected, onChanged, runMaintenance }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [clock] = useState(createVirtualClock);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const { clockDisplay, plantaoDate, currentShift, testMode } = useSim();
  useLayoutEffect(() => enabled ? clock.start() : undefined, [enabled, clock]);
  const canReset = dbConnected === false || import.meta.env.VITE_PLANTAO_TEST_DATABASE === 'true';

  async function reset() {
    if (!enabled || !canReset || resetting) return;
    setResetting(true); setError('');
    try {
      await runMaintenance(async () => {
        // Retain quantitative history before the original reset removes queue rows.
        await loadReportRows({ period: 'day', date: plantaoDate, shift: currentShift });
        await resetPauseState();
        await reiniciarPlantao(brokers);
        const result = await supabase.from('plantao_daily_closures').delete().eq('date', plantaoDate);
        if (result.error) throw result.error;
        clock.reset();
      });
      setConfirmReset(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível reiniciar o teste.'); }
    finally { setResetting(false); }
  }

  return <div className="py-2">
    <button type="button" aria-expanded={enabled} aria-controls="test-module" disabled={resetting}
      className={`rounded-lg px-4 py-2 text-sm font-bold ${enabled ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-amber-300'}`}
      onClick={() => { setEnabled(value => !value); setConfirmReset(false); }}>TESTE</button>
    {enabled && <section id="test-module" aria-label="Módulo TESTE" className="mt-3 space-y-4 rounded-2xl border border-amber-500/30 bg-slate-900 p-4">
      <p className="text-sm text-amber-300">Modo TESTE ativo · relógio virtual · mesma base e motor do plantão.</p>
      <fieldset disabled={resetting} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Relógio virtual
          <input aria-label="Horário virtual" type="time" step="1" value={clockDisplay} onChange={event => clock.setTime(event.target.value)}
            className="mt-1 block rounded bg-slate-800 px-3 py-2" />
        </label>
        <label className="text-sm">Data do teste
          <input type="date" value={plantaoDate} onChange={event => clock.setDate(event.target.value)} className="mt-1 block rounded bg-slate-800 px-3 py-2" />
        </label>
        <button type="button" onClick={clock.addMinute} className="rounded bg-slate-800 px-3 py-2">+1 min</button>
        <button type="button" onClick={() => clock.setTime('13:40:00')} className="rounded bg-slate-800 px-3 py-2">Pular para a Tarde</button>
        <button type="button" aria-pressed={testMode} onClick={() => clock.setFast(!testMode)} className="rounded bg-slate-800 px-3 py-2">{testMode ? 'Chamadas: 10 segundos' : 'Chamadas: 2 minutos'}</button>
        <button type="button" disabled={!canReset} onClick={() => setConfirmReset(true)} className="rounded bg-red-500/20 px-3 py-2 text-red-300 disabled:opacity-50">Reiniciar Plantão</button>
      </fieldset>
      {!canReset && <p className="text-xs text-slate-400">O reset exige uma base de testes identificada na configuração do ambiente.</p>}
      {closed && <p className="text-amber-300">Plantão fechado. Reinicie o teste para realizar novas entradas.</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <QuickEntryPanel brokers={brokers} visits={visits} queue={queue} disabled={closed || resetting} onChanged={onChanged} />
      <TestCustomers brokers={brokers} visits={visits} queue={queue} />
      {confirmReset && <div role="dialog" aria-label="Reiniciar Plantão" className="rounded-xl border border-red-500/30 p-4">
        <p className="mb-3 text-sm">Reiniciar filas e status dos corretores, reabrir o plantão de teste e voltar às 08:30? O histórico quantitativo será preservado.</p>
        <button type="button" disabled={resetting} onClick={() => void reset()} className="rounded bg-red-600 px-3 py-2">Confirmar reinício</button>
        <button type="button" disabled={resetting} onClick={() => setConfirmReset(false)} className="ml-3 rounded bg-slate-800 px-3 py-2">Cancelar</button>
      </div>}
    </section>}
  </div>;
}
