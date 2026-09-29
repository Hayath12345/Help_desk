import type { BusinessCalendar } from '@loons/shared';

// Local dates in the business time zone (AppSetting `business.timezone`, e.g. Asia/Qatar) for the
// P4 digest (decision D9): which day it is there, whether it is a business day (an open weekday
// that is not a holiday), and the instant of a local wall-clock time. Intl only; DST-safe.

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** The local calendar date ("YYYY-MM-DD") of an instant in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (Asia/Qatar: +3 h). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = parts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the local clock in `timeZone` reads `hhmm` on `date`. */
export function zonedInstant(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const match = HH_MM.exec(hhmm);
  if (!match) throw new RangeError(`zonedInstant: "${hhmm}" is not HH:mm`);
  const guess = Date.UTC(y, m - 1, d, Number(match[1]), Number(match[2]));
  const first = offsetMs(new Date(guess), timeZone);
  let instant = guess - first;
  // Across a DST change the offset at the result can differ from the one at the guess.
  const second = offsetMs(new Date(instant), timeZone);
  if (second !== first) instant = guess - second;
  return new Date(instant);
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, like `BusinessCalendar.hours`. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** An open weekday (Qatar: Sunday–Thursday) that is not a holiday. */
export function isBusinessDay(date: string, calendar: BusinessCalendar): boolean {
  return calendar.hours[weekdayOf(date)] != null && !calendar.holidays.includes(date);
}

/** The latest business day before `date` (null when none in the previous 60 days). */
export function previousBusinessDay(date: string, calendar: BusinessCalendar): string | null {
  for (let i = 1; i <= 60; i += 1) {
    const day = addDays(date, -i);
    if (isBusinessDay(day, calendar)) return day;
  }
  return null;
}

/** "HH:mm" when valid, else the fallback. */
export function hhmmOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && HH_MM.test(value.trim()) ? value.trim() : fallback;
}

export interface DigestWindow {
  /** The local date of this digest. */
  date: string;
  /** The previous business day's digest time (inclusive). */
  start: Date;
  /** This digest's time (exclusive). */
  end: Date;
}

/**
 * The P4 digest window for the local day of `now` (D9): from the previous business day's digest
 * time to today's, or null when today is not a business day (weekend, holiday). Tickets created
 * on a Friday, a Saturday or a holiday go into the next business day's digest.
 */
export function digestWindow(
  now: Date,
  calendar: BusinessCalendar,
  digestTime: string,
): DigestWindow | null {
  const date = localDate(now, calendar.timeZone);
  if (!isBusinessDay(date, calendar)) return null;
  const previous = previousBusinessDay(date, calendar) ?? addDays(date, -1);
  return {
    date,
    start: zonedInstant(previous, digestTime, calendar.timeZone),
    end: zonedInstant(date, digestTime, calendar.timeZone),
  };
}
