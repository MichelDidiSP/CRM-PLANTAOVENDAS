import { useLayoutEffect, useState } from 'react';
import { useSim } from '@/lib/simContext';
import type { Broker, QueueEntry, Visit } from '@/lib/supabase';
import { resetTestPlantao } from './resetTestPlantao';
import { createVirtualClock } from './virtualClock';
import QuickEntryPanel from './QuickEntryPanel';
import TestCustomers from './TestCustomers';

type Props = {
  brokers: Broker[]; visits: Visit[]; queue: QueueEntry[]; closed: boolean; dbConnected: boolean | null;
  onChanged: () => Promise<unknown>; runMaintenance: (work: () => Promise<void>) => Promise<void>;
};
// Same max-w-7xl / px-4 sm:px-6 alignment, without a short containing box
// that would release the sticky bar at the end of the TESTE panel.
const panelWidth = 'mx-auto w-[calc(100%-2rem)] max-w-[78rem] sm:w-[calc(100%-3rem)] sm:max-w-[77rem]';

export default function TestModule({ brokers, visits, queue, closed, onChanged, runMaintenance }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [clock] = useState(createVirtualClock);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const { clockDisplay, plantaoDate, testMode } = useSim();
  useLayoutEffect(() => enabled ? clock.start() : undefined, [enabled, clock]);
  const [resetVersion, setResetVersion] = useState(0);

  async function reset() {
    if (!enabled || resetting) return;
    setResetting(true); setError('');
    try {
      await runMaintenance(async () => {
        await resetTestPlantao(plantaoDate, enabled);
        clock.reset();
      });
      setResetVersion(value => value + 1);
      setConfirmReset(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível reiniciar o teste.'); }
    finally { setResetting(false); }
  }

  return <div className="contents">
    <div className={`${panelWidth} py-2`}>
    <button type="button" aria-expanded={enabled} aria-controls="test-module" disabled={resetting}
      className={`rounded-lg px-4 py-2 text-sm font-bold ${enabled ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-amber-300'}`}
      onClick={() => { setEnabled(value => !value); setConfirmReset(false); }}>TESTE</button>
    </div>
    {enabled && <section id="test-module" aria-label="Módulo TESTE" className="contents">
      <div role="region" aria-label="Controles de tempo do TESTE" className={`sticky top-0 z-40 space-y-4 bg-slate-900 ${panelWidth} mt-1 rounded-t-2xl border border-b-0 border-amber-500/30 p-4 pb-0`}>
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
        <button type="button" onClick={() => setConfirmReset(true)} className="rounded bg-red-500/20 px-3 py-2 text-red-300 disabled:opacity-50">Reiniciar Plantão</button>
      </fieldset>
      </div>
      <div className={`${panelWidth} mb-2 space-y-4 rounded-b-2xl border border-t-0 border-amber-500/30 bg-slate-900 p-4`}>
      {closed && <p className="text-amber-300">Plantão fechado. Reinicie o teste para realizar novas entradas.</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <QuickEntryPanel key={resetVersion} brokers={brokers} visits={visits} queue={queue} disabled={closed || resetting} onChanged={onChanged} />
      <TestCustomers brokers={brokers} visits={visits} queue={queue} />
      {confirmReset && <div role="dialog" aria-label="Reiniciar Plantão" className="rounded-xl border border-red-500/30 p-4">
        <p className="mb-3 text-sm">Limpar filas, visitas de teste, sorteios e pausas deste dia, reabrir o plantão e voltar às 08:30? Os fatos quantitativos históricos e os cadastros dos corretores serão preservados.</p>
        <button type="button" disabled={resetting} onClick={() => void reset()} className="rounded bg-red-600 px-3 py-2">Confirmar reinício</button>
        <button type="button" disabled={resetting} onClick={() => setConfirmReset(false)} className="ml-3 rounded bg-slate-800 px-3 py-2">Cancelar</button>
      </div>}
      </div>
    </section>}
  </div>;
}
