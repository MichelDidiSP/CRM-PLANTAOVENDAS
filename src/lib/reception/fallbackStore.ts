import { dbReady, supabase, type QueueEntry, type Broker, type VisitReason, type Shift } from '../supabase';
import { dispatchBroker, markBrokerInService, markStandardBrokerInService } from '../queueEngine';
import { partnerIntake, type PartnerIntake } from '../queue/pauseAndPartners';
import { completePhone, firstName, normalizePhone } from './intake';
import type { ScheduleClock } from '../queue/shiftSchedule';
import { busyReceptionIds, resolveReceptionDispatch } from './fallbackOrchestrator';

export type DirectLead = {
  customer_name: string;
  phone: string | null;
  visit_reason: VisitReason;
  media_channel: string | null;
  media_channel_detail: string | null;
  created_at: string;
  shift: Shift;
  is_test?: boolean;
};

export async function saveDirectLead(lead: DirectLead) {
  await dbReady;
  const result = typeof supabase.rpc === 'function'
    ? await supabase.rpc('record_incorporadora_direct_lead', { lead })
    : await supabase.from('incorporadora_direct_leads').insert(lead);
  if (result.error) throw new Error(result.error.message);
}

export async function claimReceptionCall(entry: QueueEntry, broker: Broker, split: boolean, at: string, standard = false) {
  if (typeof supabase.rpc === 'function') {
    const result = await supabase.rpc('claim_reception_call', { entry_id: entry.id, selected_broker: broker.id, split, called_at_time: at, standard });
    if (result.error) throw new Error(result.error.message);
    return Boolean(result.data);
  }
  const result = await supabase.from('queue_entries')
    .update({ queue_status: 'chamando', broker_id: broker.id, attempts: entry.attempts + 1, called_at: at,
      updated_at: at, commission_split: split, applied_rule: split ? 'Transbordo Interempresas (Split)' : undefined })
    .eq('id', entry.id).eq('queue_status', 'aguardando').select('id').maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return false;
  const updated = await supabase.from('visits').update({ status: 'aguardando_chamada' }).eq('id', entry.visit_id);
  if (updated.error) throw new Error(updated.error.message);
  await (standard ? markStandardBrokerInService : markBrokerInService)(broker.id, at);
  return true;
}

export async function dispatchGeneralWaiting(queue: QueueEntry[], brokers: Broker[], clock: ScheduleClock, at: string) {
  const entry = queue.filter(row => row.reception_waiting && row.queue_status === 'aguardando')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  if (!entry) return false;
  const busy = busyReceptionIds(queue);
  const { broker, split } = resolveReceptionDispatch(entry, brokers, clock, busy, () =>
    dispatchBroker(brokers, 'geral', clock.seconds, busy, null, entry.visit?.referred_broker_id ?? null).broker,
  );
  return broker ? claimReceptionCall(entry, broker, split, at, !entry.visit?.referred_broker_id && entry.queue_type === 'geral') : false;
}

export async function savePartnerReception(
  draft: Omit<PartnerIntake, 'manager_status' | 'created_at' | 'client_first_name'>,
  details: { customer_name: string; phone: string; media_channel: string | null; media_channel_detail: string | null },
  created_at: string,
) {
  const name = details.customer_name.trim();
  const phone = normalizePhone(details.phone);
  if (!name || (phone && !completePhone(phone))) throw new Error('Informe o nome e confira o telefone com DDD.');
  const intake = { ...partnerIntake({ ...draft, client_first_name: firstName(name) }), created_at };
  const customer = { ...details, customer_name: name, phone: phone || null };
  await dbReady;
  if (typeof supabase.rpc === 'function') {
    const result = await supabase.rpc('record_partner_reception', { intake, customer });
    if (result.error) throw new Error(result.error.message);
    return;
  }
  const result = await supabase.from('external_partner_intakes').insert(intake);
  if (result.error) throw new Error(result.error.message);
  const privateDetails = await supabase.from('partner_reception_details').insert({ intake_id: intake.id, ...customer });
  if (privateDetails.error) throw new Error(privateDetails.error.message);
}
