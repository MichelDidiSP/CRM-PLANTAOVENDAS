import ReturnOfferPanel from './ReturnOfferPanel';
import { useState } from 'react';
import type { Broker } from '@/lib/supabase';
import { useSim } from '@/lib/simContext';
import { firstName } from '@/lib/reception/intake';
import { canRefuseInverse, type ManagedEntry } from '@/lib/reception/operationalChoices';
import { changeNominalWaiting, refuseInverseCall } from '@/lib/reception/operationalStore';

export default function ReceptionActions({ brokers, queue, onChanged }: {
  brokers: Broker[]; queue: ManagedEntry[]; onChanged?: () => Promise<unknown>;
}) {
  const { simSeconds, isExtendedShift, plantaoDate, getCurrentTime } = useSim();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const offers = queue.some(e => e.queue_status === 'aguardando' && e.reception_policy?.returnConfirmation?.offer);
  const rows = queue.filter(e => !e.reception_policy?.returnConfirmation?.offer &&
    (e.queue_status === 'aguardando' && e.reception_policy?.mode || canRefuseInverse(e, brokers, queue)));
  async function act(entry: ManagedEntry, refusal: boolean) {
    if (running) return;
    setRunning(true); setError('');
    try {
      const clock = { seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate };
      if (refusal) await refuseInverseCall(entry.id, clock, getCurrentTime().toISOString(), entry);
      else await changeNominalWaiting(entry.id, clock, getCurrentTime().toISOString());
      await onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível alterar o atendimento.'); }
    finally { setRunning(false); }
  }
  if (!rows.length && !error && !offers) return null;
  return <><ReturnOfferPanel brokers={brokers} queue={queue} onChanged={onChanged} /><section aria-label="Decisões de atendimento" className="mb-4 rounded-2xl border border-amber-500/30 bg-slate-900 p-4 space-y-3">
    <h2 className="font-bold">Decisões de atendimento</h2>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {rows.map(entry => <div key={entry.id} className="rounded-lg bg-slate-800 p-3 text-sm">
      <p className="font-medium">{firstName(entry.visit?.customer_name ?? 'Cliente')}</p>
      {entry.reception_policy?.mode === 'nominal' ? <>
        <p>Aguardando exclusivamente {brokers.find(b => b.id === entry.reception_policy?.ownerId)?.operational_name ?? 'o corretor original'} · 100% da comissão.</p>
        <p className="text-xs text-slate-400">Ao escolher outro corretor, o atendimento será com Fifty.</p>
        <button type="button" disabled={running} onClick={() => void act(entry, false)} className="mt-2 rounded bg-amber-500 px-3 py-2 text-slate-950 disabled:opacity-50">Mudou de ideia / Atender com outro corretor</button>
      </> : canRefuseInverse(entry, brokers, queue) ? <>
        <p>Chamada para {brokers.find(b => b.id === entry.broker_id)?.operational_name} · posição direta preservada.</p>
        <button type="button" disabled={running} onClick={() => void act(entry, true)} className="mt-2 rounded bg-amber-500 px-3 py-2 text-slate-950 disabled:opacity-50">Recusar (Ir para o Fim da Fila Inversa)</button>
      </> : <p>{entry.reception_policy?.mode === 'arrival' ? 'Espera prioritária pelo primeiro corretor livre que chegar' : 'Aguardando cobertura: equipe → empresa → outra empresa'}{entry.reception_policy?.ownerId ? ' · Fifty com o corretor original.' : ' · 100% da comissão.'}</p>}
    </div>)}
  </section></>;
}
