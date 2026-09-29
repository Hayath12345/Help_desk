import { describe, expect, it } from 'vitest';
import {
  TYPING_BURST,
  TYPING_MIN_INTERVAL_MS,
  allowTyping,
  newTypingState,
} from '../realtime/tickets.ts';
import { ticketRefWhere } from './ticket-access.ts';
import { PREVIEW_MAX_CHARS, messagePreview } from './ticket-dto.ts';
import { encodeCursor } from './ticket-query.ts';
import { slaPausesOf, statusChangeData } from './ticket-state.ts';
import { changedKeys } from './tickets.service.ts';
import type { SlaMath } from './sla.ts';

describe('messagePreview', () => {
  it('collapses whitespace and trims', () => {
    expect(messagePreview('  a\n\n b\t c  ')).toBe('a b c');
    expect(messagePreview(null)).toBe('');
  });

  it('caps at 140 characters (code points), with an ellipsis', () => {
    const long = '😀'.repeat(200);
    const out = messagePreview(long);
    expect([...out]).toHaveLength(PREVIEW_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(messagePreview('x'.repeat(140))).toBe('x'.repeat(140));
  });
});

describe('ticketRefWhere', () => {
  it('uuid, LG number, bare number; anything else null', () => {
    const id = '0b0f9a0e-1c1d-4f7b-9d2a-3b4c5d6e7f80';
    expect(ticketRefWhere(id.toUpperCase())).toEqual({ id });
    expect(ticketRefWhere('LG-4817')).toEqual({ number: 4817 });
    expect(ticketRefWhere(' lg-12 ')).toEqual({ number: 12 });
    expect(ticketRefWhere('4817')).toEqual({ number: 4817 });
    expect(ticketRefWhere('9999999999')).toBeNull(); // beyond int4
    expect(ticketRefWhere('LG-')).toBeNull();
    expect(ticketRefWhere("1' OR 1=1")).toBeNull();
  });
});

describe('encodeCursor', () => {
  it('stays within the 200-character query limit', () => {
    const cursor = encodeCursor({
      s: 'sla',
      k: [1, 1, 1, 8_640_000_000_000, 8_640_000_000_000, '0b0f9a0e-1c1d-4f7b-9d2a-3b4c5d6e7f80'],
    });
    expect(cursor.length).toBeLessThanOrEqual(200);
  });
});

describe('allowTyping (per-socket throttle)', () => {
  it('forwards a "start" at most once per interval per ticket; "stop" always', () => {
    const state = newTypingState();
    expect(allowTyping(state, 't1', true, 1000)).toBe(true);
    expect(allowTyping(state, 't1', true, 1000 + TYPING_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(allowTyping(state, 't2', true, 1001)).toBe(true);
    expect(allowTyping(state, 't1', false, 1002)).toBe(true);
    expect(allowTyping(state, 't1', true, 1003)).toBe(true); // a new start after a stop
    expect(allowTyping(state, 't1', true, 1003 + TYPING_MIN_INTERVAL_MS)).toBe(true);
  });

  it('caps the burst per window', () => {
    const state = newTypingState();
    let allowed = 0;
    for (let i = 0; i < TYPING_BURST.max * 2; i++) {
      if (allowTyping(state, `t${i}`, false, 5000)) allowed += 1;
    }
    expect(allowed).toBe(TYPING_BURST.max);
    expect(allowTyping(state, 'late', false, 5000 + TYPING_BURST.windowMs)).toBe(true);
  });
});

describe('statusChangeData', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  const math: SlaMath = {
    computeDueDates: () => {
      throw new Error('unused');
    },
    resumeDueDate: (due, paused, resumed) =>
      new Date(due.getTime() + (resumed.getTime() - paused.getTime())),
  };
  const calendar = async () => ({ timeZone: 'UTC', hours: [], holidays: [] });
  const base = {
    now,
    resolveDueAt: new Date('2026-09-24T12:00:00Z'),
    slaPausedAt: null,
    slaPauses: [],
    businessHoursOnly: false,
    calendar,
    math,
  };

  it('SOLVED stamps solvedAt; leaving SOLVED clears it', async () => {
    expect(await statusChangeData({ ...base, from: 'OPEN', to: 'SOLVED' })).toEqual({
      status: 'SOLVED',
      solvedAt: now,
    });
    expect(await statusChangeData({ ...base, from: 'SOLVED', to: 'OPEN' })).toEqual({
      status: 'OPEN',
      solvedAt: null,
    });
  });

  it('PENDING pauses; leaving PENDING resumes the resolution clock', async () => {
    expect(await statusChangeData({ ...base, from: 'OPEN', to: 'PENDING' })).toEqual({
      status: 'PENDING',
      slaPausedAt: now,
    });
    const pausedAt = new Date('2026-09-24T09:00:00Z');
    expect(
      await statusChangeData({ ...base, from: 'PENDING', to: 'SOLVED', slaPausedAt: pausedAt }),
    ).toEqual({
      status: 'SOLVED',
      solvedAt: now,
      slaPausedAt: null,
      slaPauses: [{ from: pausedAt.toISOString(), to: now.toISOString() }],
      resolveDueAt: new Date('2026-09-24T13:00:00Z'),
    });
  });

  it('each finished pause is appended to slaPauses (malformed stored entries are dropped)', async () => {
    const earlier = { from: '2026-09-23T08:00:00.000Z', to: '2026-09-23T09:30:00.000Z' };
    const pausedAt = new Date('2026-09-24T09:00:00Z');
    const data = await statusChangeData({
      ...base,
      from: 'PENDING',
      to: 'OPEN',
      slaPausedAt: pausedAt,
      slaPauses: [earlier, { from: 'nope' }, 42],
    });
    expect(data.slaPauses).toEqual([
      earlier,
      { from: pausedAt.toISOString(), to: now.toISOString() },
    ]);
    expect(slaPausesOf(data.slaPauses as never)).toEqual([
      { from: new Date(earlier.from), to: new Date(earlier.to) },
      { from: pausedAt, to: now },
    ]);
    // Entering PENDING, or a change that never paused, records nothing.
    expect(await statusChangeData({ ...base, from: 'OPEN', to: 'PENDING' })).not.toHaveProperty(
      'slaPauses',
    );
    expect(slaPausesOf(null)).toEqual([]);
    expect(slaPausesOf({ from: earlier.from } as never)).toEqual([]);
  });
});

describe('changedKeys (CUSTOM_FIELDS_CHANGED meta)', () => {
  it('lists added, changed and removed keys, ignoring key order inside values', () => {
    expect(changedKeys({}, {})).toEqual([]);
    expect(changedKeys({ a: 1, b: ['x', 'y'] }, { b: ['x', 'y'], a: 1 })).toEqual([]);
    expect(changedKeys({ o: { p: 1, q: 2 } }, { o: { q: 2, p: 1 } })).toEqual([]);
    expect(changedKeys({ a: 1, b: 'x', c: true }, { a: 2, c: true, d: 'new' })).toEqual([
      'a',
      'b',
      'd',
    ]);
  });
});
