// Small pure helpers shared by the seed data files and the seed script (no database access).

export const MINUTE_MS = 60_000;

/** "Security alert / suspected incident" → "security-alert-suspected-incident". */
export function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A calendar date as stored in `@db.Date` columns (UTC midnight). `month` is 1-based. */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** ISO `YYYY-MM-DD` for a UTC-midnight date. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Adds whole calendar days to a UTC-midnight date. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * MINUTE_MS);
}

/**
 * The n-th given weekday of a month (UTC). `weekday` uses JS numbering (0 = Sunday … 6 = Saturday),
 * `month` is 1-based. Example: nthWeekdayOfMonth(2026, 2, 2, 2) → 2nd Tuesday of February 2026.
 */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = utcDate(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, month, 1 + offset + (n - 1) * 7);
}
