import { installPlantaoClock, plantaoClockParts, publishClock, subscribeClock } from '@/lib/plantaoClock';

export function createVirtualClock() {
  let time = Date.now();
  let anchor = Date.now();
  const source = { now: () => time + Date.now() - anchor, callDuration: 120 };
  const set = (timestamp: number) => {
    time = timestamp; anchor = Date.now();
    try { localStorage.setItem('plantao_test_timestamp', String(time)); } catch { /* no storage */ }
    publishClock();
  };
  return {
    start() {
      let stored: string | null = null;
      try { stored = localStorage.getItem('plantao_test_timestamp'); } catch { /* no storage */ }
      const date = plantaoClockParts(new Date()).plantaoDate;
      time = stored && Number.isFinite(Number(stored)) ? Number(stored) : Date.parse(`${date}T08:30:00-03:00`);
      anchor = Date.now();
      const stop = installPlantaoClock(source);
      const persist = () => {
        try { localStorage.setItem('plantao_test_timestamp', String(source.now())); } catch { /* no storage */ }
      };
      const unsubscribe = subscribeClock(persist);
      return () => { persist(); unsubscribe(); stop(); };
    },
    setTime(input: string) {
      if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(input)) return;
      const date = plantaoClockParts(new Date(source.now())).plantaoDate;
      set(Date.parse(`${date}T${input.length === 5 ? input + ':00' : input}-03:00`));
    },
    setDate(date: string) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const clock = plantaoClockParts(new Date(source.now())).clockDisplay;
      const timestamp = Date.parse(`${date}T${clock}-03:00`);
      if (Number.isFinite(timestamp)) set(timestamp);
    },
    addMinute() { set(source.now() + 60000); },
    setFast(on: boolean) { source.callDuration = on ? 10 : 120; publishClock(); },
    reset() {
      const date = plantaoClockParts(new Date(source.now())).plantaoDate;
      set(Date.parse(`${date}T08:30:00-03:00`));
    },
  };
}
