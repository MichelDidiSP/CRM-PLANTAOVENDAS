import { dbReady, supabase } from '../supabase';
import { getPlantaoTime, plantaoClockParts } from '../plantaoClock';
import { closePlantao, type ClosingSummary } from '../reports/officialClosing';
import { automaticClosingDue, publishDayExtension } from './dayExtension';

const settingId = (date: string) => `operation_${date}`;
function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
export async function loadDayExtension(date: string) {
  await dbReady;
  const result = await supabase.from('plantao_sessions').select('schedule_data').eq('id', settingId(date)).maybeSingle();
  check(result.error);
  const enabled = result.data?.schedule_data?.kind === 'operation_day_v1' && result.data.schedule_data.cashSigning === true;
  publishDayExtension(date, enabled); return enabled;
}
export async function setDayExtension(date: string, enabled: boolean) {
  await dbReady;
  const at = getPlantaoTime().toISOString();
  if (typeof supabase.rpc === 'function') {
    const result = await supabase.rpc('set_plantao_day_extension', { day: date, enabled, at_time: at }); check(result.error);
  } else {
    const previous = await supabase.from('plantao_sessions').select('id').eq('id', settingId(date)).maybeSingle(); check(previous.error);
    const data = { kind: 'operation_day_v1', cashSigning: enabled };
    const result = previous.data
      ? await supabase.from('plantao_sessions').update({ schedule_data: data }).eq('id', settingId(date))
      : await supabase.from('plantao_sessions').insert({ id: settingId(date), plantao_date: date, status: 'ended',
        started_at: at, ended_at: at, schedule_data: data });
    check(result.error);
  }
  publishDayExtension(date, enabled);
}
export async function closeAt21(date: string, closed: boolean): Promise<ClosingSummary | null> {
  const at = getPlantaoTime();
  if (plantaoClockParts(at).plantaoDate !== date || closed) return null;
  const extended = await loadDayExtension(date);
  if (!automaticClosingDue(plantaoClockParts(at).simSeconds, closed, extended)) return null;
  if (typeof supabase.rpc === 'function') {
    // The transaction checks the switch again under the same lock as manual closing.
    const result = await supabase.rpc('close_plantao_automatically', { day: date, at_time: at.toISOString() });
    check(result.error); return result.data as ClosingSummary | null;
  }
  return closePlantao(date, 'fechamento_automatico_21h');
}
