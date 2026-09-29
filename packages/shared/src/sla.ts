// SLA due-date arithmetic (spec §7): P1/P2 run 24/7, P3/P4 count business hours only
// (configurable per policy), skipping holidays. Pure functions — the API loads the calendar from
// BusinessHours / Holiday / AppSetting "business.timezone" and caches it.
//
// Semantics (binding):
// - Calendar minutes (businessHoursOnly = false): plain wall-clock addition.
// - Business minutes: only time inside an open interval of a non-holiday day counts. A clock
//   started outside business hours starts at the next opening. A due time that lands exactly on a
//   closing time stays there (it does not roll to the next opening).
// - Days, weekdays, opening times and holidays are evaluated in `calendar.timeZone` (IANA); the
//   functions must be correct for zones with DST even though Asia/Qatar has none.
// - Minutes are whole numbers ≥ 0; results are exact to the millisecond of the inputs. Pauses
//   (resumeDueDate, computeDueDates' `pauses`) carry the remaining time to the millisecond.

export interface BusinessDayHours {
  /** "HH:mm" local time. */
  open: string;
  /** "HH:mm" local time, after `open`. */
  close: string;
}

export interface BusinessCalendar {
  /** IANA time zone, e.g. "Asia/Qatar". */
  timeZone: string;
  /** Index 0 = Sunday … 6 = Saturday. `null` = closed all day. */
  hours: readonly (BusinessDayHours | null)[];
  /** Local dates ("YYYY-MM-DD") on which the business is closed. */
  holidays: readonly string[];
}

export interface SlaPolicyLike {
  firstReplyMins: number;
  resolveMins: number;
  businessHoursOnly: boolean;
}

/**
 * `start` + `minutes` of SLA time.
 *
 * Business time: the clock starts at `start` when it is inside an open interval, otherwise at the
 * next opening (so 0 minutes returns that clock start); the result is the earliest instant at
 * which `minutes` of business time have elapsed. Throws a RangeError for an invalid date, negative
 * or non-finite minutes, or (business time only) an invalid calendar — unknown time zone,
 * malformed "HH:mm", a close not after its open, a malformed holiday, or no open weekday at all.
 */
export function addSlaMinutes(
  start: Date,
  minutes: number,
  calendar: BusinessCalendar,
  businessHoursOnly: boolean,
): Date {
  const startMs = instantOf(start, 'addSlaMinutes', 'start');
  const durationMs = durationOf(minutes, 'addSlaMinutes');
  if (!businessHoursOnly) return new Date(startMs + durationMs);
  return new Date(addBusinessMs(prepareCalendar(calendar), startMs, durationMs));
}

/**
 * SLA minutes elapsed between two instants (0 if `to` ≤ `from`); inverse of addSlaMinutes.
 *
 * Whole minutes, rounded down. Throws like addSlaMinutes for invalid dates or calendars.
 */
export function slaMinutesBetween(
  from: Date,
  to: Date,
  calendar: BusinessCalendar,
  businessHoursOnly: boolean,
): number {
  const fromMs = instantOf(from, 'slaMinutesBetween', 'from');
  const toMs = instantOf(to, 'slaMinutesBetween', 'to');
  if (!businessHoursOnly) return toMs > fromMs ? Math.floor((toMs - fromMs) / MINUTE_MS) : 0;
  const prepared = prepareCalendar(calendar);
  if (toMs <= fromMs) return 0;
  return Math.floor(businessMsBetween(prepared, fromMs, toMs) / MINUTE_MS);
}

/** A finished PENDING pause of the resolution clock (the ticket's `slaPauses`). */
export interface SlaPause {
  from: Date;
  to: Date;
}

/**
 * Due dates for a new ticket, or after a priority change (from `createdAt`, with the new policy).
 *
 * `pauses` are the ticket's finished PENDING pauses: each one stops the resolution clock exactly
 * as `resumeDueDate` did when it ended (replayed in order, so a pause that started after the
 * target had passed still adds nothing), measured with the given policy's clock (business or
 * calendar time). The first-reply clock never pauses (spec §7). A pause still running is not
 * included: it is credited by `resumeDueDate` when it ends.
 */
export function computeDueDates(
  createdAt: Date,
  policy: SlaPolicyLike,
  calendar: BusinessCalendar,
  pauses: readonly SlaPause[] = [],
): { firstReplyDueAt: Date; resolveDueAt: Date } {
  const { businessHoursOnly } = policy;
  let resolveDueAt = addSlaMinutes(createdAt, policy.resolveMins, calendar, businessHoursOnly);
  const ordered = pauses
    .filter((p) => p.to.getTime() >= p.from.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime());
  for (const pause of ordered) {
    resolveDueAt = resumeDueDate(resolveDueAt, pause.from, pause.to, calendar, businessHoursOnly);
  }
  return {
    firstReplyDueAt: addSlaMinutes(createdAt, policy.firstReplyMins, calendar, businessHoursOnly),
    resolveDueAt,
  };
}

/**
 * Resolution due date after a PENDING pause ends: the SLA time that was left when the pause
 * started is added from the moment it ends, to the millisecond (repeated pauses never drift the
 * target). A target that had already passed when the pause started stays where it was (the
 * breach is not erased).
 */
export function resumeDueDate(
  dueAt: Date,
  pausedAt: Date,
  resumedAt: Date,
  calendar: BusinessCalendar,
  businessHoursOnly: boolean,
): Date {
  const dueMs = instantOf(dueAt, 'resumeDueDate', 'dueAt');
  const pausedMs = instantOf(pausedAt, 'resumeDueDate', 'pausedAt');
  const resumedMs = instantOf(resumedAt, 'resumeDueDate', 'resumedAt');
  if (dueMs <= pausedMs) return dueAt;
  if (!businessHoursOnly) return new Date(resumedMs + (dueMs - pausedMs));
  const prepared = prepareCalendar(calendar);
  const remainingMs = businessMsBetween(prepared, pausedMs, dueMs);
  return new Date(addBusinessMs(prepared, resumedMs, remainingMs));
}

// ---------------------------------------------------------------------------------------------
// Implementation (Intl only, no dependencies)
//
// - Local dates are handled as "day numbers" (days since 1970-01-01 of the local calendar), so
//   walking days, weekdays and holiday lookups are plain integer arithmetic; only open days need
//   the time zone.
// - A local "HH:mm" on a given date maps to the FIRST instant at which the local clock reads that
//   time or later: a time skipped by a DST jump forward opens/closes at the jump itself, and a
//   time repeated by a jump back uses its first occurrence. This mapping is monotonic, so an
//   interval never inverts; business time is the real elapsed time inside [open, close), so a DST
//   day's interval can be shorter or longer than its wall-clock span.
// - The walk consumes whole open intervals per day, so its cost grows with the number of days
//   spanned (closed days and holidays cost no Intl calls); resolved local times are memoised per
//   time zone.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Bound on the per-zone memo of resolved local times (cleared when exceeded). */
const MEMO_LIMIT = 50_000;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

interface ZoneInfo {
  format: Intl.DateTimeFormat;
  /** Local wall-clock ms (as if UTC) → first instant at which the local clock reads it or later. */
  memo: Map<number, number>;
}

interface OpenMinutes {
  /** Minutes after local midnight. */
  open: number;
  /** Minutes after local midnight (up to 1440 for "24:00"). */
  close: number;
}

interface PreparedCalendar {
  zone: ZoneInfo;
  /** Index 0 = Sunday … 6 = Saturday. */
  hours: readonly (OpenMinutes | null)[];
  /** Local day numbers. */
  holidays: ReadonlySet<number>;
}

const zones = new Map<string, ZoneInfo>();

function zoneInfo(timeZone: string): ZoneInfo {
  let zone = zones.get(timeZone);
  if (!zone) {
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new RangeError(`SLA calendar: unknown time zone "${timeZone}" (expected an IANA name)`);
    }
    zone = { format, memo: new Map() };
    zones.set(timeZone, zone);
  }
  return zone;
}

/** UTC offset (ms) of `timeZone` at instant `t`: local wall-clock ms minus `t`. */
function offsetAt(zone: ZoneInfo, t: number): number {
  const second = Math.floor(t / 1000) * 1000;
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let sec = 0;
  for (const part of zone.format.formatToParts(second)) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        sec = Number(part.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, sec) - second;
}

/** Local day number of instant `t`. */
function localDayOf(zone: ZoneInfo, t: number): number {
  return Math.floor((t + offsetAt(zone, t)) / DAY_MS);
}

/** First instant at which the local clock reads `local` (wall-clock ms as if UTC) or later. */
function instantOfLocal(zone: ZoneInfo, local: number): number {
  const cached = zone.memo.get(local);
  if (cached !== undefined) return cached;
  // Offsets a day either side bracket any transition near `local` (offsets are within ±14 h).
  const before = offsetAt(zone, local - DAY_MS);
  const after = offsetAt(zone, local + DAY_MS);
  let instant = Number.POSITIVE_INFINITY;
  for (const offset of before === after ? [before] : [before, after]) {
    const candidate = local - offset;
    if (candidate < instant && offsetAt(zone, candidate) === offset) instant = candidate;
  }
  if (instant === Number.POSITIVE_INFINITY) {
    // Skipped by a jump forward: the clock passes `local` at the transition itself. Bisect for it
    // (transitions fall on whole seconds): the offset is `before` at `low`, `after` at `high`.
    let low = local - after;
    let high = local - before;
    while (high - low > 1000) {
      const mid = low + Math.floor((high - low) / 2000) * 1000;
      if (offsetAt(zone, mid) === before) low = mid;
      else high = mid;
    }
    instant = high;
  }
  if (zone.memo.size >= MEMO_LIMIT) zone.memo.clear();
  zone.memo.set(local, instant);
  return instant;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseTime(value: unknown, what: string): number {
  const match = typeof value === 'string' ? TIME_RE.exec(value) : null;
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) {
    throw new RangeError(`SLA calendar: ${what} "${String(value)}" is not a valid "HH:mm" time`);
  }
  return hours * 60 + minutes;
}

function parseHoliday(value: unknown): number {
  const match = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month &&
      date.getUTCDate() === day
    ) {
      return date.getTime() / DAY_MS;
    }
  }
  throw new RangeError(`SLA calendar: holiday "${String(value)}" is not a valid "YYYY-MM-DD" date`);
}

function prepareCalendar(calendar: BusinessCalendar): PreparedCalendar {
  const { timeZone } = calendar;
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new RangeError('SLA calendar: timeZone is required (an IANA name such as "Asia/Qatar")');
  }
  const zone = zoneInfo(timeZone);
  const hours = WEEKDAY_NAMES.map((name, weekday): OpenMinutes | null => {
    const day = calendar.hours[weekday];
    if (!day) return null;
    const open = parseTime(day.open, `${name} opening time`);
    const close = parseTime(day.close, `${name} closing time`);
    if (close <= open) {
      throw new RangeError(
        `SLA calendar: ${name} closes at "${day.close}", which is not after its opening "${day.open}"`,
      );
    }
    return { open, close };
  });
  if (hours.every((day) => day === null)) {
    throw new RangeError(
      'SLA calendar: no weekday has business hours, so business-hours SLA time can never elapse',
    );
  }
  return { zone, hours, holidays: new Set(calendar.holidays.map(parseHoliday)) };
}

/** Open interval [open, close) of local day `day` as instants, or null when closed. */
function openInterval(calendar: PreparedCalendar, day: number): readonly [number, number] | null {
  if (calendar.holidays.has(day)) return null;
  // 1970-01-01 (day 0) was a Thursday.
  const hours = calendar.hours[(((day + 4) % 7) + 7) % 7];
  if (!hours) return null;
  const midnight = day * DAY_MS;
  const open = instantOfLocal(calendar.zone, midnight + hours.open * MINUTE_MS);
  const close = instantOfLocal(calendar.zone, midnight + hours.close * MINUTE_MS);
  // Both ends inside one skipped (DST) stretch: nothing is open that day.
  return close > open ? [open, close] : null;
}

function addBusinessMs(calendar: PreparedCalendar, start: number, durationMs: number): number {
  // With at least one open weekday, a run of closed days is at most a week per holiday (plus a
  // DST-emptied day); the bound only turns an impossible endless walk into an error.
  const maxClosedRun = 7 * (calendar.holidays.size + 3);
  let remaining = durationMs;
  let closedRun = 0;
  // Intervals of earlier local days end at or before `start` (a close is at most 24:00).
  for (let day = localDayOf(calendar.zone, start); ; day++) {
    const interval = openInterval(calendar, day);
    if (!interval) {
      closedRun += 1;
      if (closedRun > maxClosedRun) {
        throw new Error(
          `addSlaMinutes: no business time in ${closedRun} consecutive days; check the business hours and holidays`,
        );
      }
      continue;
    }
    closedRun = 0;
    const [open, close] = interval;
    if (close <= start) continue;
    const from = Math.max(open, start);
    const available = close - from;
    if (remaining <= available) return from + remaining;
    remaining -= available;
  }
}

function businessMsBetween(calendar: PreparedCalendar, from: number, to: number): number {
  let total = 0;
  // Later days open after `to` (the +1 covers a clock that jumped back across local midnight).
  const lastDay = localDayOf(calendar.zone, to) + 1;
  for (let day = localDayOf(calendar.zone, from); day <= lastDay; day++) {
    const interval = openInterval(calendar, day);
    if (!interval) continue;
    const [open, close] = interval;
    if (open >= to) break;
    total += Math.max(0, Math.min(close, to) - Math.max(open, from));
  }
  return total;
}

function instantOf(value: Date, fn: string, name: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new RangeError(`${fn}: ${name} is not a valid Date`);
  return ms;
}

function durationOf(minutes: number, fn: string): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
    throw new RangeError(`${fn}: minutes must be a finite number ≥ 0 (got ${String(minutes)})`);
  }
  return Math.round(minutes * MINUTE_MS);
}
