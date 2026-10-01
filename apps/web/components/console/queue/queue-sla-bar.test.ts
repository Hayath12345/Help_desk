import type { SlaFields } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import { queueSlaBar } from './queue-row';

const NOW = Date.parse('2026-09-30T10:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A P2 ticket created 20 minutes ago with a 60-minute first-reply window. */
function ticket(patch: Partial<SlaFields> = {}): SlaFields {
  const created = NOW - 20 * MIN;
  return {
    status: 'OPEN',
    priority: 'P2',
    createdAt: iso(created),
    firstReplyDueAt: iso(created + 60 * MIN),
    resolveDueAt: iso(created + 480 * MIN),
    firstReplyAtRiskAt: iso(created + 45 * MIN),
    resolveAtRiskAt: iso(created + 360 * MIN),
    firstRepliedAt: null,
    slaPausedAt: null,
    slaBreached: false,
    ...patch,
  };
}

describe('queue first-reply SLA bar (design sla())', () => {
  it('shows the remaining share of the first-reply window while it counts down', () => {
    expect(queueSlaBar(ticket(), NOW)).toEqual({ tone: 'ok', percent: (40 / 60) * 100 });
    // At risk (past the stored at-risk instant): amber; never thinner than 4%.
    expect(queueSlaBar(ticket(), NOW + 39.9 * MIN)).toEqual({ tone: 'risk', percent: 4 });
  });

  it('is full when overdue (red), replied (green), paused or solved', () => {
    expect(queueSlaBar(ticket(), NOW + 41 * MIN)).toEqual({ tone: 'overdue', percent: 100 });
    const replied = ticket({ firstRepliedAt: iso(NOW - 10 * MIN) });
    expect(queueSlaBar(replied, NOW)).toEqual({ tone: 'replied', percent: 100 });
    expect(queueSlaBar({ ...replied, status: 'PENDING', slaPausedAt: iso(NOW) }, NOW)).toEqual({
      tone: 'paused',
      percent: 100,
    });
    expect(queueSlaBar(ticket({ status: 'SOLVED' }), NOW)).toEqual({ tone: 'done', percent: 100 });
  });

  it('follows the resolution clock the row shows once it is at risk after the first reply', () => {
    const replied = ticket({ firstRepliedAt: iso(NOW - 10 * MIN) });
    const bar = queueSlaBar(replied, NOW + 400 * MIN);
    expect(bar.tone).toBe('risk');
    expect(bar.percent).toBeCloseTo((60 / 480) * 100);
  });
});
