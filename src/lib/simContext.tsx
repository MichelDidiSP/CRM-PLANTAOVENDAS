import { createContext, useContext, useState, useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { scheduleAt, setScheduleClock, SHIFT_TIMES } from './queue/shiftSchedule';
import { clockSnapshot, getPlantaoTime, plantaoClockParts, publishClock, subscribeClock } from './plantaoClock';
import { dispatchClock, isDayExtended, subscribeDayExtension } from './operations/dayExtension';

/** Read-only operational view of the clock, shared by every panel and engine adapter. */
function useOperationalClock() {
  const { timestamp, callDuration } = useSyncExternalStore(subscribeClock, clockSnapshot);
  const { simSeconds, clockDisplay, plantaoDate } = plantaoClockParts(new Date(timestamp));
  const [isHoliday, setIsHoliday] = useState(() => {
    try { return localStorage.getItem('crm_is_holiday') === 'true'; } catch { return false; }
  });
  useEffect(() => {
    publishClock();
    const timer = window.setInterval(publishClock, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { try { localStorage.setItem('crm_is_holiday', String(isHoliday)); } catch { /* no storage */ } }, [isHoliday]);
  const isExtendedShift = isHoliday;
  const cashSigning = useSyncExternalStore(subscribeDayExtension, () => isDayExtended(plantaoDate));
  const operationSeconds = dispatchClock({ seconds: simSeconds, singleShift: isExtendedShift, date: plantaoDate }, cashSigning).seconds;
  const schedule = scheduleAt({ seconds: operationSeconds, singleShift: isExtendedShift, date: plantaoDate });
  useLayoutEffect(() => {
    setScheduleClock({ seconds: operationSeconds, singleShift: isExtendedShift, date: plantaoDate });
    return () => setScheduleClock(undefined);
  }, [operationSeconds, isExtendedShift, plantaoDate]);
  return {
    simSeconds, operationSeconds, cashSigning, clockDisplay, plantaoDate, getCurrentTime: getPlantaoTime, callDuration,
    testMode: callDuration === 10, currentShift: schedule.shift, sorteioTriggered: schedule.morningDrawDue,
    isWeekday: !isExtendedShift, isHoliday, setIsHoliday, isExtendedShift,
    isPreSorteio: schedule.preOpening,
    isCheckinOpen: (simSeconds >= SHIFT_TIMES.open && simSeconds < SHIFT_TIMES.morningDraw) || schedule.afternoonEnrollment,
    isAtendimentoActive: schedule.acceptingClients, isShiftTransition: schedule.afternoonActive,
    isManhaSorteioActive: schedule.morningDrawDue && !schedule.afternoonActive,
    isAfternoonActive: schedule.afternoonActive, isMorningQueueActive: !schedule.afternoonActive,
  };
}
const SimContext = createContext<ReturnType<typeof useOperationalClock> | null>(null);
export function SimProvider({ children }: { children: ReactNode }) {
  const clock = useOperationalClock();
  return <SimContext.Provider value={clock}>{children}</SimContext.Provider>;
}
export function useSim() {
  const context = useContext(SimContext);
  if (!context) throw new Error('useSim deve ser usado dentro de SimProvider');
  return context;
}
