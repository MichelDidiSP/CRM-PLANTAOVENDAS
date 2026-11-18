import { dbReady, supabase } from '@/lib/supabase';
import { businessDate } from '@/lib/reports/shiftClosingReport';

export type TestDirectLead = { id: string; customer_name: string; phone: string; created_at: string };

/** The remote projection exposes only test records, never the private operational table. */
export async function loadTestDirectLeads(day: string): Promise<TestDirectLead[]> {
  await dbReady;
  const remote = typeof supabase.rpc === 'function';
  const query = supabase.from(remote ? 'test_incorporadora_direct_leads' : 'incorporadora_direct_leads')
    .select('id,customer_name,phone,created_at');
  const { data, error } = await (remote ? query.eq('test_date', day) : query.eq('is_test', true));
  if (error) throw new Error(error.message);
  return (data ?? []).filter((lead: TestDirectLead) => businessDate(lead.created_at) === day);
}
