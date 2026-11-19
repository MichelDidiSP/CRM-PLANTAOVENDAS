import type { Broker } from '@/lib/supabase';
import type { ManagedEntry } from '@/lib/reception/operationalChoices';
import { firstName } from '@/lib/reception/intake';

export default function ReceptionAuditPanel({ brokers, queue }: { brokers: Broker[]; queue: ManagedEntry[] }) {
  const events = queue.flatMap(entry => (entry.reception_policy?.events ?? []).map((event, i) => ({ entry, event, key: `${entry.id}_${i}` })))
    .sort((a, b) => b.event.at.localeCompare(a.event.at));
  if (!events.length) return null;
  return <section aria-label="Auditoria de decisões da Recepção" className="mb-6 rounded-xl border border-slate-700 p-4">
    <h2 className="mb-3 font-bold">Auditoria de decisões da Recepção</h2>
    <ul className="space-y-2 text-sm">{events.map(({ entry, event, key }) => <li key={key}>
      {new Date(event.at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {firstName(entry.visit?.customer_name ?? 'Cliente')} · {event.type === 'inverse_refusal'
        ? `${brokers.find(b => b.id === event.brokerId)?.operational_name ?? event.brokerId}: recusou a Fila Inversa; ${event.position}ª posição direta preservada; movido ao final da inversa.${event.freePosition ? ` Era o ${event.freePosition}º livre da empresa.` : ''}`
        : event.type === 'return_offered' ? 'Corretor disponível; aguardando decisão do cliente sobre Fifty.'
        : event.type === 'return_accepted' ? 'Cliente autorizou atendimento com Fifty.'
        : event.type === 'return_kept_original' ? 'Cliente preferiu continuar aguardando o corretor original.'
        : event.type === 'changed_mind' ? 'Cliente desistiu da espera nominal; cobertura com Fifty autorizada.' : 'Decisão de espera registrada.'}
    </li>)}</ul>
  </section>;
}
