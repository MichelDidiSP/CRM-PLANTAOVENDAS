// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '@/App';
import { publishClock } from '@/lib/plantaoClock';

it('fixa somente aviso e controles de tempo do TESTE no topo, com fundo opaco e sem sobreposição do cabeçalho', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2040-01-23T11:30:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); publishClock();
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  async function settle(work: () => void) {
    await act(async () => { work(); for (let i = 0; i < 300; i++) await Promise.resolve(); });
  }
  const toggle = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'TESTE')!;
  try {
    await settle(() => root.render(<App />));
    expect(container.querySelector('header')!.classList.contains('sticky')).toBe(true);
    await settle(() => toggle().click());
    const panel = container.querySelector('#test-module')!;
    const bar = panel.querySelector('[aria-label="Controles de tempo do TESTE"]')!;
    for (const name of ['sticky', 'top-0', 'z-40', 'bg-slate-900', 'space-y-4']) expect(bar.classList.contains(name)).toBe(true);
    expect(bar.textContent).toContain('Modo TESTE ativo');
    expect(bar.querySelector('input[type="time"]')).not.toBeNull();
    expect(bar.querySelector('input[type="date"]')).not.toBeNull();
    expect([...bar.querySelectorAll('button')].map(button => button.textContent)).toEqual([
      '+1 min', 'Pular para a Tarde', 'Chamadas: 2 minutos', 'Reiniciar Plantão',
    ]);
    const quick = [...panel.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Simular Entrada Rápida')!;
    const clients = panel.querySelector('[aria-label="Clientes Inseridos no Teste"]')!;
    expect(quick).toBeDefined(); expect(clients).not.toBeNull();
    expect(bar.contains(quick)).toBe(false); expect(bar.contains(clients)).toBe(false);
    expect(panel.classList.contains('sticky')).toBe(false);
    expect(container.querySelector('header')!.classList.contains('sticky')).toBe(false);
    await settle(() => toggle().click());
    expect(container.querySelector('[aria-label="Controles de tempo do TESTE"]')).toBeNull();
    expect(container.querySelector('header')!.classList.contains('sticky')).toBe(true);
  } finally {
    await settle(() => root.unmount()); container.remove(); localStorage.clear();
    vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
