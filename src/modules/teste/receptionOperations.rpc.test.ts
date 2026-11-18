import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase', async () => {
  const { createMockClient } = await import('@/lib/mockClient');
  return { dbReady: Promise.resolve(true), supabase: { ...createMockClient(), rpc } };
});
import { supabase } from '@/lib/supabase';
import { dispatchOperationalEntry, readReceptionPolicy, synchronizeReceptionTrace } from '@/lib/reception/operationalStore';
import { fetchAll } from '@/lib/queueEngine';
import { person, customer, waiting, receptionClock as clock, receptionAt as at } from './receptionFixtures';

beforeEach(async () => {
  rpc.mockReset();
  for (const table of ['brokers', 'visits', 'queue_entries', 'plantao_sessions']) await supabase.from(table).delete().neq('id', '');
  await supabase.from('brokers').insert([person('Didi', { presence_status: 'ausente' }), person('Mussum', { sorteio_order: 2 })]);
  await supabase.from('visits').insert(customer());
  const { visit: _, ...entry } = waiting(); await supabase.from('queue_entries').insert(entry);
  rpc.mockImplementation(async (name, args) => {
    expect(name).toBe('claim_reception_call');
    // Reproduce the existing SQL restriction: split=true is rejected within the same company.
    if (args.split) return { data: false, error: null };
    const result = await supabase.from('queue_entries').update({ queue_status: 'chamando', broker_id: args.selected_broker,
      called_at: args.called_at_time, attempts: 1, commission_split: false })
      .eq('id', args.entry_id).eq('queue_status', 'aguardando').select('id').maybeSingle();
    if (result.data) await supabase.from('brokers').update({ attendance_status: 'em_mesa' }).eq('id', args.selected_broker);
    return { data: Boolean(result.data), error: null };
  });
});
describe('compatibilidade com a RPC instalada, sem migração SQL', () => {
  it('reserva via RPC existente e persiste Split dentro da equipe sem rotular como outra imobiliária', async () => {
    const live = await fetchAll();
    expect(await dispatchOperationalEntry(live.queue[0], live.brokers, live.queue, clock, at)).toBe(true);
    expect(rpc).toHaveBeenCalledWith('claim_reception_call', expect.objectContaining({ selected_broker: 'Mussum', split: false }));
    expect((await fetchAll()).queue[0]).toMatchObject({ broker_id: 'Mussum', commission_split: true, applied_rule: 'Último da Equipe (Split)',
      original_broker_name: 'Didi', attending_broker_name: 'Mussum' });
  });
  it('não publica trace de atendimento quando a RPC perde a disputa pela chamada', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const live = await fetchAll();
    expect(await dispatchOperationalEntry(live.queue[0], live.brokers, live.queue, clock, at)).toBe(false);
    expect((await fetchAll()).queue[0]).toMatchObject({ broker_id: null, queue_status: 'aguardando' });
  });
  it('recupera o Split após falha de rede entre reserva e metadados, sem chamar outra vez', async () => {
    const live = await fetchAll(); await dispatchOperationalEntry(live.queue[0], live.brokers, live.queue, clock, at);
    // Persisted state if the network dropped right after the atomic RPC committed.
    await supabase.from('queue_entries').update({ commission_split: false, applied_rule: 'Último da Equipe' }).eq('id', 'queue');
    const fresh = await fetchAll();
    const entry = { ...fresh.queue[0], reception_policy: await readReceptionPolicy('queue') };
    await synchronizeReceptionTrace(entry, fresh.brokers);
    await synchronizeReceptionTrace(entry, fresh.brokers);
    expect((await fetchAll()).queue[0]).toMatchObject({ commission_split: true, applied_rule: 'Último da Equipe (Split)' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
