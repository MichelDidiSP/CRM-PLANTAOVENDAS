import { useState } from 'react';
import { useSim } from '@/lib/simContext';
import { setDayExtension } from '@/lib/operations/dayStore';

export default function DayExtensionControl({ date, closed, onChanged }: {
  date: string; closed: boolean; onChanged: () => Promise<unknown>;
}) {
  const { cashSigning } = useSim();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(enabled: boolean) {
    setBusy(true); setError('');
    try { await setDayExtension(date, enabled); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível alterar a extensão do plantão.'); }
    finally { setBusy(false); }
  }
  return <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
    <label className="flex items-center gap-3 text-sm">
      <input type="checkbox" checked={cashSigning} disabled={closed || busy} onChange={event => void change(event.target.checked)}
        className="h-5 w-5 accent-amber-400" />Dia de Assinatura Caixa (Estender Plantão)
    </label>
    {cashSigning && !closed && <p role="status" className="mt-2 text-amber-300">Plantão estendido — Dia de Assinatura Caixa ativo</p>}
    {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
  </div>;
}
