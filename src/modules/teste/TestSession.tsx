import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { createVirtualClock } from './virtualClock';

const enabledKey = 'plantao_test_enabled';
function storedEnabled() {
  try { return localStorage.getItem(enabledKey) === 'true'; } catch { return false; }
}
type Session = { enabled: boolean; toggle: () => void; clock: ReturnType<typeof createVirtualClock> };
const TestSessionContext = createContext<Session | null>(null);
export const useTestSession = () => useContext(TestSessionContext);

/** Restore TESTE before the application can load a day or run its scheduler.
 * Removing this module leaves the real clock native.
 */
export default function TestSession({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(storedEnabled);
  const [clock] = useState(createVirtualClock);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const stop = enabled ? clock.start() : undefined;
    setReady(true);
    // Cleanup releases this mounted source, never the persisted user choice.
    return stop;
  }, [enabled, clock]);
  function toggle() {
    const next = !enabled;
    try { localStorage.setItem(enabledKey, String(next)); } catch { /* session still works without storage */ }
    setEnabled(next);
  }
  return <TestSessionContext.Provider value={{ enabled, toggle, clock }}>{ready && children}</TestSessionContext.Provider>;
}
