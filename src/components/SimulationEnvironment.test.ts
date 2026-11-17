// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('abre a base local pela barra mesmo quando há credenciais de Supabase configuradas', async () => {
  vi.resetModules();
  window.history.replaceState(null, '', '/?simulacao=1');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test-project.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-public-key');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { supabase, dbReady } = await import('@/lib/supabase');
  expect(await dbReady).toBe(false);
  expect(typeof supabase.rpc).toBe('undefined');
  const result = await supabase.from('brokers').select('*');
  expect(result.data?.length).toBeGreaterThan(0);
  expect(fetch).not.toHaveBeenCalled();
});
