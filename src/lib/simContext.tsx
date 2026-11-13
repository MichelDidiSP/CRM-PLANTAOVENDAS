import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useLayoutEffect } from 'react';
import { scheduleAt, setScheduleClock, SHIFT_TIMES } from './queue/shiftSchedule';
import type { Shift } from './supabase';

// Shift windows (seconds since midnight)
const MANHA_START = 8 * 3600;          // 08:00:00 — check-in opens
const MANHA_CHECKIN_LIMIT = 8 * 3600 + 45 * 60 + 59; // 08:45:59
const MANHA_SORTEIO = 8 * 3600 + 46 * 60;           // 08:46:00
const MANHA_ATEND_START = 9 * 3600;    // 09:00:00
const MANHA_ATEND_END = 14 * 3600 + 1;     // 14:00:00 — fila da manhã extinta

const TARDE_CHECKIN_OPEN = 13 * 3600;       // 13:00:00
const TARDE_CHECKIN_LIMIT = 13 * 3600 + 45 * 60 + 59; // 13:45:59
const TARDE_SORTEIO = 13 * 3600 + 46 * 60;  // 13:46:00
const TARDE_ATEND_START = 14 * 3600 + 1;       // 14:00:00
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
  isManhaSorteioActive: boolean;
  isAfternoonActive: boolean;
  isMorningQueueActive: boolean;
  isHoliday: boolean;
  setIsHoliday: (on: boolean) => void;
  isExtendedShift: boolean;
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

const STORAGE_KEY = 'plantao_sim_seconds';
const TESTMODE_KEY = 'plantao_test_mode';
const HOLIDAY_KEY = 'crm_is_holiday';

export function SimProvider({ children }: { children: ReactNode }) {
  const [simSeconds, setSimSeconds] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed < 86400) return parsed;
      }
    } catch { /* localStorage not available */ }
    return DEFAULT_START_SECONDS;
  });
  const [testMode, setTestMode] = useState(() => {
    try { return localStorage.getItem(TESTMODE_KEY) === 'true'; } catch { return false; }
  });
  const [isHoliday, setIsHoliday] = useState(() => {
    try { return localStorage.getItem(HOLIDAY_KEY) === 'true'; } catch { return false; }
  });
  const [plantaoDate, setPlantaoDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSimSeconds((s) => {
        const next = (s + 1) % 86400;
        try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const isExtendedShift = isHoliday;
  const schedule = scheduleAt({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate });
  useLayoutEffect(() => {
    setScheduleClock({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate });
    return () => setScheduleClock(undefined);
  }, [simSeconds, isExtendedShift, plantaoDate]);
  const currentShift: Shift = schedule.shift;
  const sorteioTriggered = schedule.morningDrawDue;

  const setStartTime = useCallback((time: string) => {
    const parsed = parseTimeInput(time);
    if (parsed !== null) {
      setSimSeconds(parsed);
      try { localStorage.setItem(STORAGE_KEY, String(parsed)); } catch { /* ignore */ }
    }
  }, []);

  const addMinute = useCallback(() => {
    setSimSeconds((s) => {
      const next = (s + 60) % 86400;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const jumpToAfternoon = useCallback(() => {
    const afternoonStart = 13 * 3600 + 40 * 60; // 13:40:00
    setSimSeconds(afternoonStart);
    try { localStorage.setItem(STORAGE_KEY, String(afternoonStart)); } catch { /* ignore */ }
  }, []);

  const getCurrentTime = useCallback((): Date => {
    const d = new Date(plantaoDate + 'T00:00:00');
    const h = Math.floor(simSeconds / 3600) % 24;
    const m = Math.floor(simSeconds / 60) % 60;
    const s = simSeconds % 60;
    d.setHours(h, m, s, 0);
    return d;
  }, [simSeconds, plantaoDate]);

  const resetClock = useCallback(() => {
    setSimSeconds(DEFAULT_START_SECONDS);
    try { localStorage.setItem(STORAGE_KEY, String(DEFAULT_START_SECONDS)); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(TESTMODE_KEY, String(testMode)); } catch { /* ignore */ }
  }, [testMode]);

  useEffect(() => {
    try { localStorage.setItem(HOLIDAY_KEY, String(isHoliday)); } catch { /* ignore */ }
  }, [isHoliday]);

  const callDuration = testMode ? 10 : 120;
  const clockDisplay = secondsToClock(simSeconds);

  const isPreSorteio = schedule.preOpening;
  const isCheckinOpen = (simSeconds >= SHIFT_TIMES.open && simSeconds < SHIFT_TIMES.morningDraw) || schedule.afternoonEnrollment;
  const isAtendimentoActive = schedule.acceptingClients;
  const isShiftTransition = schedule.afternoonActive;
  const manhaSorteioActive = schedule.morningDrawDue && !schedule.afternoonActive;
  const afternoonActive = schedule.afternoonActive;
  const morningQueueActive = !schedule.afternoonActive;

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
        isWeekday: !isExtendedShift,
        plantaoDate,
        setPlantaoDate,
        isPreSorteio,
        isCheckinOpen,
        isAtendimentoActive,
        isShiftTransition,
        isManhaSorteioActive: manhaSorteioActive,
        isAfternoonActive: afternoonActive,
        isMorningQueueActive: morningQueueActive,
        isHoliday,
        setIsHoliday,
        isExtendedShift,
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
