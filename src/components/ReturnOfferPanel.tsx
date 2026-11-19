import { useRef, useState } from 'react';
import type { Broker } from '@/lib/supabase';
import { useSim } from '@/lib/simContext';
import { firstName } from '@/lib/reception/intake';
import type { ManagedEntry } from '@/lib/reception/operationalChoices';
import { answerReturnOffer, dispatchWaitingWithDecisions } from '@/lib/reception/returnDecisionStore';
import { fetchAll } from '@/lib/queueEngine';

export default function ReturnOfferPanel({ brokers, queue, onChanged }: {
  brokers: Broker[]; queue: ManagedEntry[]; onChanged?: () => Promise<unknown>;
}) {
  const { simSeconds, isExtendedShift, plantaoDate, getCurrentTime } = useSim();
  const lock = useRef(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const offers = queue.filter(e => e.queue_status === 'aguardando' && e.visit?.visit_reason === 'Retorno' && e.reception_policy?.returnConfirmation?.offer);
  async function answer(entry: ManagedEntry, accept: boolean) {
    if (lock.current) return;
    lock.current = true; setRunning(true); setError('');
    const clock = { seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate };
    try {
      await answerReturnOffer(entry.id, entry.reception_policy!.returnConfirmation!.offer!.id, accept, clock, getCurrentTime().toISOString());
      const live = await fetchAll();
      if (live.error) throw live.error;
      // A declined offer does not reserve this broker: let normal waiting clients
      // proceed now, without needing another real or virtual clock tick.
      await dispatchWaitingWithDecisions(live.queue, live.brokers, clock, getCurrentTime().toISOString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível registrar a decisão.'); }
    finally {
      try { await onChanged?.(); }
      finally { lock.current = false; setRunning(false); }
    }
  }
  if (!offers.length && !error) return null;
  return <section aria-label="Decisão de retorno com Fifty" className="mb-4 space-y-3 rounded-xl border border-amber-400/50 bg-slate-900 p-4">
    <h2 className="font-bold text-amber-300">Cliente de retorno aguardando decisão</h2>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {offers.map(entry => {
      const policy = entry.reception_policy!;
      const broker = brokers.find(b => b.id === policy.returnConfirmation!.offer!.brokerId);
      const owner = brokers.find(b => b.id === policy.ownerId);
      return <div key={entry.id} className="space-y-3 text-sm">
        <p>Corretor {broker?.operational_name ?? 'indicado'} ficou disponível. O cliente {firstName(entry.visit?.customer_name)} deseja ser atendido agora (com Fifty) ou continuar aguardando o corretor original ({owner?.operational_name ?? 'original'})?</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={running} onClick={() => void answer(entry, true)} className="rounded bg-amber-500 px-3 py-2 font-medium text-slate-950 disabled:opacity-50">Atender Agora (Com Fifty)</button>
          <button type="button" disabled={running} onClick={() => void answer(entry, false)} className="rounded bg-slate-700 px-3 py-2 disabled:opacity-50">Continuar Aguardando Original</button>
        </div>
      </div>;
    })}
  </section>;
}
