// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const { configuredClient, createClient } = vi.hoisted(() => {
  const configuredClient = { marker: 'configured', from: vi.fn(() => ({ select: () => ({ limit: async () => ({ data: [{ id: 'original-broker' }], error: null }) }) })) };
  return { configuredClient, createClient: vi.fn(() => configuredClient) };
});
vi.mock('@supabase/supabase-js', () => ({ createClient }));
afterEach(() => { vi.unstubAllEnvs(); window.history.replaceState(null, '', '/'); });
it('o antigo link da PR #7 não troca o cliente configurado nem semeia outros corretores', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/?simulacao=1');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://configured-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key');
  const { supabase, dbReady } = await import('@/lib/supabase');
  expect(await dbReady).toBe(true);
  expect(createClient).toHaveBeenCalledWith('https://configured-project.supabase.co', 'public-test-key', expect.anything());
  expect(supabase.from).toBe(configuredClient.from);
  expect(configuredClient.from).toHaveBeenCalledTimes(1);
  expect(configuredClient.from).toHaveBeenCalledWith('brokers');
});
