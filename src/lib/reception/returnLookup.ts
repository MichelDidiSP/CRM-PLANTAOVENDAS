import { dbReady, supabase } from '../supabase';
import { completePhone, normalizePhone, visitOwner } from './intake';

/** Uses the same ownership rule as intake, after connection and TESTE filtering. */
export async function lookupReceptionReturn(phone: string, includeTestVisits: boolean) {
  const digits = normalizePhone(phone);
  if (!completePhone(digits)) return null;
  await dbReady;
  const visits = await supabase.from('visits').select('*').eq('phone', digits).order('created_at', { ascending: true });
  if (visits.error) throw new Error(visits.error.message);
  const history = (visits.data ?? []).filter(visit => includeTestVisits || !visit.is_test);
  if (!history.length) return null;
  const entries = await supabase.from('queue_entries').select('*').in('visit_id', history.map(visit => visit.id));
  if (entries.error) throw new Error(entries.error.message);
  return visitOwner(history, entries.data ?? [], digits);
}
