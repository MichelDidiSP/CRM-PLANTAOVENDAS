// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '@/App';
import { publishClock } from '@/lib/plantaoClock';

it('deixa a barra do TESTE limitada pela página inteira, sem uma caixa curta entre ela e o conteúdo operacional', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-23T11:30:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock();
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  async function settle(work: () => void) {
    await act(async () => { work(); for (let i = 0; i < 300; i++) await Promise.resolve(); });
  }
  try {
    await settle(() => root.render(<App />));
    await settle(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'TESTE')!.click());
    const bar = container.querySelector('[aria-label="Controles de tempo do TESTE"]')!;
    let box = bar.parentElement!;
    // display: contents keeps the TESTE DOM/React ownership, while its boxes
    // participate in the page layout. A short boxed ancestor recreates the bug.
    while (box.classList.contains('contents')) box = box.parentElement!;
    expect(box.contains(container.querySelector('main'))).toBe(true);
    expect(box.contains(container.querySelector('footer'))).toBe(true);
    expect(box.classList.contains('min-h-screen')).toBe(true);
    const clients = container.querySelector('[aria-label="Clientes Inseridos no Teste"]')!;
    expect(bar.contains(clients)).toBe(false);
    expect(bar.closest('#test-module')).not.toBeNull();
    await settle(() => [...bar.querySelectorAll('button')].find(b => b.textContent === '+1 min')!.click());
    expect((bar.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('08:31:00');
  } finally {
    await settle(() => root.unmount()); container.remove(); localStorage.clear();
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
