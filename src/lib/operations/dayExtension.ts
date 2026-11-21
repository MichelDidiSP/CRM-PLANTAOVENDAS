import type { ScheduleClock } from '../queue/shiftSchedule';

const days = new Map<string, boolean>();
const listeners = new Set<() => void>();
export const isDayExtended = (date: string) => days.get(date) === true;
export const subscribeDayExtension = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function publishDayExtension(date: string, enabled: boolean) {
  if (isDayExtended(date) === enabled) return;
  days.set(date, enabled); listeners.forEach(listener => listener());
}
/** Keep the last open dispatch window. Actual timestamps/timers never use this projection. */
export function dispatchClock(clock: ScheduleClock, extended = isDayExtended(clock.date)): ScheduleClock {
  return extended && clock.seconds >= 21 * 3600 ? { ...clock, seconds: 21 * 3600 - 1 } : clock;
}
export function automaticClosingDue(seconds: number, closed: boolean, extended: boolean) {
  return seconds >= 21 * 3600 && !closed && !extended;
}
