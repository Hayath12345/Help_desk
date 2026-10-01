import { describe, expect, it } from 'vitest';
import {
  MINUTE_MS,
  escalationDelayMs,
  firedRuleIds,
  firedSteps,
  nextJobStep,
  nextRule,
  pendingEscalation,
  selectChain,
} from './escalation.ts';

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

describe('which rule fires next (E13; Phase 5 F15)', () => {
  const p1Since = new Date('2026-09-29T10:00:00.000Z');
  const period = p1Since.toISOString();
  const a = { id: 'rule-a', step: 1 };
  const b = { id: 'rule-b', step: 2 };
  const c = { id: 'rule-c', step: 3 };
  const fired = (step: number, ruleId: string | null, since = period) => ({
    toValue: String(step),
    meta: ruleId === null ? { step, p1Since: since } : { step, ruleId, p1Since: since },
  });

  it('the first rule that has not fired in this period, as the next job number', () => {
    expect(pendingEscalation([a, b, c], [], p1Since, 0)).toEqual({ rule: a, step: 1 });
    expect(pendingEscalation([a, b, c], [fired(1, a.id)], p1Since, 1)).toEqual({
      rule: b,
      step: 2,
    });
    expect(pendingEscalation([a, b, c], [fired(1, a.id), fired(2, b.id)], p1Since, 2)).toEqual({
      rule: c,
      step: 3,
    });
    expect(
      pendingEscalation([a, b, c], [fired(1, a.id), fired(2, b.id), fired(3, c.id)], p1Since, 3),
    ).toBeNull();
  });

  it('after a reorder: by rule, never "the rule after step N"', () => {
    // a fired as step 1; then c moved to the top: c, a, b.
    const reordered = [
      { ...c, step: 1 },
      { ...a, step: 2 },
      { ...b, step: 3 },
    ];
    expect(pendingEscalation(reordered, [fired(1, a.id)], p1Since, 1)).toEqual({
      rule: reordered[0],
      step: 2, // never at or below the steps already counted
    });
    expect(nextRule(reordered, 1)).toEqual(reordered[1]); // the naive answer: a, which fired
    expect(pendingEscalation(reordered, [fired(1, a.id), fired(2, c.id)], p1Since, 2)).toEqual({
      rule: reordered[2],
      step: 3,
    });
  });

  it('only events of this period count; events without a rule id fall back to the step', () => {
    const other = new Date('2026-09-28T10:00:00.000Z').toISOString();
    expect(pendingEscalation([a, b, c], [fired(1, a.id, other)], p1Since, 0)).toEqual({
      rule: a,
      step: 1,
    });
    expect(firedSteps([fired(1, a.id, other), fired(2, null)], p1Since)).toEqual([
      { step: 2, ruleId: null },
    ]);
    expect(pendingEscalation([a, b, c], [fired(1, null)], p1Since, 1)).toEqual({
      rule: b,
      step: 2,
    });
    // Counted but never recorded (set by hand): the step numbers decide.
    expect(firedRuleIds([a, b, c], [], 2)).toEqual(new Set([a.id, b.id]));
    expect(nextJobStep({ step: 1 }, 4)).toBe(5);
  });
});
