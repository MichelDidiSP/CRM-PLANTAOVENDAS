/** Operational clock. Without an injected source it always reads the real time. */
export type ClockSource = { now: () => number; callDuration?: number };
let source: ClockSource | undefined;
const listeners = new Set<() => void>();
let snapshot = { timestamp: Date.now(), callDuration: 120 };
export function isVirtualClockActive(): boolean { return source !== undefined; }
export function getPlantaoTime(): Date { return new Date(source?.now() ?? Date.now()); }
export function publishClock() {
  snapshot = { timestamp: getPlantaoTime().getTime(), callDuration: source?.callDuration ?? 120 };
  listeners.forEach(listener => listener());
}
export function installPlantaoClock(next: ClockSource) {
  source = next;
  publishClock();
  return () => { if (source === next) { source = undefined; publishClock(); } };
}
export function subscribeClock(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function clockSnapshot() { return snapshot; }
export function plantaoClockParts(at: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  const clockDisplay = `${get('hour')}:${get('minute')}:${get('second')}`;
  return { plantaoDate: `${get('year')}-${get('month')}-${get('day')}`, clockDisplay,
    simSeconds: Number(get('hour')) * 3600 + Number(get('minute')) * 60 + Number(get('second')) };
}
/** Retry delays use the same time source as calls and pauses. */
export function afterPlantaoDelay(callback: () => void | Promise<void>, delay: number) {
  const deadline = getPlantaoTime().getTime() + delay;
  let active = true;
  const cancel = () => { active = false; clearInterval(timer); unsubscribe(); };
  const check = () => { if (active && getPlantaoTime().getTime() >= deadline) { cancel(); void callback(); } };
  const timer = setInterval(check, 100);
  const unsubscribe = subscribeClock(check);
  return cancel;
}
