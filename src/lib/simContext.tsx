import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Shift } from './supabase';

// Shift windows (seconds since midnight)
const MANHA_START = 8 * 3600;          // 08:00:00 — check-in opens
const MANHA_CHECKIN_LIMIT = 8 * 3600 + 45 * 60 + 59; // 08:45:59
const MANHA_SORTEIO = 8 * 3600 + 46 * 60;           // 08:46:00
const MANHA_ATEND_START = 9 * 3600;    // 09:00:00
const MANHA_ATEND_END = 14 * 3600;     // 14:00:00 — fila da manhã extinta

const TARDE_CHECKIN_OPEN = 13 * 3600;       // 13:00:00
const TARDE_CHECKIN_LIMIT = 13 * 3600 + 45 * 60 + 59; // 13:45:59
const TARDE_SORTEIO = 13 * 3600 + 46 * 60;  // 13:46:00
const TARDE_ATEND_START = 14 * 3600;       // 14:00:00
const TARDE_ATEND_END = 19 * 3600;         // 19:00:00

const DEFAULT_START_SECONDS = 8 * 3600 + 30 * 60; // 08:30:00

export const SHIFT_BOUNDARIES = {
  manha: { checkinOpen: MANHA_START, checkinLimit: MANHA_CHECKIN_LIMIT, sorteio: MANHA_SORTEIO, atendStart: MANHA_ATEND_START, atendEnd: MANHA_ATEND_END },
  tarde: { checkinOpen: TARDE_CHECKIN_OPEN, checkinLimit: TARDE_CHECKIN_LIMIT, sorteio: TARDE_SORTEIO, atendStart: TARDE_ATEND_START, atendEnd: TARDE_ATEND_END },
};

type SimContextType = {
  simSeconds: number;
  clockDisplay: string;
  setStartTime: (time: string) => void;
  addMinute: () => void;
  jumpToAfternoon: () => void;
  testMode: boolean;
  setTestMode: (on: boolean) => void;
  getCurrentTime: () => Date;
  callDuration: number;
  sorteioTriggered: boolean;
  resetClock: () => void;
  currentShift: Shift;
  isWeekday: boolean;
  plantaoDate: string;
  setPlantaoDate: (date: string) => void;
  isPreSorteio: boolean;
  isCheckinOpen: boolean;
  isAtendimentoActive: boolean;
  isShiftTransition: boolean;
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
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function isWeekendDate(dateStr: string): boolean {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  return day === 0 || day === 6;
}

function determineShift(seconds: number): Shift {
  if (seconds >= TARDE_ATEND_START || seconds >= TARDE_CHECKIN_OPEN) return 'tarde';
  return 'manha';
}

export function SimProvider({ children }: { children: ReactNode }) {
  const [simSeconds, setSimSeconds] = useState(DEFAULT_START_SECONDS);
  const [testMode, setTestMode] = useState(false);
  const [sorteioTriggered, setSorteioTriggered] = useState(false);
  const [plantaoDate, setPlantaoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const sorteioFiredRef = useRef(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSimSeconds((s) => (s + 1) % 86400);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const currentShift = determineShift(simSeconds);
  const boundaries = SHIFT_BOUNDARIES[currentShift];
  const sorteioThreshold = boundaries.sorteio;

  useEffect(() => {
    if (!sorteioFiredRef.current && simSeconds >= sorteioThreshold) {
      sorteioFiredRef.current = true;
      setSorteioTriggered(true);
    }
  }, [simSeconds, sorteioThreshold]);

  const setStartTime = useCallback((time: string) => {
    const parsed = parseTimeInput(time);
    if (parsed !== null) {
      const shift = determineShift(parsed);
      const threshold = SHIFT_BOUNDARIES[shift].sorteio;
      sorteioFiredRef.current = parsed >= threshold;
      setSorteioTriggered(parsed >= threshold);
      setSimSeconds(parsed);
    }
  }, []);

  const addMinute = useCallback(() => {
    setSimSeconds((s) => (s + 60) % 86400);
  }, []);

  const jumpToAfternoon = useCallback(() => {
    const afternoonStart = 13 * 3600 + 40 * 60; // 13:40:00
    sorteioFiredRef.current = afternoonStart >= TARDE_SORTEIO;
    setSorteioTriggered(afternoonStart >= TARDE_SORTEIO);
    setSimSeconds(afternoonStart);
  }, []);

  const getCurrentTime = useCallback((): Date => {
    const d = new Date();
    const h = Math.floor(simSeconds / 3600) % 24;
    const m = Math.floor(simSeconds / 60) % 60;
    const s = simSeconds % 60;
    d.setHours(h, m, s, 0);
    return d;
  }, [simSeconds]);

  const resetClock = useCallback(() => {
    sorteioFiredRef.current = false;
    setSorteioTriggered(false);
    setSimSeconds(DEFAULT_START_SECONDS);
  }, []);

  const callDuration = testMode ? 10 : 120;
  const clockDisplay = secondsToClock(simSeconds);
  const weekday = !isWeekendDate(plantaoDate);

  const isPreSorteio = simSeconds < boundaries.sorteio && simSeconds >= boundaries.checkinOpen;
  const isCheckinOpen = simSeconds >= boundaries.checkinOpen && simSeconds <= boundaries.checkinLimit;
  const isAtendimentoActive = simSeconds >= boundaries.atendStart && simSeconds < boundaries.atendEnd;
  const isShiftTransition = simSeconds >= MANHA_ATEND_END && simSeconds < MANHA_ATEND_END + 60;

  return (
    <SimContext.Provider
      value={{
        simSeconds,
        clockDisplay,
        setStartTime,
        addMinute,
        jumpToAfternoon,
        testMode,
        setTestMode,
        getCurrentTime,
        callDuration,
        sorteioTriggered,
        resetClock,
        currentShift,
        isWeekday: weekday,
        plantaoDate,
        setPlantaoDate,
        isPreSorteio,
        isCheckinOpen,
        isAtendimentoActive,
        isShiftTransition,
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
