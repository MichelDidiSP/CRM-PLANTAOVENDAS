import { useEffect, useState } from 'react';
import { supabase, type Broker, type QueueEntry, type Visit } from '@/lib/supabase';

type DirectLead = { id: string; customer_name: string; phone: string; created_at: string };
export default function TestCustomers({ visits, queue, brokers }: { visits: Visit[]; queue: QueueEntry[]; brokers: Broker[] }) {
  const [direct, setDirect] = useState<DirectLead[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.resolve(supabase.from('incorporadora_direct_leads').select('id,customer_name,phone,created_at').eq('is_test', true))
      .then(result => {
        if (!active) return;
        if (result.error) setError('Não foi possível carregar os clientes de teste da Incorporadora.');
        else { setDirect(result.data ?? []); setError(''); }
      });
    return () => { active = false; };
  }, [visits]);
  const rows = [
    ...visits.filter(visit => visit.is_test).map(visit => {
      const attended = queue.find(entry => entry.visit_id === visit.id && ['em_atendimento', 'concluido'].includes(entry.queue_status));
      return { id: visit.id, name: visit.customer_name, phone: visit.phone, created_at: visit.created_at,
        broker: attended ? (attended as QueueEntry & { attending_broker_name?: string }).attending_broker_name ?? brokers.find(broker => broker.id === attended.broker_id)?.operational_name ?? 'Sem corretor registrado' : 'Ainda não atendido' };
    }),
    ...direct.map(lead => ({ ...lead, name: lead.customer_name, broker: 'Sem corretor — Incorporadora' })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return <section aria-label="Clientes Inseridos no Teste" className="overflow-x-auto rounded-xl border border-slate-700 p-4">
    <h2 className="mb-3 font-bold">Clientes Inseridos no Teste</h2>
    {error && <p role="alert">{error}</p>}
    <table className="w-full text-left text-sm"><thead><tr>
      <th className="p-2">Nome Completo</th><th className="p-2">Telefone</th><th className="p-2">Corretor que Atendeu</th>
    </tr></thead><tbody>{rows.map(row => <tr key={row.id}>
      <td className="p-2">{row.name}</td><td className="p-2">{row.phone || 'Não informado'}</td><td className="p-2">{row.broker}</td>
    </tr>)}</tbody></table>
    {!rows.length && <p className="p-2 text-sm text-slate-400">Nenhum cliente inserido no teste.</p>}
  </section>;
}
