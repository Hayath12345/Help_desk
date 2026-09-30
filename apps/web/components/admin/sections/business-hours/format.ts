// Date labels of the business-hours section (Intl, the UI language; Latin digits in Arabic).

import type { Locale } from '@loons/shared';
import { intlLocale } from '@/lib/format';

/** "Sunday" … "Saturday" in the UI language (2023-01-01 was a Sunday). */
export function weekdayName(weekday: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2023, 0, 1 + weekday)),
  );
}

/** "Thu, Dec 18, 2026" for a holiday's calendar date (a date, not an instant: UTC). */
export function holidayDateLabel(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
