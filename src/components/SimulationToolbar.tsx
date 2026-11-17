import { useState, type RefCallback } from 'react';
import { ChevronDown, ChevronUp, Clock, RefreshCw } from 'lucide-react';
import { useSim } from '@/lib/simContext';

type Props = {
  localSimulation: boolean;
  ready: boolean;
  resetting: boolean;
  onReset: () => void;
  quickControlsRef: RefCallback<HTMLDivElement>;
};

export default function SimulationToolbar({ localSimulation, ready, resetting, onReset, quickControlsRef }: Props) {
  const [expanded, setExpanded] = useState(true);
  const { clockDisplay, setStartTime, addMinute, testMode, setTestMode, plantaoDate, setPlantaoDate } = useSim();
  const simulationUrl = new URL(window.location.href);
  simulationUrl.searchParams.set('simulacao', '1');

  return <section aria-label="Modo Simulação / Testes Rápidos" className="border-b border-slate-700 bg-slate-900 text-slate-100">
    <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <button type="button" aria-expanded={expanded} aria-controls="simulation-controls"
          className="flex items-center gap-2 py-1 text-sm font-semibold text-amber-300" onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          Modo Simulação / Testes Rápidos
        </button>
        <output aria-label="Hora virtual" className="font-mono text-sm tabular-nums">{clockDisplay}</output>
      </div>
      <div id="simulation-controls" hidden={!expanded}>
        {ready && !localSimulation && <p className="mb-2 text-sm text-slate-300">
          <a className="text-amber-300 underline" href={simulationUrl.href}>Abrir ambiente local de simulação</a>
          {' '}para usar todos os controles em uma base de testes em memória.
        </p>}
        <fieldset disabled={!ready || resetting} className="flex flex-wrap items-end gap-3 py-2 disabled:opacity-50">
          <label className="text-xs text-slate-300">Relógio virtual
            <input aria-label="Definir horário virtual" type="time" step="1" value={clockDisplay}
              onChange={event => { if (event.target.value) setStartTime(event.target.value); }}
              className="mt-1 block rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs text-slate-300">Data do teste
            <input type="date" value={plantaoDate} onChange={event => { if (event.target.value) setPlantaoDate(event.target.value); }}
              className="mt-1 block rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white" />
          </label>
          <button type="button" onClick={addMinute} className="rounded bg-slate-800 px-3 py-2 text-sm">+1 minuto</button>
          <div className="flex flex-wrap gap-1" aria-label="Atalhos de horário">
            {['08:00', '08:46', '09:00', '13:46', '14:00', '19:00'].map(time =>
              <button type="button" key={time} onClick={() => setStartTime(time)} className="rounded bg-slate-800 px-2 py-2 text-sm">
                {time}
              </button>,
            )}
          </div>
          <button type="button" aria-pressed={testMode} onClick={() => setTestMode(!testMode)}
            className="rounded bg-slate-800 px-3 py-2 text-sm">Chamadas de teste · {testMode ? '10 s' : '2 min'}</button>
          <button type="button" disabled={!localSimulation} onClick={onReset}
            title={localSimulation ? 'Reiniciar filas e reabrir o plantão de teste' : 'Abra o ambiente local de simulação para usar o reset'}
            className="flex items-center gap-2 rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-50">
            <RefreshCw className="h-4 w-4" /> Reiniciar Plantão (Reset de Teste)
          </button>
        </fieldset>
        <div ref={quickControlsRef} />
        <p className="flex items-center gap-1 py-1 text-xs text-slate-400"><Clock className="h-3 w-3" />
          Os horários definidos aqui comandam o relógio virtual do plantão.
        </p>
      </div>
    </div>
  </section>;
}
