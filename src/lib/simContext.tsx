import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';

const SORTED_TRIGGER_SECONDS = 8 * 3600 + 46 * 60; // 08:46:00
const DEFAULT_START_SECONDS = 8 * 3600 + 30 * 60;  // 08:30:00

type SimContextType = {
  /** Segundos desde meia-noite do relógio simulado */
  simSeconds: number;
  /** Hora formatada HH:MM:SS */
  clockDisplay: string;
  /** Define a hora inicial manualmente (formato "HH:MM" ou "HH:MM:SS") */
  setStartTime: (time: string) => void;
  /** Avança 1 minuto no relógio */
  addMinute: () => void;
  testMode: boolean;
  setTestMode: (on: boolean) => void;
  /** Retorna a hora actual simulada como Date */
  getCurrentTime: () => Date;
  /** Duração da chamada em segundos (10s em teste, 120s normal) */
  callDuration: number;
  /** True quando o relógio cruzou 08:46:00 e o sorteio foi executado */
  sorteioTriggered: boolean;
};

const SimContext = createContext<SimContextType | null>(null);

function secondsToClock(total: number): string {
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = Math.floor(total) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseTimeInput(input: string): number | null {
  const parts = input.split(':').map(Number);
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
    return parts[0] * 3600 + parts[1] * 60;
  }
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

export function SimProvider({ children }: { children: ReactNode }) {
  const [simSeconds, setSimSeconds] = useState(DEFAULT_START_SECONDS);
  const [testMode, setTestMode] = useState(false);
  const [sorteioTriggered, setSorteioTriggered] = useState(false);
  const sorteioFiredRef = useRef(false);

  // Motor do relógio: avança 1 segundo por segundo em tempo real
  useEffect(() => {
    const interval = window.setInterval(() => {
      setSimSeconds((s) => (s + 1) % 86400);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Gatilho do sorteio: dispara uma vez quando o relógio atinge 08:46:00
  useEffect(() => {
    if (!sorteioFiredRef.current && simSeconds >= SORTED_TRIGGER_SECONDS) {
      sorteioFiredRef.current = true;
      setSorteioTriggered(true);
    }
  }, [simSeconds]);

  const setStartTime = useCallback((time: string) => {
    const parsed = parseTimeInput(time);
    if (parsed !== null) {
      sorteioFiredRef.current = parsed >= SORTED_TRIGGER_SECONDS;
      setSorteioTriggered(parsed >= SORTED_TRIGGER_SECONDS);
      setSimSeconds(parsed);
    }
  }, []);

  const addMinute = useCallback(() => {
    setSimSeconds((s) => (s + 60) % 86400);
  }, []);

  const getCurrentTime = useCallback((): Date => {
    const d = new Date();
    const h = Math.floor(simSeconds / 3600) % 24;
    const m = Math.floor(simSeconds / 60) % 60;
    const s = simSeconds % 60;
    d.setHours(h, m, s, 0);
    return d;
  }, [simSeconds]);

  const callDuration = testMode ? 10 : 120;
  const clockDisplay = secondsToClock(simSeconds);

  return (
    <SimContext.Provider
      value={{
        simSeconds,
        clockDisplay,
        setStartTime,
        addMinute,
        testMode,
        setTestMode,
        getCurrentTime,
        callDuration,
        sorteioTriggered,
      }}
    >
      {children}
    </SimContext.Provider>
  );
}

export function useSim(): SimContextType {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error('useSim deve ser usado dentro de SimProvider');
  return ctx;
}
