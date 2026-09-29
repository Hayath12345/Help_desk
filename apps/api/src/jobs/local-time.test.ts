import { describe, expect, it } from 'vitest';
import type { BusinessCalendar } from '@loons/shared';
import {
  digestWindow,
  hhmmOr,
  isBusinessDay,
  localDate,
  previousBusinessDay,
  zonedInstant,
} from './local-time.ts';

// The P4 digest window (D9) in the business time zone: business days only (not Fri / Sat, not
// holidays), from the previous business day's digest time to today's.

const qatar: BusinessCalendar = {
  timeZone: 'Asia/Qatar',
  hours: [0, 1, 2, 3, 4, 5, 6].map((d) => (d <= 4 ? { open: '07:30', close: '16:30' } : null)),
  holidays: ['2026-12-17', '2026-12-18'],
};

describe('local time helpers', () => {
  it('local dates and wall-clock instants in a zone (Qatar is UTC+3; London has DST)', () => {
    expect(localDate(new Date('2026-09-29T21:30:00Z'), 'Asia/Qatar')).toBe('2026-09-30');
    expect(zonedInstant('2026-09-30', '07:30', 'Asia/Qatar').toISOString()).toBe(
      '2026-09-30T04:30:00.000Z',
    );
    expect(zonedInstant('2026-07-01', '07:30', 'Europe/London').toISOString()).toBe(
      '2026-07-01T06:30:00.000Z',
    );
    expect(zonedInstant('2026-12-01', '07:30', 'Europe/London').toISOString()).toBe(
      '2026-12-01T07:30:00.000Z',
    );
    expect(() => zonedInstant('2026-12-01', '7:30', 'Asia/Qatar')).toThrow(RangeError);
    expect(hhmmOr('08:15', '07:30')).toBe('08:15');
    expect(hhmmOr('25:00', '07:30')).toBe('07:30');
    expect(hhmmOr(730, '07:30')).toBe('07:30');
  });

  it('business days: Sunday–Thursday, holidays excluded', () => {
    expect(isBusinessDay('2026-10-04', qatar)).toBe(true); // Sunday
    expect(isBusinessDay('2026-10-08', qatar)).toBe(true); // Thursday
    expect(isBusinessDay('2026-10-09', qatar)).toBe(false); // Friday
    expect(isBusinessDay('2026-10-10', qatar)).toBe(false); // Saturday
    expect(isBusinessDay('2026-12-17', qatar)).toBe(false); // holiday (Thursday)
    expect(previousBusinessDay('2026-10-04', qatar)).toBe('2026-10-01'); // Sun → Thu
    expect(previousBusinessDay('2026-12-20', qatar)).toBe('2026-12-16'); // skips Thu holiday + weekend
  });

  it('digest windows: previous business day 07:30 → today 07:30; none on weekends / holidays', () => {
    const at = (iso: string) => digestWindow(new Date(iso), qatar, '07:30');
    // Tuesday: since Monday's digest.
    expect(at('2026-09-29T04:30:05Z')).toEqual({
      date: '2026-09-29',
      start: new Date('2026-09-28T04:30:00Z'),
      end: new Date('2026-09-29T04:30:00Z'),
    });
    // Sunday: covers Thursday 07:30 → Sunday 07:30 (the weekend's tickets).
    expect(at('2026-10-04T04:30:05Z')).toMatchObject({
      start: new Date('2026-10-01T04:30:00Z'),
      end: new Date('2026-10-04T04:30:00Z'),
    });
    // After the holiday (Thu 17 Dec) and the weekend: since Wednesday.
    expect(at('2026-12-20T04:30:05Z')).toMatchObject({
      start: new Date('2026-12-16T04:30:00Z'),
    });
    expect(at('2026-10-09T04:30:05Z')).toBeNull(); // Friday
    expect(at('2026-10-10T04:30:05Z')).toBeNull(); // Saturday
    expect(at('2026-12-17T04:30:05Z')).toBeNull(); // holiday
    // The configured time is used.
    expect(digestWindow(new Date('2026-09-29T06:00:00Z'), qatar, '09:00')?.end).toEqual(
      new Date('2026-09-29T06:00:00Z'),
    );
  });
});
