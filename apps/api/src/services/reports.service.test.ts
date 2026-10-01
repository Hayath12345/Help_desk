import { describe, expect, it } from 'vitest';
import { periodStart } from './reports.service.ts';

// Reports periods (F11): the last N local days in business.timezone, today included — the period
// starts at local midnight N − 1 days before today, whatever the UTC date is.

describe('periodStart', () => {
  it('Asia/Qatar (UTC+3): local midnight, across the UTC day boundary', () => {
    // 23:59:59.999 in Doha on 30 September.
    const late = new Date('2026-09-30T20:59:59.999Z');
    expect(periodStart(late, 7, 'Asia/Qatar').toISOString()).toBe('2026-09-23T21:00:00.000Z');
    expect(periodStart(late, 1, 'Asia/Qatar').toISOString()).toBe('2026-09-29T21:00:00.000Z');
    // A millisecond later it is 1 October there: the period moves by a day.
    const midnight = new Date('2026-09-30T21:00:00.000Z');
    expect(periodStart(midnight, 7, 'Asia/Qatar').toISOString()).toBe('2026-09-24T21:00:00.000Z');
    expect(periodStart(midnight, 30, 'Asia/Qatar').toISOString()).toBe('2026-09-01T21:00:00.000Z');
    expect(periodStart(midnight, 90, 'Asia/Qatar').toISOString()).toBe('2026-07-03T21:00:00.000Z');
  });

  it('zones with daylight saving time use each day’s own offset', () => {
    // London: BST (UTC+1) until 25 October 2026, then GMT.
    const now = new Date('2026-11-01T12:00:00.000Z');
    expect(periodStart(now, 7, 'Europe/London').toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(periodStart(now, 30, 'Europe/London').toISOString()).toBe('2026-10-02T23:00:00.000Z');
    // UTC−7 / −8.
    const la = new Date('2026-03-10T06:00:00.000Z'); // 9 March, 23:00 PDT
    expect(periodStart(la, 7, 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-03T08:00:00.000Z',
    );
  });

  it('a first day whose midnight the clocks skip starts at its first instant', () => {
    // America/Santiago skips 00:00–01:00 on 6 September 2026: the period starts at 01:00 local
    // (UTC−3), not at 23:00 on 5 September.
    const now = new Date('2026-09-10T15:00:00.000Z');
    expect(periodStart(now, 5, 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(periodStart(now, 6, 'America/Santiago').toISOString()).toBe('2026-09-05T04:00:00.000Z');
  });
});
