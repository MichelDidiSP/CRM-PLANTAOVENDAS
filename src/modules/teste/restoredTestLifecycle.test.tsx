// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '@/App';
import { isVirtualClockActive, publishClock } from '@/lib/plantaoClock';

it('usa o ciclo original da PR 13 e não registra eventos de foco/visibilidade nem reativa o estado legado da PR 14', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-23T10:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); localStorage.setItem('plantao_test_enabled', 'true');
  localStorage.setItem('plantao_test_timestamp', String(Date.parse('2040-01-23T11:30:00Z')));
  publishClock();
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  async function settle(work: () => void) {
    await act(async () => { work(); for (let i = 0; i < 300; i++) await Promise.resolve(); });
  }
  try {
    await settle(() => root.render(<App />));
    expect(container.querySelector('#test-module')).toBeNull(); expect(isVirtualClockActive()).toBe(false);
    expect(container.querySelector('output')?.textContent).toBe('07:00:00');
    await settle(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'TESTE')!.click());
    expect(container.querySelector('#test-module')).not.toBeNull(); expect(isVirtualClockActive()).toBe(true);
    expect(container.querySelector('output')?.textContent).toBe('08:30:00');
    for (const event of ['focus', 'visibilitychange', 'pagehide']) {
      expect([...onWindow.mock.calls, ...onDocument.mock.calls].some(([name]) => name === event)).toBe(false);
    }
  } finally {
    await settle(() => root.unmount()); container.remove(); localStorage.clear();
    vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
