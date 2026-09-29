import { describe, expect, it } from 'vitest';
import {
  addSlaMinutes,
  computeDueDates,
  computeSlaTargets,
  resumeDueDate,
  slaMinutesBetween,
  type BusinessCalendar,
  type BusinessDayHours,
  type SlaPolicyLike,
  type SlaPolicyRiskLike,
} from './sla.ts';

const MIN = 60_000;

// ---------------------------------------------------------------------------------------------
// Fixtures

const WORKDAY: BusinessDayHours = { open: '07:30', close: '16:30' };

/** The seeded calendar: Sun–Thu 07:30–16:30 Asia/Qatar, Friday and Saturday closed. */
const QATAR: BusinessCalendar = {
  timeZone: 'Asia/Qatar',
  hours: [WORKDAY, WORKDAY, WORKDAY, WORKDAY, WORKDAY, null, null],
  holidays: [],
};

/** The seeded SLA policies (minutes). */
const P1: SlaPolicyLike = { firstReplyMins: 15, resolveMins: 240, businessHoursOnly: false };
const P2: SlaPolicyLike = { firstReplyMins: 60, resolveMins: 480, businessHoursOnly: false };
const P3: SlaPolicyLike = { firstReplyMins: 240, resolveMins: 1080, businessHoursOnly: true };
const P4: SlaPolicyLike = { firstReplyMins: 540, resolveMins: 2700, businessHoursOnly: true };

const everyDay = (open: string, close: string): BusinessDayHours[] =>
  Array.from({ length: 7 }, () => ({ open, close }));

const OFFICE: BusinessDayHours = { open: '09:00', close: '17:00' };
/** Mon–Fri 09:00–17:00 London (DST: 29 Mar 2026 01:00 GMT → 02:00 BST, 25 Oct 02:00 BST → 01:00 GMT). */
const LONDON_OFFICE: BusinessCalendar = {
  timeZone: 'Europe/London',
  hours: [null, OFFICE, OFFICE, OFFICE, OFFICE, OFFICE, null],
  holidays: [],
};
/** Every night 00:30–03:30 London: spans the 01:00 → 02:00 jump and the repeated 01:00–02:00 hour. */
const LONDON_NIGHT: BusinessCalendar = {
  timeZone: 'Europe/London',
  hours: everyDay('00:30', '03:30'),
  holidays: [],
};
/** Every day 01:30–03:00 London: the opening does not exist on 29 Mar 2026. */
const LONDON_GAP_OPEN: BusinessCalendar = {
  timeZone: 'Europe/London',
  hours: everyDay('01:30', '03:00'),
  holidays: [],
};
/** Every day 01:15–01:45 London: both ends happen twice on 25 Oct 2026. */
const LONDON_REPEATED: BusinessCalendar = {
  timeZone: 'Europe/London',
  hours: everyDay('01:15', '01:45'),
  holidays: [],
};
/** Round the clock, London: business time must then equal elapsed time, DST or not. */
const LONDON_ALL_DAY: BusinessCalendar = {
  timeZone: 'Europe/London',
  hours: everyDay('00:00', '24:00'),
  holidays: [],
};

/** Qatar local time (UTC+03:00 all year), e.g. qa('2026-10-01T15:00'). */
const qa = (local: string): Date => new Date(`${local}+03:00`);
const utc = (iso: string): Date => new Date(`${iso}Z`);

const withHolidays = (calendar: BusinessCalendar, ...holidays: string[]): BusinessCalendar => ({
  ...calendar,
  holidays,
});

const add = (start: Date, minutes: number, calendar = QATAR, businessHoursOnly = true): Date =>
  addSlaMinutes(start, minutes, calendar, businessHoursOnly);
const between = (from: Date, to: Date, calendar = QATAR, businessHoursOnly = true): number =>
  slaMinutesBetween(from, to, calendar, businessHoursOnly);

/** Deterministic PRNG (mulberry32) so the "random" cases are the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const YEAR_2026_START = Date.UTC(2026, 0, 1);
const YEAR_MS = 365 * 24 * 60 * MIN;

/** Every date of `year` as "YYYY-MM-DD". */
const datesOfYear = (year: number): string[] => {
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / (24 * 60 * MIN);
  return Array.from({ length: days }, (_, i) =>
    new Date(Date.UTC(year, 0, 1 + i)).toISOString().slice(0, 10),
  );
};

// Brute-force oracle for the Qatar calendar (fixed UTC+03:00): walks minute by minute with no
// time-zone library, independent of the implementation's day/interval logic.
const QATAR_OFFSET = 3 * 60 * MIN;
function isQatarBusinessMinute(t: number, holidays: ReadonlySet<string>): boolean {
  const local = new Date(t + QATAR_OFFSET);
  const weekday = local.getUTCDay();
  if (weekday === 5 || weekday === 6) return false;
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minuteOfDay < 7 * 60 + 30 || minuteOfDay >= 16 * 60 + 30) return false;
  return !holidays.has(local.toISOString().slice(0, 10));
}
function oracleAdd(start: number, minutes: number, holidays: ReadonlySet<string>): number {
  let t = start;
  while (!isQatarBusinessMinute(t, holidays)) t += MIN;
  for (let counted = 0; counted < minutes; t += MIN) {
    if (isQatarBusinessMinute(t, holidays)) counted += 1;
  }
  return t;
}
function oracleBetween(from: number, to: number, holidays: ReadonlySet<string>): number {
  let counted = 0;
  for (let t = from; t + MIN <= to; t += MIN) {
    if (isQatarBusinessMinute(t, holidays)) counted += 1;
  }
  return counted;
}

// 2026-10-01 is a Thursday; 2–3 Oct are Friday/Saturday; 4 Oct is a Sunday.

// ---------------------------------------------------------------------------------------------

describe('addSlaMinutes — seeded Qatar calendar (Sun–Thu 07:30–16:30)', () => {
  it('P3 first reply (240) from Thursday 15:00 carries over the weekend to Sunday', () => {
    // 90 minutes on Thursday (15:00–16:30), the remaining 150 from Sunday 07:30.
    expect(add(qa('2026-10-01T15:00'), 240)).toEqual(qa('2026-10-04T10:00'));
    expect(add(qa('2026-10-01T15:30'), 240)).toEqual(qa('2026-10-04T10:30'));
  });

  it('a clock started on the weekend starts at the Sunday opening', () => {
    expect(add(qa('2026-10-02T09:00'), 240)).toEqual(qa('2026-10-04T11:30'));
    expect(add(qa('2026-10-03T23:59'), 240)).toEqual(qa('2026-10-04T11:30'));
  });

  it('a clock started before opening or after closing waits for the next opening', () => {
    expect(add(qa('2026-10-04T06:00'), 240)).toEqual(qa('2026-10-04T11:30'));
    expect(add(qa('2026-10-05T20:00'), 60)).toEqual(qa('2026-10-06T08:30'));
    expect(add(qa('2026-10-05T00:00'), 60)).toEqual(qa('2026-10-05T08:30'));
  });

  it('a start exactly at opening counts from that instant', () => {
    expect(add(qa('2026-10-04T07:30'), 240)).toEqual(qa('2026-10-04T11:30'));
    expect(add(qa('2026-10-04T07:30'), 1)).toEqual(qa('2026-10-04T07:31'));
  });

  it('a start exactly at closing is outside hours (next opening)', () => {
    expect(add(qa('2026-10-01T16:30'), 240)).toEqual(qa('2026-10-04T11:30'));
    expect(add(qa('2026-10-04T16:30'), 60)).toEqual(qa('2026-10-05T08:30'));
  });

  it('a due time landing exactly on a closing time stays there', () => {
    expect(add(qa('2026-10-01T12:30'), 240)).toEqual(qa('2026-10-01T16:30'));
    expect(add(qa('2026-10-04T16:29'), 1)).toEqual(qa('2026-10-04T16:30'));
    expect(add(qa('2026-10-04T07:30'), 540)).toEqual(qa('2026-10-04T16:30'));
    // One more minute rolls to the next opening.
    expect(add(qa('2026-10-01T12:30'), 241)).toEqual(qa('2026-10-04T07:31'));
  });

  it('0 minutes: the clock start (the instant itself inside hours, else the next opening)', () => {
    expect(add(qa('2026-10-04T10:15'), 0)).toEqual(qa('2026-10-04T10:15'));
    expect(add(qa('2026-10-04T07:30'), 0)).toEqual(qa('2026-10-04T07:30'));
    expect(add(qa('2026-10-02T10:00'), 0)).toEqual(qa('2026-10-04T07:30'));
    expect(add(qa('2026-10-01T16:30'), 0)).toEqual(qa('2026-10-04T07:30'));
  });

  it('P3 resolution (1080 = 2 business days)', () => {
    expect(add(qa('2026-10-04T07:30'), 1080)).toEqual(qa('2026-10-05T16:30'));
    // Thursday 90 + Sunday 540 + Monday 450.
    expect(add(qa('2026-10-01T15:00'), 1080)).toEqual(qa('2026-10-05T15:00'));
    expect(add(qa('2026-10-02T12:00'), 1080)).toEqual(qa('2026-10-05T16:30'));
  });

  it('P4 resolution (2700 = 5 business days)', () => {
    expect(add(qa('2026-10-04T07:30'), 2700)).toEqual(qa('2026-10-08T16:30'));
    // Thursday 90 + Sun–Wed 4 × 540 + Thursday 450.
    expect(add(qa('2026-10-01T15:00'), 2700)).toEqual(qa('2026-10-08T15:00'));
    expect(add(qa('2026-10-07T10:00'), 2700)).toEqual(qa('2026-10-14T10:00'));
  });

  it('multi-week spans', () => {
    // 100 000 = 185 full days (37 weeks) + 100 minutes.
    expect(add(qa('2026-01-04T07:30'), 100_000)).toEqual(qa('2026-09-20T09:10'));
    expect(add(qa('2026-10-04T07:30'), 540 * 15)).toEqual(qa('2026-10-22T16:30'));
  });

  it('keeps the start’s seconds and milliseconds when it is inside hours', () => {
    expect(add(qa('2026-10-04T10:00:30.250'), 5)).toEqual(qa('2026-10-04T10:05:30.250'));
    expect(add(qa('2026-10-04T16:20:30.250'), 10)).toEqual(qa('2026-10-05T07:30:30.250'));
    // Outside hours the clock starts exactly at the opening.
    expect(add(qa('2026-10-02T10:00:30.250'), 5)).toEqual(qa('2026-10-04T07:35'));
  });

  it('returns a new Date and does not mutate the input', () => {
    const start = qa('2026-10-04T10:00');
    const due = add(start, 0);
    expect(due).not.toBe(start);
    expect(start).toEqual(qa('2026-10-04T10:00'));
  });
});

describe('holidays', () => {
  it('a holiday Sunday pushes the due time to Monday', () => {
    const cal = withHolidays(QATAR, '2026-10-04');
    expect(add(qa('2026-10-01T15:00'), 240, cal)).toEqual(qa('2026-10-05T10:00'));
    expect(add(qa('2026-10-02T09:00'), 240, cal)).toEqual(qa('2026-10-05T11:30'));
    expect(add(qa('2026-10-04T10:00'), 60, cal)).toEqual(qa('2026-10-05T08:30'));
  });

  it('consecutive holidays merge with the weekend (Eid al-Adha 27–29 May 2026)', () => {
    const cal = withHolidays(QATAR, '2026-05-27', '2026-05-28', '2026-05-29');
    // Tuesday 26 May 15:00: 90 minutes, then Wed–Sat closed, 150 from Sunday 31 May.
    expect(add(qa('2026-05-26T15:00'), 240, cal)).toEqual(qa('2026-05-31T10:00'));
    expect(between(qa('2026-05-26T15:00'), qa('2026-05-31T10:00'), cal)).toBe(240);
  });

  it('a holiday on a closed weekday changes nothing', () => {
    const cal = withHolidays(QATAR, '2026-10-02', '2026-10-03');
    expect(add(qa('2026-10-01T15:00'), 240, cal)).toEqual(add(qa('2026-10-01T15:00'), 240));
  });

  it('holiday order and duplicates do not matter', () => {
    const cal = withHolidays(QATAR, '2026-10-05', '2026-10-04', '2026-10-05');
    expect(add(qa('2026-10-01T16:00'), 60, cal)).toEqual(qa('2026-10-06T08:00'));
  });

  it('holidays and weekdays are local dates of the calendar’s zone, not UTC dates', () => {
    // Tokyo (UTC+09:00): Monday 09:00–17:00 JST is Monday 00:00Z–08:00Z.
    const tokyo: BusinessCalendar = {
      timeZone: 'Asia/Tokyo',
      hours: [null, OFFICE, OFFICE, OFFICE, OFFICE, OFFICE, null],
      holidays: ['2026-10-05'],
    };
    // Friday 2 Oct 17:00 JST (08:00Z) + 60 → Tuesday 6 Oct 10:00 JST (01:00Z).
    expect(add(utc('2026-10-02T08:00'), 60, tokyo)).toEqual(utc('2026-10-06T01:00'));
    // Los Angeles (UTC−07:00 in October): Monday 09:00 PDT is Monday 16:00Z.
    const la: BusinessCalendar = { ...tokyo, timeZone: 'America/Los_Angeles' };
    expect(add(utc('2026-10-03T00:00'), 60, la)).toEqual(utc('2026-10-06T17:00'));
    // A start at 00:30 on the holiday (local) — 21:30Z the day before — waits for Monday.
    expect(add(utc('2026-10-03T21:30'), 60, withHolidays(QATAR, '2026-10-04'))).toEqual(
      qa('2026-10-05T08:30'),
    );
  });

  it('works at extreme UTC offsets, where local dates and UTC dates differ most', () => {
    // Pago Pago (UTC−11:00): 22:00–24:00 local is 09:00Z–11:00Z on the next UTC date.
    const pagoPago: BusinessCalendar = {
      timeZone: 'Pacific/Pago_Pago',
      hours: everyDay('22:00', '24:00'),
      holidays: [],
    };
    // Sunday 4 Oct 23:00 local = 5 Oct 10:00Z, inside the 4 Oct interval.
    expect(add(utc('2026-10-05T10:00'), 30, pagoPago)).toEqual(utc('2026-10-05T10:30'));
    // 60 minutes left that night, 30 more from 5 Oct 22:00 local (6 Oct 09:00Z).
    expect(add(utc('2026-10-05T10:00'), 90, pagoPago)).toEqual(utc('2026-10-06T09:30'));
    expect(between(utc('2026-10-05T10:00'), utc('2026-10-05T12:00'), pagoPago)).toBe(60);
    const pagoHoliday = withHolidays(pagoPago, '2026-10-04');
    expect(add(utc('2026-10-05T10:00'), 30, pagoHoliday)).toEqual(utc('2026-10-06T09:30'));
    // Kiritimati (UTC+14:00): 00:00–01:00 local is 10:00Z–11:00Z on the previous UTC date.
    const kiritimati: BusinessCalendar = {
      timeZone: 'Pacific/Kiritimati',
      hours: everyDay('00:00', '01:00'),
      holidays: [],
    };
    expect(add(utc('2026-10-04T10:30'), 30, kiritimati)).toEqual(utc('2026-10-04T11:00'));
    const kiriHoliday = withHolidays(kiritimati, '2026-10-05');
    expect(add(utc('2026-10-04T10:30'), 30, kiriHoliday)).toEqual(utc('2026-10-05T10:30'));
    // Only 6 Oct local (5 Oct 10:00Z–11:00Z) counts; 5 Oct local is the holiday.
    expect(between(utc('2026-10-04T09:00'), utc('2026-10-05T12:00'), kiriHoliday)).toBe(60);
  });

  it('a whole year of holidays is skipped quickly', () => {
    const cal = withHolidays(QATAR, ...datesOfYear(2026));
    const started = performance.now();
    // 2027-01-03 is the first open day: a Sunday.
    expect(add(qa('2026-01-01T00:00'), 2700, cal)).toEqual(qa('2027-01-07T16:30'));
    expect(add(qa('2026-06-15T10:00'), 240, cal)).toEqual(qa('2027-01-03T11:30'));
    expect(between(qa('2026-01-01T00:00'), qa('2027-01-01T00:00'), cal)).toBe(0);
    expect(between(qa('2026-01-01T00:00'), qa('2027-01-07T16:30'), cal)).toBe(2700);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('ten years of business minutes compute quickly and round-trip', () => {
    const cal = withHolidays(QATAR, ...datesOfYear(2026), ...datesOfYear(2028));
    const started = performance.now();
    const start = qa('2025-12-31T12:00');
    const due = add(start, 1_000_000, cal);
    expect(between(start, due, cal)).toBe(1_000_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('slaMinutesBetween', () => {
  it('counts business minutes only', () => {
    expect(between(qa('2026-10-01T15:00'), qa('2026-10-04T10:00'))).toBe(240);
    expect(between(qa('2026-10-04T07:30'), qa('2026-10-04T16:30'))).toBe(540);
    expect(between(qa('2026-10-04T00:00'), qa('2026-10-05T00:00'))).toBe(540);
    expect(between(qa('2026-10-04T07:30'), qa('2026-10-08T16:30'))).toBe(2700);
    expect(between(qa('2026-10-01T15:00'), qa('2026-10-05T15:00'))).toBe(1080);
  });

  it('is 0 across closed time, and when `to` is not after `from`', () => {
    expect(between(qa('2026-10-02T08:00'), qa('2026-10-03T20:00'))).toBe(0);
    expect(between(qa('2026-10-01T16:30'), qa('2026-10-04T07:30'))).toBe(0);
    expect(between(qa('2026-10-04T10:00'), qa('2026-10-04T10:00'))).toBe(0);
    expect(between(qa('2026-10-04T12:00'), qa('2026-10-04T10:00'))).toBe(0);
  });

  it('rounds partial minutes down', () => {
    expect(between(qa('2026-10-04T10:00'), qa('2026-10-04T10:00:59.999'))).toBe(0);
    expect(between(qa('2026-10-04T10:00:30'), qa('2026-10-04T10:02'))).toBe(1);
    expect(between(qa('2026-10-04T16:29:30'), qa('2026-10-05T07:31'))).toBe(1);
  });

  it('skips holidays', () => {
    const cal = withHolidays(QATAR, '2026-10-04');
    expect(between(qa('2026-10-01T15:00'), qa('2026-10-05T10:00'), cal)).toBe(240);
  });
});

describe('addSlaMinutes / slaMinutesBetween against a brute-force oracle (Qatar)', () => {
  const holidays = [
    '2026-02-10',
    '2026-03-20',
    '2026-03-21',
    '2026-03-22',
    '2026-05-27',
    '2026-05-28',
    '2026-05-29',
    '2026-10-04',
    '2026-12-17',
    '2026-12-18',
  ];
  const cal = withHolidays(QATAR, ...holidays);
  const holidaySet = new Set(holidays);

  it('addSlaMinutes matches minute-by-minute counting', () => {
    const random = seededRandom(20260924);
    for (let i = 0; i < 60; i++) {
      const start = YEAR_2026_START + Math.floor(random() * 360 * 24 * 60) * MIN;
      const minutes = Math.floor(random() * 3000);
      expect(add(new Date(start), minutes, cal).getTime(), `start ${start} + ${minutes}`).toBe(
        oracleAdd(start, minutes, holidaySet),
      );
    }
  });

  it('slaMinutesBetween matches minute-by-minute counting', () => {
    const random = seededRandom(4817);
    for (let i = 0; i < 60; i++) {
      const from = YEAR_2026_START + Math.floor(random() * 360 * 24 * 60) * MIN;
      const to = from + Math.floor(random() * 12 * 24 * 60) * MIN;
      expect(between(new Date(from), new Date(to), cal), `${from} → ${to}`).toBe(
        oracleBetween(from, to, holidaySet),
      );
    }
  });
});

describe('round trip: slaMinutesBetween(start, addSlaMinutes(start, m)) === m', () => {
  const cases: [string, BusinessCalendar][] = [
    ['Qatar + holidays', withHolidays(QATAR, '2026-03-20', '2026-03-22', '2026-10-04')],
    ['London office', withHolidays(LONDON_OFFICE, '2026-04-03', '2026-04-06', '2026-12-25')],
    ['London nights (DST inside hours)', LONDON_NIGHT],
    ['London opening in the DST gap', LONDON_GAP_OPEN],
    ['London repeated hour', LONDON_REPEATED],
  ];

  it.each(cases)('%s', (_name, cal) => {
    const random = seededRandom(1234567);
    for (let i = 0; i < 150; i++) {
      // Millisecond-precision starts anywhere in 2026, DST days included.
      const start = new Date(YEAR_2026_START + Math.floor(random() * YEAR_MS));
      const minutes = Math.floor(random() * 3000);
      const due = add(start, minutes, cal);
      const label = `${start.toISOString()} + ${minutes}`;
      expect(due.getTime(), label).toBeGreaterThanOrEqual(start.getTime());
      expect(between(start, due, cal), label).toBe(minutes);
      // The due time is the earliest instant with that much SLA time…
      if (minutes > 0)
        expect(between(start, new Date(due.getTime() - 1), cal), label).toBe(minutes - 1);
      // …and one more minute always lands later.
      expect(add(start, minutes + 1, cal).getTime(), label).toBeGreaterThan(due.getTime());
    }
  });

  it('a pause resumed at the same instant keeps the due date (whole-minute instants)', () => {
    const random = seededRandom(99);
    for (let i = 0; i < 100; i++) {
      const created = new Date(YEAR_2026_START + Math.floor(random() * 360 * 24 * 60) * MIN);
      const due = add(created, 1 + Math.floor(random() * 2700));
      const span = (due.getTime() - created.getTime()) / MIN;
      const pausedAt = new Date(created.getTime() + Math.floor(random() * span) * MIN);
      expect(resumeDueDate(due, pausedAt, pausedAt, QATAR, true), pausedAt.toISOString()).toEqual(
        due,
      );
    }
  });

  it('with millisecond instants a pause resumed at the same instant keeps the due date exactly', () => {
    const random = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const created = new Date(YEAR_2026_START + Math.floor(random() * YEAR_MS));
      const due = add(created, 1 + Math.floor(random() * 2700));
      const pausedAt = new Date(
        created.getTime() + Math.floor(random() * (due.getTime() - created.getTime())),
      );
      // Resuming inside business hours: nothing was paused, nothing may be lost.
      const resumedAt = isQatarBusinessMinute(pausedAt.getTime(), new Set()) ? pausedAt : null;
      if (!resumedAt) continue;
      expect(resumeDueDate(due, pausedAt, resumedAt, QATAR, true).getTime()).toBe(due.getTime());
      expect(resumeDueDate(due, pausedAt, resumedAt, QATAR, false).getTime()).toBe(due.getTime());
    }
  });
});

describe('Europe/London across the 2026 DST changes', () => {
  it('office hours keep their local times across the March change', () => {
    // Friday 27 Mar 16:00 GMT (16:00Z) + 120 → Monday 30 Mar 10:00 BST (09:00Z).
    expect(add(utc('2026-03-27T16:00'), 120, LONDON_OFFICE)).toEqual(utc('2026-03-30T09:00'));
    expect(between(utc('2026-03-27T16:00'), utc('2026-03-30T09:00'), LONDON_OFFICE)).toBe(120);
    // The Monday opening is 09:00 BST = 08:00Z.
    expect(add(utc('2026-03-28T12:00'), 0, LONDON_OFFICE)).toEqual(utc('2026-03-30T08:00'));
  });

  it('office hours keep their local times across the October change', () => {
    // Friday 23 Oct 16:00 BST (15:00Z) + 120 → Monday 26 Oct 10:00 GMT (10:00Z).
    expect(add(utc('2026-10-23T15:00'), 120, LONDON_OFFICE)).toEqual(utc('2026-10-26T10:00'));
    expect(between(utc('2026-10-23T15:00'), utc('2026-10-26T10:00'), LONDON_OFFICE)).toBe(120);
  });

  it('multi-week spans across each change', () => {
    // 10 business days of 480 minutes.
    expect(add(utc('2026-03-23T09:00'), 4800, LONDON_OFFICE)).toEqual(utc('2026-04-03T16:00'));
    expect(add(utc('2026-10-19T08:00'), 4800, LONDON_OFFICE)).toEqual(utc('2026-10-30T17:00'));
    expect(between(utc('2026-03-23T09:00'), utc('2026-04-03T16:00'), LONDON_OFFICE)).toBe(4800);
    expect(between(utc('2026-10-19T08:00'), utc('2026-10-30T17:00'), LONDON_OFFICE)).toBe(4800);
  });

  it('the spring-forward night is an hour shorter (00:30 GMT → 03:30 BST = 120 real minutes)', () => {
    expect(between(utc('2026-03-27T12:00'), utc('2026-03-28T12:00'), LONDON_NIGHT)).toBe(180);
    expect(between(utc('2026-03-28T12:00'), utc('2026-03-29T12:00'), LONDON_NIGHT)).toBe(120);
    // Due exactly at the 03:30 BST closing (02:30Z)…
    expect(add(utc('2026-03-29T00:00'), 120, LONDON_NIGHT)).toEqual(utc('2026-03-29T02:30'));
    // …and past it, from Monday's 00:30 BST opening (23:30Z on Sunday).
    expect(add(utc('2026-03-29T00:00'), 150, LONDON_NIGHT)).toEqual(utc('2026-03-30T00:00'));
  });

  it('the fall-back night is an hour longer (00:30 BST → 03:30 GMT = 240 real minutes)', () => {
    expect(between(utc('2026-10-24T12:00'), utc('2026-10-25T12:00'), LONDON_NIGHT)).toBe(240);
    expect(add(utc('2026-10-24T12:00'), 0, LONDON_NIGHT)).toEqual(utc('2026-10-24T23:30'));
    expect(add(utc('2026-10-24T12:00'), 240, LONDON_NIGHT)).toEqual(utc('2026-10-25T03:30'));
    expect(add(utc('2026-10-24T12:00'), 241, LONDON_NIGHT)).toEqual(utc('2026-10-26T00:31'));
  });

  it('an opening time skipped by the jump forward opens at the jump (02:00 BST)', () => {
    // 01:30 does not exist on 29 Mar: open 01:00Z (the jump) → close 03:00 BST (02:00Z).
    expect(add(utc('2026-03-29T00:00'), 0, LONDON_GAP_OPEN)).toEqual(utc('2026-03-29T01:00'));
    expect(add(utc('2026-03-29T00:00'), 10, LONDON_GAP_OPEN)).toEqual(utc('2026-03-29T01:10'));
    expect(between(utc('2026-03-28T12:00'), utc('2026-03-29T12:00'), LONDON_GAP_OPEN)).toBe(60);
    expect(between(utc('2026-03-27T12:00'), utc('2026-03-28T12:00'), LONDON_GAP_OPEN)).toBe(90);
  });

  it('times repeated by the jump back use their first occurrence', () => {
    // 01:15–01:45 BST on 25 Oct = 00:15Z–00:45Z (not the second 01:15–01:45 GMT).
    expect(add(utc('2026-10-25T00:00'), 30, LONDON_REPEATED)).toEqual(utc('2026-10-25T00:45'));
    expect(between(utc('2026-10-24T12:00'), utc('2026-10-25T12:00'), LONDON_REPEATED)).toBe(30);
    // A start during the second 01:15–01:45 is after that day's closing.
    expect(add(utc('2026-10-25T01:20'), 0, LONDON_REPEATED)).toEqual(utc('2026-10-26T01:15'));
  });

  it('a round-the-clock business calendar equals elapsed time, DST days included', () => {
    const random = seededRandom(31337);
    const starts = [utc('2026-03-28T23:59:30'), utc('2026-10-24T23:00'), utc('2026-10-25T00:59')];
    for (let i = 0; i < 100; i++) {
      starts.push(new Date(YEAR_2026_START + Math.floor(random() * YEAR_MS)));
    }
    for (const start of starts) {
      for (const minutes of [0, 1, 59, 60, 61, 1439, 1440, 1441, 3000]) {
        const expected = new Date(start.getTime() + minutes * MIN);
        expect(add(start, minutes, LONDON_ALL_DAY), start.toISOString()).toEqual(expected);
        expect(between(start, expected, LONDON_ALL_DAY)).toBe(minutes);
      }
    }
  });
});

describe('a clock that jumps back across local midnight', () => {
  // St John's ended DST at 00:01 NDT on Sunday 7 Nov 2010 (02:31Z), back to 23:01 NST on Saturday.
  const stJohns: BusinessCalendar = {
    timeZone: 'America/St_Johns',
    hours: [{ open: '00:00', close: '00:10' }],
    holidays: [],
  };

  it('keeps the Sunday interval from the first 00:00 (02:30Z) until the clock first reads 00:10 (03:40Z)', () => {
    // `to` reads Saturday 23:15 local but is already inside Sunday's interval.
    expect(between(utc('2010-11-07T02:00'), utc('2010-11-07T02:45'), stJohns)).toBe(15);
    expect(between(utc('2010-11-07T02:00'), utc('2010-11-07T04:00'), stJohns)).toBe(70);
    expect(add(utc('2010-11-06T12:00'), 15, stJohns)).toEqual(utc('2010-11-07T02:45'));
    expect(add(utc('2010-11-07T02:45'), 55, stJohns)).toEqual(utc('2010-11-07T03:40'));
  });
});

describe('24/7 policies (businessHoursOnly = false)', () => {
  it('adds plain minutes, ignoring weekends and holidays', () => {
    const cal = withHolidays(QATAR, '2026-10-02', '2026-10-04');
    expect(add(qa('2026-10-02T22:00'), 15, cal, false)).toEqual(qa('2026-10-02T22:15'));
    expect(add(qa('2026-10-03T22:00'), 240, cal, false)).toEqual(qa('2026-10-04T02:00'));
    expect(add(qa('2026-10-04T10:00:30.250'), 0, cal, false)).toEqual(
      qa('2026-10-04T10:00:30.250'),
    );
    // Elapsed time across a DST change: the local clock moves by 2 h for 60 minutes.
    expect(add(utc('2026-03-29T00:30'), 60, LONDON_OFFICE, false)).toEqual(utc('2026-03-29T01:30'));
  });

  it('measures plain elapsed minutes', () => {
    expect(between(qa('2026-10-02T22:00'), qa('2026-10-04T02:00'), QATAR, false)).toBe(28 * 60);
    expect(between(qa('2026-10-04T10:00'), qa('2026-10-04T10:00:59'), QATAR, false)).toBe(0);
    expect(between(qa('2026-10-04T10:00'), qa('2026-10-04T09:00'), QATAR, false)).toBe(0);
  });

  it('does not consult the calendar at all', () => {
    const broken: BusinessCalendar = { timeZone: 'Nowhere/City', hours: [], holidays: ['x'] };
    expect(add(qa('2026-10-04T10:00'), 60, broken, false)).toEqual(qa('2026-10-04T11:00'));
    expect(between(qa('2026-10-04T10:00'), qa('2026-10-04T11:00'), broken, false)).toBe(60);
  });
});

describe('computeDueDates with the seeded policies', () => {
  const created = qa('2026-10-01T15:00'); // Thursday afternoon

  it('P1 / P2 run 24/7', () => {
    expect(computeDueDates(created, P1, QATAR)).toEqual({
      firstReplyDueAt: qa('2026-10-01T15:15'),
      resolveDueAt: qa('2026-10-01T19:00'),
    });
    expect(computeDueDates(created, P2, QATAR)).toEqual({
      firstReplyDueAt: qa('2026-10-01T16:00'),
      resolveDueAt: qa('2026-10-01T23:00'),
    });
  });

  it('P3 / P4 count business hours', () => {
    expect(computeDueDates(created, P3, QATAR)).toEqual({
      firstReplyDueAt: qa('2026-10-04T10:00'),
      resolveDueAt: qa('2026-10-05T15:00'),
    });
    expect(computeDueDates(created, P4, QATAR)).toEqual({
      firstReplyDueAt: qa('2026-10-04T15:00'),
      resolveDueAt: qa('2026-10-08T15:00'),
    });
    expect(computeDueDates(qa('2026-10-02T11:00'), P3, QATAR)).toEqual({
      firstReplyDueAt: qa('2026-10-04T11:30'),
      resolveDueAt: qa('2026-10-05T16:30'),
    });
  });
});

describe('resumeDueDate (PENDING pause)', () => {
  it('pause and resume inside hours: the remaining business time restarts on resume', () => {
    // Paused Sunday 10:00 with the target Monday 12:00: 390 + 270 = 660 minutes left.
    const due = qa('2026-10-05T12:00');
    const resumed = resumeDueDate(due, qa('2026-10-04T10:00'), qa('2026-10-06T09:00'), QATAR, true);
    // Tuesday 09:00 + 450 to closing, then 210 from Wednesday 07:30.
    expect(resumed).toEqual(qa('2026-10-07T11:00'));
  });

  it('a pause outside hours consumed no business time', () => {
    // Paused on Friday; target Sunday 11:30 = 240 business minutes after the pause.
    const due = qa('2026-10-04T11:30');
    const paused = qa('2026-10-02T10:00');
    expect(resumeDueDate(due, paused, qa('2026-10-03T20:00'), QATAR, true)).toEqual(due);
    expect(resumeDueDate(due, paused, qa('2026-10-04T09:00'), QATAR, true)).toEqual(
      qa('2026-10-04T13:00'),
    );
  });

  it('a resume outside hours restarts the clock at the next opening', () => {
    const due = qa('2026-10-04T12:00');
    const paused = qa('2026-10-04T10:00'); // 120 minutes left
    expect(resumeDueDate(due, paused, qa('2026-10-08T17:00'), QATAR, true)).toEqual(
      qa('2026-10-11T09:30'),
    );
    expect(
      resumeDueDate(due, paused, qa('2026-10-08T17:00'), withHolidays(QATAR, '2026-10-11'), true),
    ).toEqual(qa('2026-10-12T09:30'));
  });

  it('a target already passed when the pause started stays (the breach is not erased)', () => {
    const due = qa('2026-10-04T09:00');
    expect(resumeDueDate(due, qa('2026-10-04T10:00'), qa('2026-10-06T10:00'), QATAR, true)).toBe(
      due,
    );
    expect(resumeDueDate(due, due, qa('2026-10-06T10:00'), QATAR, true)).toBe(due);
    expect(resumeDueDate(due, qa('2026-10-05T10:00'), qa('2026-10-06T10:00'), QATAR, false)).toBe(
      due,
    );
  });

  it('24/7 policies shift the target by the paused wall-clock time', () => {
    const paused = qa('2026-10-01T22:00');
    const due = qa('2026-10-01T23:30');
    expect(resumeDueDate(due, paused, qa('2026-10-03T08:00'), QATAR, false)).toEqual(
      qa('2026-10-03T09:30'),
    );
  });

  it('the remaining time is carried to the millisecond (a partial minute is kept)', () => {
    const due = qa('2026-10-04T12:00:30.250');
    expect(resumeDueDate(due, qa('2026-10-04T10:00'), qa('2026-10-05T10:00'), QATAR, true)).toEqual(
      qa('2026-10-05T12:00:30.250'),
    );
    expect(
      resumeDueDate(due, qa('2026-10-04T10:00:00.900'), qa('2026-10-05T10:00'), QATAR, false),
    ).toEqual(qa('2026-10-05T12:00:29.350'));
  });

  it('many short pauses never drift the target earlier (review F6)', () => {
    // P2 (24/7): ten 30-second pauses push the target exactly 5 minutes later.
    const created = qa('2026-10-04T10:00:07.721');
    let due = add(created, 480, QATAR, false);
    const original = due.getTime();
    let t = created.getTime() + 13_337;
    for (let i = 0; i < 10; i++) {
      const pausedAt = new Date(t);
      const resumedAt = new Date(t + 30_000);
      due = resumeDueDate(due, pausedAt, resumedAt, QATAR, false);
      t += 30_000 + 61_111;
    }
    expect(due.getTime() - original).toBe(5 * MIN);

    // Business hours: pauses inside opening hours shift it by exactly the paused business time.
    let businessDue = add(qa('2026-10-04T08:00:00.500'), 1080);
    const businessOriginal = businessDue.getTime();
    for (let i = 0; i < 10; i++) {
      const pausedAt = qa(`2026-10-04T09:${String(10 + i * 3).padStart(2, '0')}:00.123`);
      businessDue = resumeDueDate(
        businessDue,
        pausedAt,
        new Date(pausedAt.getTime() + 45_000),
        QATAR,
        true,
      );
    }
    expect(businessDue.getTime() - businessOriginal).toBe(10 * 45_000);
  });
});

describe('computeDueDates with finished pauses (priority change after a PENDING period)', () => {
  const created = qa('2026-10-04T08:00');

  it('replays the pauses like resumeDueDate did, for the new policy', () => {
    const pauses = [
      { from: qa('2026-10-04T09:00'), to: qa('2026-10-04T11:00') },
      { from: qa('2026-10-04T12:00:00.500'), to: qa('2026-10-04T12:30') },
    ];
    for (const policy of [P1, P2, P3, P4]) {
      let expected = add(created, policy.resolveMins, QATAR, policy.businessHoursOnly);
      for (const p of pauses) {
        expected = resumeDueDate(expected, p.from, p.to, QATAR, policy.businessHoursOnly);
      }
      const due = computeDueDates(created, policy, QATAR, pauses);
      expect(due.resolveDueAt).toEqual(expected);
      // The first-reply clock never pauses.
      expect(due.firstReplyDueAt).toEqual(computeDueDates(created, policy, QATAR).firstReplyDueAt);
    }
    // P2 (8 h, 24/7): 2 h + 29 min 59.5 s of pauses.
    expect(computeDueDates(created, P2, QATAR, pauses).resolveDueAt).toEqual(
      qa('2026-10-04T18:29:59.500'),
    );
  });

  it('the credit survives a round trip through another priority (review F1 / P2-CC-2)', () => {
    const pauses = [{ from: qa('2026-10-04T09:00'), to: qa('2026-10-04T11:00') }];
    const p2 = computeDueDates(created, P2, QATAR, pauses).resolveDueAt;
    computeDueDates(created, P1, QATAR, pauses);
    expect(computeDueDates(created, P2, QATAR, pauses).resolveDueAt).toEqual(p2);
    expect(p2).toEqual(qa('2026-10-04T18:00'));
    // 50 h old, paused for 48 h of it, then escalated to P1 (4 h): 2 h of the window are used.
    const old = qa('2026-10-01T08:00');
    const long = [{ from: qa('2026-10-01T10:00'), to: qa('2026-10-03T10:00') }];
    expect(computeDueDates(old, P1, QATAR, long).resolveDueAt).toEqual(qa('2026-10-03T12:00'));
  });

  it('pauses that started after the target had passed add nothing (in any order)', () => {
    const late = { from: qa('2026-10-04T13:00'), to: qa('2026-10-05T13:00') };
    const early = { from: qa('2026-10-04T09:00'), to: qa('2026-10-04T10:00') };
    // P1: 4 h → 12:00, +1 h (early) → 13:00; the late pause starts exactly at the target.
    expect(computeDueDates(created, P1, QATAR, [late, early]).resolveDueAt).toEqual(
      qa('2026-10-04T13:00'),
    );
    // With a longer window the same late pause was inside it and counts.
    // P2: 16:00, +1 h (early) → 17:00; the late pause (4 h before that target) adds its 24 h.
    expect(computeDueDates(created, P2, QATAR, [late, early]).resolveDueAt).toEqual(
      qa('2026-10-05T17:00'),
    );
  });

  it('measures the pauses with the policy’s clock (business vs calendar time)', () => {
    // Paused over the Qatar weekend, Thu 15:00 → Sun 07:30 (90 business minutes, 64.5 h).
    const thursday = qa('2026-10-01T08:00');
    const weekend = [{ from: qa('2026-10-01T15:00'), to: qa('2026-10-04T07:30') }];
    // P3 (1080 business minutes): Mon 08:00 without the pause; 660 minutes were left at 15:00.
    expect(computeDueDates(thursday, P3, QATAR).resolveDueAt).toEqual(qa('2026-10-05T08:00'));
    expect(computeDueDates(thursday, P3, QATAR, weekend).resolveDueAt).toEqual(
      qa('2026-10-05T09:30'),
    );
    // P2 (8 h, 24/7): Thu 16:00 without the pause; 1 h was left at 15:00.
    expect(computeDueDates(thursday, P2, QATAR, weekend).resolveDueAt).toEqual(
      qa('2026-10-04T08:30'),
    );
    // Malformed (to before from) entries are ignored.
    expect(
      computeDueDates(thursday, P2, QATAR, [{ from: weekend[0]!.to, to: weekend[0]!.from }])
        .resolveDueAt,
    ).toEqual(qa('2026-10-01T16:00'));
  });
});

describe('validation', () => {
  const start = qa('2026-10-04T10:00');

  it('an all-closed calendar throws a clear error instead of looping forever', () => {
    const closed: BusinessCalendar = {
      ...QATAR,
      hours: [null, null, null, null, null, null, null],
    };
    expect(() => add(start, 60, closed)).toThrow(/no weekday has business hours/);
    expect(() => between(start, qa('2026-10-05T10:00'), closed)).toThrow(
      /no weekday has business hours/,
    );
    expect(() => add(start, 60, { ...QATAR, hours: [] })).toThrow(/no weekday has business hours/);
    expect(() => computeDueDates(start, P3, closed)).toThrow(/no weekday has business hours/);
  });

  it('missing weekday entries are closed days', () => {
    const sundaysOnly: BusinessCalendar = { ...QATAR, hours: [WORKDAY] };
    expect(add(qa('2026-10-01T15:00'), 60, sundaysOnly)).toEqual(qa('2026-10-04T08:30'));
  });

  it('rejects unknown or missing time zones', () => {
    expect(() => add(start, 60, { ...QATAR, timeZone: 'Mars/Olympus_Mons' })).toThrow(
      /unknown time zone "Mars\/Olympus_Mons"/,
    );
    expect(() => add(start, 60, { ...QATAR, timeZone: '' })).toThrow(/timeZone is required/);
  });

  it('rejects malformed business hours', () => {
    const withSunday = (hours: BusinessDayHours): BusinessCalendar => ({
      ...QATAR,
      hours: [hours, WORKDAY, WORKDAY, WORKDAY, WORKDAY, null, null],
    });
    expect(() => add(start, 1, withSunday({ open: '7:3', close: '16:30' }))).toThrow(
      /Sunday opening time "7:3" is not a valid "HH:mm" time/,
    );
    expect(() => add(start, 1, withSunday({ open: '07:30', close: '25:00' }))).toThrow(/HH:mm/);
    expect(() => add(start, 1, withSunday({ open: '07:30', close: '24:30' }))).toThrow(/HH:mm/);
    expect(() => add(start, 1, withSunday({ open: '07:60', close: '16:30' }))).toThrow(/HH:mm/);
    expect(() => add(start, 1, withSunday({ open: '16:30', close: '07:30' }))).toThrow(
      /Sunday closes at "07:30", which is not after its opening "16:30"/,
    );
    expect(() => add(start, 1, withSunday({ open: '09:00', close: '09:00' }))).toThrow(
      /not after its opening/,
    );
    // "24:00" is a valid closing time (end of the day).
    expect(add(qa('2026-10-04T23:00'), 60, withSunday({ open: '07:30', close: '24:00' }))).toEqual(
      qa('2026-10-05T00:00'),
    );
  });

  it('rejects malformed holidays', () => {
    for (const bad of ['2026-02-30', '2026/10/04', '2026-10-04T00:00:00Z', '']) {
      expect(() => add(start, 1, withHolidays(QATAR, bad)), bad).toThrow(/YYYY-MM-DD/);
    }
  });

  it('rejects negative or non-finite minutes and invalid dates', () => {
    expect(() => add(start, -1)).toThrow(/minutes must be a finite number ≥ 0/);
    expect(() => add(start, Number.NaN)).toThrow(/minutes must be/);
    expect(() => add(start, Number.POSITIVE_INFINITY, QATAR, false)).toThrow(/minutes must be/);
    expect(() => add(new Date('nope'), 1)).toThrow(/start is not a valid Date/);
    expect(() => between(new Date('nope'), start)).toThrow(/from is not a valid Date/);
    expect(() => between(start, new Date(Number.NaN), QATAR, false)).toThrow(
      /to is not a valid Date/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// At-risk instants (Phase 3, decisions D1/D2)

describe('computeSlaTargets: at-risk instants in SLA time', () => {
  const risk = (policy: SlaPolicyLike, atRiskPercent = 75): SlaPolicyRiskLike => ({
    ...policy,
    atRiskPercent,
  });
  const created = qa('2026-10-01T15:00'); // Thursday afternoon

  it('keeps the due dates of computeDueDates', () => {
    for (const policy of [P1, P2, P3, P4]) {
      const targets = computeSlaTargets(created, risk(policy), QATAR);
      expect({
        firstReplyDueAt: targets.firstReplyDueAt,
        resolveDueAt: targets.resolveDueAt,
      }).toEqual(computeDueDates(created, policy, QATAR));
    }
  });

  it('24/7 policies: 75 % of the wall-clock window, to the millisecond', () => {
    const p1 = computeSlaTargets(created, risk(P1), QATAR);
    expect(p1.firstReplyAtRiskAt).toEqual(qa('2026-10-01T15:11:15')); // 11.25 of 15 minutes
    expect(p1.resolveAtRiskAt).toEqual(qa('2026-10-01T18:00')); // 180 of 240 minutes
    const p2 = computeSlaTargets(created, risk(P2), QATAR);
    expect(p2.firstReplyAtRiskAt).toEqual(qa('2026-10-01T15:45'));
    expect(p2.resolveAtRiskAt).toEqual(qa('2026-10-01T21:00'));
    // Weekends and holidays don't matter to a 24/7 clock.
    const friday = qa('2026-10-02T10:00:00.250');
    const onHoliday = computeSlaTargets(friday, risk(P1), withHolidays(QATAR, '2026-10-02'));
    expect(onHoliday.firstReplyAtRiskAt.getTime() - friday.getTime()).toBe(675_000);
  });

  it('business-hours policies count business minutes (nights and the weekend are skipped)', () => {
    // P3: 180 of 240 first-reply minutes: Thu 15:00–16:30 (90) + Sun 07:30–09:00 (90).
    const p3 = computeSlaTargets(created, risk(P3), QATAR);
    expect(p3.firstReplyAtRiskAt).toEqual(qa('2026-10-04T09:00'));
    // 810 of 1080 resolution minutes: Thu 90 + Sun 540 + Mon 180.
    expect(p3.resolveAtRiskAt).toEqual(qa('2026-10-05T10:30'));
    // P4: 405 of 540 (Thu 90 + Sun 315) and 2025 of 2700 (Thu 90 + 3 × 540 + Wed 315).
    const p4 = computeSlaTargets(created, risk(P4), QATAR);
    expect(p4.firstReplyAtRiskAt).toEqual(qa('2026-10-04T12:45'));
    expect(p4.resolveAtRiskAt).toEqual(qa('2026-10-07T12:45'));
    // The instant is exactly that share of the window in business minutes.
    for (const policy of [P3, P4]) {
      const t = computeSlaTargets(created, risk(policy), QATAR);
      expect(between(created, t.firstReplyAtRiskAt)).toBe((policy.firstReplyMins * 3) / 4);
      expect(between(created, t.resolveAtRiskAt)).toBe((policy.resolveMins * 3) / 4);
      expect(t.firstReplyAtRiskAt.getTime()).toBeLessThan(t.firstReplyDueAt.getTime());
      expect(t.resolveAtRiskAt.getTime()).toBeLessThan(t.resolveDueAt.getTime());
    }
  });

  it('holidays are skipped like in the due dates', () => {
    // Sunday 4 Oct is a holiday: the P3 first reply resumes on Monday.
    const p3 = computeSlaTargets(created, risk(P3), withHolidays(QATAR, '2026-10-04'));
    expect(p3.firstReplyAtRiskAt).toEqual(qa('2026-10-05T09:00'));
    expect(p3.firstReplyDueAt).toEqual(qa('2026-10-05T10:00'));
  });

  it('a clock started outside business hours measures from the next opening', () => {
    const saturday = qa('2026-10-03T20:00');
    const p3 = computeSlaTargets(saturday, risk(P3), QATAR);
    expect(p3.firstReplyAtRiskAt).toEqual(qa('2026-10-04T10:30')); // Sun 07:30 + 180
  });

  it('honours the policy percentage (0 = clock start, 100 = the due date)', () => {
    const p1Half = computeSlaTargets(created, risk(P1, 50), QATAR);
    expect(p1Half.firstReplyAtRiskAt).toEqual(qa('2026-10-01T15:07:30'));
    expect(p1Half.resolveAtRiskAt).toEqual(qa('2026-10-01T17:00'));
    const full = computeSlaTargets(created, risk(P3, 100), QATAR);
    expect(full.firstReplyAtRiskAt).toEqual(full.firstReplyDueAt);
    expect(full.resolveAtRiskAt).toEqual(full.resolveDueAt);
    const zero = computeSlaTargets(qa('2026-10-03T20:00'), risk(P3, 0), QATAR);
    expect(zero.firstReplyAtRiskAt).toEqual(qa('2026-10-04T07:30'));
    // An odd percentage rounds to the millisecond (33 % of 15 min = 4 min 57 s).
    const odd = computeSlaTargets(created, risk(P1, 33), QATAR);
    expect(odd.firstReplyAtRiskAt.getTime() - created.getTime()).toBe(297_000);
  });

  it('rejects a percentage outside 0–100', () => {
    for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeSlaTargets(created, risk(P1, bad), QATAR), String(bad)).toThrow(
        /atRiskPercent must be a number from 0 to 100/,
      );
    }
  });

  it('pauses shift the resolution instant like the due date; a passed instant stays', () => {
    const morning = qa('2026-10-04T08:00');
    // P2 (24/7): at risk 14:00, due 16:00.
    const plain = computeSlaTargets(morning, risk(P2), QATAR);
    expect([plain.resolveAtRiskAt, plain.resolveDueAt]).toEqual([
      qa('2026-10-04T14:00'),
      qa('2026-10-04T16:00'),
    ]);
    // A 2 h pause before both: both move by 2 h. The first-reply instant never pauses.
    const early = computeSlaTargets(morning, risk(P2), QATAR, [
      { from: qa('2026-10-04T09:00'), to: qa('2026-10-04T11:00') },
    ]);
    expect([early.resolveAtRiskAt, early.resolveDueAt]).toEqual([
      qa('2026-10-04T16:00'),
      qa('2026-10-04T18:00'),
    ]);
    expect(early.firstReplyAtRiskAt).toEqual(plain.firstReplyAtRiskAt);
    // A pause that starts after the instant had passed (but before the due date): the instant
    // stays, the due date moves.
    const late = computeSlaTargets(morning, risk(P2), QATAR, [
      { from: qa('2026-10-04T15:00'), to: qa('2026-10-04T17:00') },
    ]);
    expect([late.resolveAtRiskAt, late.resolveDueAt]).toEqual([
      qa('2026-10-04T14:00'),
      qa('2026-10-04T18:00'),
    ]);
  });

  it('business-hours pauses are measured in business time (weekend pause)', () => {
    // P3 from Thu 08:00: resolution at risk after 810 business minutes = Sun 12:30. Paused
    // Thu 15:00 → Sun 07:30 with 390 of those minutes left: at risk Sun 14:00.
    const thursday = qa('2026-10-01T08:00');
    expect(computeSlaTargets(thursday, risk(P3), QATAR).resolveAtRiskAt).toEqual(
      qa('2026-10-04T12:30'),
    );
    const weekend = [{ from: qa('2026-10-01T15:00'), to: qa('2026-10-04T07:30') }];
    const paused = computeSlaTargets(thursday, risk(P3), QATAR, weekend);
    expect(paused.resolveAtRiskAt).toEqual(qa('2026-10-04T14:00'));
    expect(paused.resolveDueAt).toEqual(qa('2026-10-05T09:30'));
  });

  it('resumeDueDate moves a stored instant exactly like replaying the pause (PENDING resume)', () => {
    const morning = qa('2026-10-04T08:00');
    const pause = { from: qa('2026-10-04T09:00:00.500'), to: qa('2026-10-05T10:15:30.125') };
    for (const policy of [P1, P2, P3, P4]) {
      const before = computeSlaTargets(morning, risk(policy), QATAR);
      const resumed = resumeDueDate(
        before.resolveAtRiskAt,
        pause.from,
        pause.to,
        QATAR,
        policy.businessHoursOnly,
      );
      expect(resumed).toEqual(
        computeSlaTargets(morning, risk(policy), QATAR, [pause]).resolveAtRiskAt,
      );
    }
  });

  it('priority replay: the instants survive a round trip through another priority', () => {
    const old = qa('2026-10-01T08:00');
    const pauses = [{ from: qa('2026-10-01T10:00'), to: qa('2026-10-03T10:00') }];
    const p2 = computeSlaTargets(old, risk(P2), QATAR, pauses);
    computeSlaTargets(old, risk(P1), QATAR, pauses);
    expect(computeSlaTargets(old, risk(P2), QATAR, pauses)).toEqual(p2);
    // 50 h old, paused 48 h of it, raised to P1 (4 h): at risk after 3 h of SLA time — 2 h
    // were used before the pause, so 1 h after it ended; due 1 h later.
    const p1 = computeSlaTargets(old, risk(P1), QATAR, pauses);
    expect(p1.resolveAtRiskAt).toEqual(qa('2026-10-03T11:00'));
    expect(p1.resolveDueAt).toEqual(qa('2026-10-03T12:00'));
    // …and the first-reply instant is long past (it never pauses).
    expect(p1.firstReplyAtRiskAt).toEqual(qa('2026-10-01T08:11:15'));
  });

  it('matches a brute-force oracle for random Qatar business-hours cases', () => {
    const random = seededRandom(20260929);
    for (let i = 0; i < 40; i++) {
      const start = new Date(YEAR_2026_START + Math.floor(random() * 360 * 24 * 60) * MIN);
      const minutes = 1 + Math.floor(random() * 3000);
      const percent = 1 + Math.floor(random() * 99);
      const policy: SlaPolicyRiskLike = {
        firstReplyMins: minutes,
        resolveMins: minutes,
        businessHoursOnly: true,
        atRiskPercent: percent,
      };
      const t = computeSlaTargets(start, policy, QATAR);
      const shareMs = Math.round((minutes * percent * MIN) / 100);
      // Whole minutes of the share via the oracle, then the remaining milliseconds inside hours.
      const whole = Math.floor(shareMs / MIN);
      const expected = oracleAdd(start.getTime(), whole, new Set());
      const rest = shareMs - whole * MIN;
      const label = `${start.toISOString()} ${minutes} ${percent}%`;
      if (rest === 0) expect(t.firstReplyAtRiskAt.getTime(), label).toBe(expected);
      else expect(between(start, t.firstReplyAtRiskAt), label).toBe(whole);
      expect(t.resolveAtRiskAt, label).toEqual(t.firstReplyAtRiskAt);
    }
  });
});
