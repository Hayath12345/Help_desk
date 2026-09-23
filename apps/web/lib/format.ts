// Locale-aware display formatting shared by server and client components (no server-only imports).
//
// Numbers use Latin digits in Arabic too (`-u-nu-latn`), matching the design, where ticket IDs,
// counts and SLA timers stay in Latin digits inside Arabic copy.

import { formatTicketNumber, type Locale } from '@loons/shared';

export { formatTicketNumber };

/** Business timezone for Loons Group (Qatar). */
export const DISPLAY_TIME_ZONE = 'Asia/Qatar';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** BCP-47 tag used with Intl for an app locale. */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-QA-u-nu-latn' : 'en-US';
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 12345 → "12,345" */
export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

/** Absolute timestamp like the design's thread stamps: "Sep 23, 14:05" / "23 سبتمبر، 14:05". */
export function formatDateTime(
  value: Date | string | number,
  locale: Locale,
  timeZone: string = DISPLAY_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(toDate(value));
}

/** Calendar date: "Sep 23, 2026". */
export function formatDate(
  value: Date | string | number,
  locale: Locale,
  timeZone: string = DISPLAY_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(toDate(value));
}

/**
 * Compact relative time for list rows ("now", "5m ago", "3h ago", "2d ago").
 * Pass `now` from a shared clock so every row on screen agrees.
 */
export function formatRelativeTime(
  value: Date | string | number,
  locale: Locale,
  now: number = Date.now(),
): string {
  const diff = toDate(value).getTime() - now; // negative = past
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { style: 'narrow', numeric: 'auto' });
  if (abs < MINUTE) return rtf.format(0, 'second');
  if (abs < HOUR) return rtf.format(Math.trunc(diff / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.trunc(diff / HOUR), 'hour');
  return rtf.format(Math.trunc(diff / DAY), 'day');
}

/**
 * SLA-style duration: "45m", "1h 05m", "3h", "2d" (the design's `dur`), with localized narrow units.
 * Negative durations are treated as zero; callers render "Overdue" themselves.
 */
export function formatDuration(ms: number, locale: Locale): string {
  const tag = intlLocale(locale);
  const unit = (unitName: 'minute' | 'hour' | 'day', value: number, pad = false) =>
    new Intl.NumberFormat(tag, {
      style: 'unit',
      unit: unitName,
      unitDisplay: 'narrow',
      minimumIntegerDigits: pad ? 2 : 1,
    }).format(value);

  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return unit('minute', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return unit('day', Math.floor(hours / 24));
  const rest = minutes % 60;
  return rest ? `${unit('hour', hours)} ${unit('minute', rest, true)}` : unit('hour', hours);
}

const HONORIFIC = /^(?:dr|capt|eng|mr|mrs|ms|prof)\.?\s+/i;

/** "Dr. Aisha Al-Kuwari" → "Aisha" (used in greetings such as "Hi Aisha — …"). */
export function firstNameOf(name: string): string {
  const cleaned = name.trim().replace(HONORIFIC, '');
  return cleaned.split(/\s+/)[0] ?? cleaned;
}

/**
 * Client-safe initials ("Maya Ruiz" → "MR"). Server code can use `initialsOf` from
 * `@/lib/session`; this copy exists because that module is server-only.
 */
export function initialsFrom(name: string): string {
  return name
    .trim()
    .replace(HONORIFIC, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
