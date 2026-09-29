import { describe, expect, it } from 'vitest';
import {
  clientCanSetStatus,
  isSlaAtRiskOrBreached,
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
    expect(s.clock.atRisk).toBe(false); // 10 of 15 min left: more than half
  });

  it('flags at-risk below min(1 h, half the window) and overdue after the due time', () => {
    const risky = slaState(base({ firstReplyDueAt: new Date(NOW + 4 * MIN) }), NOW); // 4 of 9 min left
    expect(risky.kind === 'firstReply' && risky.clock.atRisk).toBe(true);
    const late = base({ firstReplyDueAt: new Date(NOW - 6 * MIN) });
    const overdue = slaState(late, NOW);
    expect(overdue.kind === 'firstReply' && overdue.clock.overdue).toBe(true);
    expect(isSlaAtRiskOrBreached(late, NOW)).toBe(true);
  });

  it('shows Replied with the resolution clock after the first reply', () => {
    const s = slaState(base({ firstRepliedAt: new Date(NOW - MIN) }), NOW);
    expect(s.kind).toBe('replied');
    if (s.kind === 'replied') expect(s.resolution?.remainingMs).toBe(235 * MIN);
  });

  it('PENDING after the first reply is paused (nothing runs); solved stops everything', () => {
    const replied = { firstRepliedAt: new Date(NOW - MIN) };
    expect(slaState(base({ status: 'PENDING', ...replied }), NOW).kind).toBe('paused');
    expect(slaState(base({ status: 'SOLVED' }), NOW).kind).toBe('done');
    // The resolution clock is stopped: an overdue resolution target is not "at risk" meanwhile.
    expect(
      isSlaAtRiskOrBreached(
        base({ status: 'PENDING', ...replied, resolveDueAt: new Date(NOW - 5 * MIN) }),
        NOW,
      ),
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
