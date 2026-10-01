import { describe, expect, it } from 'vitest';
import {
  TICKET_LIST_SORTS,
  TICKET_SORTS,
  clientCanSetStatus,
  hasBreachedSla,
  isSlaAtRiskOrBreached,
  isSlaOverdue,
  slaState,
  staffCanSetStatus,
  statusAfterMessage,
  type SlaFields,
} from './tickets.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-04T08:00:00Z');

const base = (over: Partial<SlaFields>): SlaFields => ({
  status: 'OPEN',
  priority: 'P1',
  createdAt: new Date(NOW - 5 * MIN),
  firstReplyDueAt: new Date(NOW + 10 * MIN),
  resolveDueAt: new Date(NOW + 235 * MIN),
  // 75 % of each window (15 min / 240 min from createdAt), as computeSlaTargets stores them.
  firstReplyAtRiskAt: new Date(NOW + 6.25 * MIN),
  resolveAtRiskAt: new Date(NOW + 175 * MIN),
  firstRepliedAt: null,
  slaPausedAt: null,
  slaBreached: false,
  ...over,
});

describe('status transitions', () => {
  it('clients solve active tickets and reopen solved ones only', () => {
    expect(clientCanSetStatus('OPEN', 'SOLVED')).toBe(true);
    expect(clientCanSetStatus('PENDING', 'SOLVED')).toBe(true);
    expect(clientCanSetStatus('SOLVED', 'OPEN')).toBe(true);
    expect(clientCanSetStatus('CLOSED', 'OPEN')).toBe(false);
    expect(clientCanSetStatus('OPEN', 'PENDING')).toBe(false);
  });

  it('staff never touch CLOSED tickets or set CLOSED by hand', () => {
    expect(staffCanSetStatus('CLOSED', 'OPEN')).toBe(false);
    expect(staffCanSetStatus('SOLVED', 'CLOSED')).toBe(false);
    expect(staffCanSetStatus('OPEN', 'OPEN')).toBe(false);
    expect(staffCanSetStatus('PENDING', 'OPEN')).toBe(true);
  });

  it('messages move the status as the spec describes', () => {
    const agentReply = { author: 'staff', type: 'PUBLIC' } as const;
    expect(statusAfterMessage({ current: 'NEW', ...agentReply })).toBe('PENDING');
    expect(statusAfterMessage({ current: 'OPEN', ...agentReply, andSolve: true })).toBe('SOLVED');
    expect(statusAfterMessage({ current: 'PENDING', ...agentReply })).toBeNull();
    expect(statusAfterMessage({ current: 'NEW', author: 'staff', type: 'INTERNAL' })).toBe('OPEN');
    expect(
      statusAfterMessage({ current: 'PENDING', author: 'staff', type: 'INTERNAL' }),
    ).toBeNull();
    expect(statusAfterMessage({ current: 'SOLVED', author: 'client', type: 'PUBLIC' })).toBe(
      'OPEN',
    );
    expect(statusAfterMessage({ current: 'PENDING', author: 'client', type: 'PUBLIC' })).toBe(
      'OPEN',
    );
    expect(statusAfterMessage({ current: 'NEW', author: 'client', type: 'PUBLIC' })).toBeNull();
  });
});

describe('slaState', () => {
  it('counts down to the first reply until it is sent', () => {
    const s = slaState(base({}), NOW);
    expect(s.kind).toBe('firstReply');
    if (s.kind !== 'firstReply') return;
    expect(s.clock.remainingMs).toBe(10 * MIN);
    expect(s.clock.windowMs).toBe(15 * MIN);
    expect(s.clock.atRisk).toBe(false); // the at-risk instant (75 % = 11.25 min) is ahead
  });

  it('D1/D2: at risk from the stored instant on, overdue after the due time', () => {
    const at = base({ firstReplyAtRiskAt: new Date(NOW) });
    const risky = slaState(at, NOW);
    expect(risky.kind === 'firstReply' && risky.clock.atRisk).toBe(true);
    expect(isSlaAtRiskOrBreached(at, NOW)).toBe(true);
    // One millisecond before the instant: not yet.
    const before = slaState(base({ firstReplyAtRiskAt: new Date(NOW + 1) }), NOW);
    expect(before.kind === 'firstReply' && before.clock.atRisk).toBe(false);
    expect(isSlaAtRiskOrBreached(base({ firstReplyAtRiskAt: new Date(NOW + 1) }), NOW)).toBe(false);
    // ISO strings (the DTO form) work the same.
    const iso = base({ firstReplyAtRiskAt: new Date(NOW - MIN).toISOString() });
    expect(isSlaAtRiskOrBreached(iso, NOW)).toBe(true);

    const late = base({ firstReplyDueAt: new Date(NOW - 6 * MIN) });
    const overdue = slaState(late, NOW);
    expect(overdue.kind === 'firstReply' && overdue.clock.overdue).toBe(true);
    // Overdue is not "at risk" any more (the tone is overdue), but stays in the view.
    expect(overdue.kind === 'firstReply' && overdue.clock.atRisk).toBe(false);
    expect(isSlaAtRiskOrBreached(late, NOW)).toBe(true);
  });

  it('the Phase 2 rule (less than min(1 h, 50 %) left) no longer decides anything', () => {
    // 4 of 9 minutes left (old rule: at risk), but the stored instant is still ahead.
    const soon = base({
      firstReplyDueAt: new Date(NOW + 4 * MIN),
      firstReplyAtRiskAt: new Date(NOW + 2 * MIN),
    });
    expect(isSlaAtRiskOrBreached(soon, NOW)).toBe(false);
    // A business-hours window: 20 wall-clock hours left (old rule: fine), but 75 % of the
    // business minutes have elapsed, so the stored instant has passed.
    const business = base({
      priority: 'P3',
      createdAt: new Date(NOW - 50 * 60 * MIN),
      firstReplyDueAt: new Date(NOW + 20 * 60 * MIN),
      firstReplyAtRiskAt: new Date(NOW - 30 * MIN),
    });
    const s = slaState(business, NOW);
    expect(s.kind === 'firstReply' && s.clock.atRisk).toBe(true);
    expect(isSlaAtRiskOrBreached(business, NOW)).toBe(true);
  });

  it('a missing instant is never "at risk"; overdue still comes from the due date', () => {
    const unknown = base({ firstReplyAtRiskAt: null, firstReplyDueAt: new Date(NOW + MIN) });
    const s = slaState(unknown, NOW);
    expect(s.kind === 'firstReply' && s.clock.atRisk).toBe(false);
    expect(isSlaAtRiskOrBreached(unknown, NOW)).toBe(false);
    const late = base({ firstReplyAtRiskAt: null, firstReplyDueAt: new Date(NOW - MIN) });
    expect(isSlaAtRiskOrBreached(late, NOW)).toBe(true);
    // Resolution too.
    const replied = base({
      firstRepliedAt: new Date(NOW - MIN),
      resolveAtRiskAt: null,
      resolveDueAt: new Date(NOW + MIN),
    });
    expect(isSlaAtRiskOrBreached(replied, NOW)).toBe(false);
  });

  it('shows Replied with the resolution clock (and its own instant) after the first reply', () => {
    const replied = { firstRepliedAt: new Date(NOW - MIN) };
    const s = slaState(base(replied), NOW);
    expect(s.kind).toBe('replied');
    if (s.kind === 'replied') {
      expect(s.resolution?.remainingMs).toBe(235 * MIN);
      expect(s.resolution?.atRisk).toBe(false);
    }
    // The first-reply instant no longer matters once replied.
    expect(isSlaAtRiskOrBreached(base({ ...replied, firstReplyAtRiskAt: new Date(0) }), NOW)).toBe(
      false,
    );
    const risky = base({ ...replied, resolveAtRiskAt: new Date(NOW - 1) });
    const r = slaState(risky, NOW);
    expect(r.kind === 'replied' && r.resolution?.atRisk).toBe(true);
    expect(isSlaAtRiskOrBreached(risky, NOW)).toBe(true);
    // Unanswered tickets carry the resolution clock next to the first-reply one.
    const both = slaState(base({ resolveAtRiskAt: new Date(NOW - 1) }), NOW);
    expect(both.kind === 'firstReply' && both.resolution?.atRisk).toBe(true);
  });

  it('PENDING after the first reply is paused (nothing runs); solved stops everything', () => {
    const replied = { firstRepliedAt: new Date(NOW - MIN) };
    expect(slaState(base({ status: 'PENDING', ...replied }), NOW).kind).toBe('paused');
    expect(slaState(base({ status: 'SOLVED' }), NOW).kind).toBe('done');
    // The resolution clock is stopped: an overdue / at-risk resolution target is not "at risk".
    expect(
      isSlaAtRiskOrBreached(
        base({
          status: 'PENDING',
          ...replied,
          resolveDueAt: new Date(NOW - 5 * MIN),
          resolveAtRiskAt: new Date(NOW - 60 * MIN),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isSlaAtRiskOrBreached(base({ status: 'CLOSED', firstReplyDueAt: new Date(0) }), NOW),
    ).toBe(false);
  });

  it('PENDING without a first reply keeps the first-reply clock running (review DA-3)', () => {
    const s = slaState(base({ status: 'PENDING' }), NOW);
    expect(s).toEqual({
      kind: 'firstReply',
      clock: { remainingMs: 10 * MIN, windowMs: 15 * MIN, overdue: false, atRisk: false },
      resolution: null,
      resolutionPaused: true,
    });
    // At risk by its stored instant while PENDING, too.
    expect(
      isSlaAtRiskOrBreached(base({ status: 'PENDING', firstReplyAtRiskAt: new Date(NOW) }), NOW),
    ).toBe(true);
    // Overdue (e.g. a note with the "Awaiting client access" macro): still in "SLA at risk".
    const late = base({ status: 'PENDING', firstReplyDueAt: new Date(NOW - 6 * MIN) });
    const overdue = slaState(late, NOW);
    expect(overdue.kind === 'firstReply' && overdue.clock.overdue).toBe(true);
    expect(isSlaAtRiskOrBreached(late, NOW)).toBe(true);
    // No first-reply target at all: nothing runs while PENDING.
    expect(slaState(base({ status: 'PENDING', firstReplyDueAt: null }), NOW).kind).toBe('paused');
    // Running tickets keep the resolution clock next to the first-reply countdown.
    const open = slaState(base({}), NOW);
    expect(open.kind === 'firstReply' && open.resolution?.remainingMs).toBe(235 * MIN);
    expect(open).not.toHaveProperty('resolutionPaused');
  });
});

describe('isSlaOverdue / hasBreachedSla (Reports "SLA breached", Phase 5 F10)', () => {
  it('overdue: the running clock past its due date (first reply also while PENDING)', () => {
    expect(isSlaOverdue(base({}), NOW)).toBe(false);
    expect(isSlaOverdue(base({ firstReplyDueAt: new Date(NOW - MIN) }), NOW)).toBe(true);
    // At risk is not overdue.
    expect(isSlaOverdue(base({ firstReplyAtRiskAt: new Date(NOW - MIN) }), NOW)).toBe(false);
    // An unanswered PENDING ticket keeps its first-reply clock.
    expect(
      isSlaOverdue(base({ status: 'PENDING', firstReplyDueAt: new Date(NOW - MIN) }), NOW),
    ).toBe(true);
    const replied = { firstRepliedAt: new Date(NOW - 2 * MIN) };
    expect(isSlaOverdue(base({ ...replied, resolveDueAt: new Date(NOW - MIN) }), NOW)).toBe(true);
    // PENDING after the reply: the resolution clock is paused.
    expect(
      isSlaOverdue(base({ ...replied, status: 'PENDING', resolveDueAt: new Date(NOW - MIN) }), NOW),
    ).toBe(false);
    expect(isSlaOverdue(base({ ...replied, resolveDueAt: null }), NOW)).toBe(false);
    expect(
      isSlaOverdue(base({ status: 'SOLVED', firstReplyDueAt: new Date(NOW - MIN) }), NOW),
    ).toBe(false);
  });

  it('breached: active and (the stored flag or overdue now)', () => {
    expect(hasBreachedSla(base({}), NOW)).toBe(false);
    expect(hasBreachedSla(base({ slaBreached: true }), NOW)).toBe(true);
    expect(hasBreachedSla(base({ firstReplyDueAt: new Date(NOW - MIN) }), NOW)).toBe(true);
    // Flagged, but paused or done tickets: only the flag counts, and only while active.
    expect(
      hasBreachedSla(
        base({ status: 'PENDING', firstRepliedAt: new Date(NOW - 2 * MIN), slaBreached: true }),
        NOW,
      ),
    ).toBe(true);
    expect(hasBreachedSla(base({ status: 'SOLVED', slaBreached: true }), NOW)).toBe(false);
    expect(hasBreachedSla(base({ status: 'CLOSED', slaBreached: true }), NOW)).toBe(false);
  });

  it('breached: a target met late counts even when the worker never flagged it', () => {
    // First reply sent after its due date (between two SLA scans, or with the worker down).
    const late = { firstReplyDueAt: new Date(NOW - 3 * MIN), firstRepliedAt: new Date(NOW - MIN) };
    expect(hasBreachedSla(base(late), NOW)).toBe(true);
    expect(
      hasBreachedSla(base({ ...late, status: 'PENDING', slaPausedAt: new Date(NOW) }), NOW),
    ).toBe(true);
    // On time: not breached.
    expect(
      hasBreachedSla(
        base({ firstReplyDueAt: new Date(NOW - MIN), firstRepliedAt: new Date(NOW - 3 * MIN) }),
        NOW,
      ),
    ).toBe(false);
    // Paused (PENDING) after the resolution due date passed: breached; paused before it: not.
    const replied = { firstRepliedAt: new Date(NOW - 10 * MIN), status: 'PENDING' as const };
    expect(
      hasBreachedSla(
        base({
          ...replied,
          resolveDueAt: new Date(NOW - 5 * MIN),
          slaPausedAt: new Date(NOW - 2 * MIN),
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      hasBreachedSla(
        base({
          ...replied,
          resolveDueAt: new Date(NOW - 2 * MIN),
          slaPausedAt: new Date(NOW - 5 * MIN),
        }),
        NOW,
      ),
    ).toBe(false);
    // Done tickets never count.
    expect(hasBreachedSla(base({ ...late, status: 'SOLVED' }), NOW)).toBe(false);
  });
});

describe('ticket list sorts', () => {
  it('the Inbox toggle keeps its two sorts; GET /tickets also takes priority', () => {
    expect(TICKET_SORTS).toEqual(['sla', 'recent']);
    expect(TICKET_LIST_SORTS).toEqual(['sla', 'recent', 'priority']);
  });
});
