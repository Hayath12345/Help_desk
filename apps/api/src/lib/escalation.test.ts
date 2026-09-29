import { describe, expect, it } from 'vitest';
import { MINUTE_MS, escalationDelayMs, nextRule, selectChain } from './escalation.ts';

// Decision D3: afterMins counts cumulatively from p1Since; team rules replace the global chain.

describe('P1 escalation schedule (D3)', () => {
  const p1Since = new Date('2026-09-29T10:00:00.000Z');
  const seeded = [
    { teamId: null, step: 1, afterMins: 0 },
    { teamId: null, step: 2, afterMins: 5 },
    { teamId: null, step: 3, afterMins: 15 },
  ];

  it('each step fires afterMins after the ticket became P1 (not after the previous step)', () => {
    const at = (min: number) => new Date(p1Since.getTime() + min * MINUTE_MS);
    // Created now: 0 / 5 / 15 minutes from now.
    expect(seeded.map((r) => escalationDelayMs(p1Since, r.afterMins, p1Since))).toEqual([
      0,
      5 * MINUTE_MS,
      15 * MINUTE_MS,
    ]);
    // Step 2 fired at 5: step 3 is 10 minutes later, not 15.
    expect(escalationDelayMs(p1Since, 15, at(5))).toBe(10 * MINUTE_MS);
    // A worker that was down: an overdue step fires at once, never with a negative delay.
    expect(escalationDelayMs(p1Since, 5, at(42))).toBe(0);
    // Tests shrink the minute.
    expect(escalationDelayMs(p1Since, 15, p1Since, 100)).toBe(1500);
  });

  it('a team with its own active rules replaces the global chain; others use the global one', () => {
    const own = [
      { teamId: 'team-a', step: 2, afterMins: 10 },
      { teamId: 'team-a', step: 1, afterMins: 1 },
    ];
    const rules = [...seeded, ...own, { teamId: 'team-b', step: 1, afterMins: 3 }];
    expect(selectChain(rules, 'team-a')).toEqual([own[1], own[0]]);
    expect(selectChain(rules, 'team-c')).toEqual(seeded);
    expect(selectChain([], 'team-c')).toEqual([]);
  });

  it('the next step is the next rule by step number (gaps allowed)', () => {
    const chain = [
      { step: 1, afterMins: 0 },
      { step: 3, afterMins: 15 },
    ];
    expect(nextRule(chain, 1)).toEqual(chain[1]);
    expect(nextRule(chain, 2)).toEqual(chain[1]);
    expect(nextRule(chain, 3)).toBeNull();
  });
});
