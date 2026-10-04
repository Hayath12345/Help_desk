import { describe, expect, it } from 'vitest';
import { AUTO_ASSIGN_SKIPS, chooseAssignee, type AutoAssignCandidate } from './auto-assign.ts';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const candidate = (
  userId: string,
  openTickets: number,
  lastAutoAssignedAt: Date | null = null,
): AutoAssignCandidate => ({ userId, openTickets, lastAutoAssignedAt });

describe('chooseAssignee', () => {
  it('picks nobody when there are no candidates', () => {
    expect(chooseAssignee([])).toBeNull();
  });

  it('picks the only candidate', () => {
    expect(chooseAssignee([candidate('a', 9)])?.userId).toBe('a');
  });

  it('picks the one with the fewest open tickets', () => {
    expect(chooseAssignee([candidate('a', 4), candidate('b', 1), candidate('c', 3)])?.userId).toBe(
      'b',
    );
  });

  it('breaks a tie with whoever was handed a ticket longest ago', () => {
    const winner = chooseAssignee([
      candidate('a', 2, day(10)),
      candidate('b', 2, day(3)),
      candidate('c', 2, day(7)),
    ]);
    expect(winner?.userId).toBe('b');
  });

  it('puts someone who was never handed a ticket before everyone who was', () => {
    const winner = chooseAssignee([candidate('a', 0, day(1)), candidate('b', 0, null)]);
    expect(winner?.userId).toBe('b');
  });

  it('lets workload beat fairness: fewer open tickets wins even if handed one recently', () => {
    const winner = chooseAssignee([candidate('a', 1, day(30)), candidate('b', 5, null)]);
    expect(winner?.userId).toBe('a');
  });

  it('is deterministic when everything else is equal (lowest id)', () => {
    const list = [candidate('c', 0), candidate('a', 0), candidate('b', 0)];
    expect(chooseAssignee(list)?.userId).toBe('a');
    expect(chooseAssignee([...list].reverse())?.userId).toBe('a');
  });
});

describe('AUTO_ASSIGN_SKIPS', () => {
  it('leaves P1 to the on-call escalation chain', () => {
    expect(AUTO_ASSIGN_SKIPS).toEqual(['P1']);
  });
});
