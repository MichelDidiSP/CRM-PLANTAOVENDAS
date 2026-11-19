import type { Broker, QueueEntry } from '../supabase';
import { attendanceTrace } from './intake';

/** Presentation only: historical records and the installed RPC keep their schema. */
export function commissionLabel(value: string): string {
  return value.replace(/\bSplit\b/gi, 'Fifty');
}
export function attendanceLabel(entry: QueueEntry | undefined, brokers: Broker[]): string {
  return commissionLabel(attendanceTrace(entry, brokers));
}
