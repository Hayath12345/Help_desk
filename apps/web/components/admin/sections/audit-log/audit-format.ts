// Pure helpers of the audit-log viewer (E17): the date filters as API instants and the changed
// fields of an entry, ready to render side by side.

import type { AuditLogEntryDto } from '@loons/shared';
import { DISPLAY_TIME_ZONE } from '@/lib/format';

/** The UTC offset of `timeZone` at `instant`, in minutes (e.g. +180 for Asia/Qatar). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The zone the viewer uses: the configured business time zone (General settings, E11) when this
 * browser knows it, else the app's display zone (also while the settings load).
 */
export function auditTimeZone(configured: string | null | undefined): string {
  if (!configured) return DISPLAY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
    return configured;
  } catch {
    return DISPLAY_TIME_ZONE;
  }
}

/** Midnight at the start of `day` (YYYY-MM-DD) in `timeZone`, as an ISO instant; null if invalid. */
export function startOfDay(day: string, timeZone: string = DISPLAY_TIME_ZONE): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const utcMidnight = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(utcMidnight)) return null;
  const offset = offsetMinutes(new Date(utcMidnight), timeZone);
  return new Date(utcMidnight - offset * 60_000).toISOString();
}

/** The exclusive upper bound for "up to and including `day`": the next day's midnight. */
export function endOfDayExclusive(
  day: string,
  timeZone: string = DISPLAY_TIME_ZONE,
): string | null {
  if (!startOfDay(day, timeZone)) return null;
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  return startOfDay(nextDay, timeZone);
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** Present on that side (a CREATE has no before, a DELETE no after). */
  hasBefore: boolean;
  hasAfter: boolean;
}

/** Every field of `before` / `after`, in the order the entry lists them (after first). */
export function fieldChanges(entry: Pick<AuditLogEntryDto, 'before' | 'after'>): FieldChange[] {
  const before = entry.before ?? {};
  const after = entry.after ?? {};
  const fields = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  return fields.map((field) => ({
    field,
    before: before[field],
    after: after[field],
    hasBefore: Object.hasOwn(before, field),
    hasAfter: Object.hasOwn(after, field),
  }));
}
