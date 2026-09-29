import type { Prisma, PrismaClient } from '@loons/db';

// The P1 escalation chain (decision D3): `EscalationRule.afterMins` counts cumulatively from the
// moment the ticket became P1 (`Ticket.p1Since`), not from the previous step. A team with any
// active P1 rule of its own uses only those (they REPLACE the global chain); every other team
// uses the global rules (teamId = null). Read when a ticket becomes P1 (to schedule step 1) and
// again whenever a step fires (targets, channels and the next step come from the rules in force
// then).

/** One real minute. Tests shrink it so a 5-minute step fires in milliseconds. */
export const MINUTE_MS = 60_000;

export const escalationRuleSelect = {
  id: true,
  teamId: true,
  step: true,
  targetType: true,
  targetRole: true,
  targetUserId: true,
  afterMins: true,
  channels: true,
} as const satisfies Prisma.EscalationRuleSelect;

export type EscalationRuleRow = Prisma.EscalationRuleGetPayload<{
  select: typeof escalationRuleSelect;
}>;

/** The active P1 chain for a team, ordered by step. */
export async function loadP1Chain(
  db: PrismaClient | Prisma.TransactionClient,
  teamId: string,
): Promise<EscalationRuleRow[]> {
  const rules = await db.escalationRule.findMany({
    where: { priority: 'P1', isActive: true, OR: [{ teamId }, { teamId: null }] },
    orderBy: [{ step: 'asc' }],
    select: escalationRuleSelect,
  });
  return selectChain(rules, teamId);
}

/** Team-scoped rules replace the global chain when the team has any (D3). */
export function selectChain<T extends { teamId: string | null; step: number }>(
  rules: readonly T[],
  teamId: string,
): T[] {
  const own = rules.filter((r) => r.teamId === teamId);
  const chain = own.length > 0 ? own : rules.filter((r) => r.teamId === null);
  return [...chain].sort((a, b) => a.step - b.step);
}

/** The first rule after `step` (null at the end of the chain). */
export function nextRule<T extends { step: number }>(chain: readonly T[], step: number): T | null {
  return chain.find((r) => r.step > step) ?? null;
}

/**
 * How long to wait before a step with `afterMins` fires: `p1Since + afterMins` minus now, never
 * negative (a step whose time has passed — a worker that was down — fires at once).
 */
export function escalationDelayMs(
  p1Since: Date,
  afterMins: number,
  now: Date,
  minuteMs: number = MINUTE_MS,
): number {
  return Math.max(0, p1Since.getTime() + afterMins * minuteMs - now.getTime());
}

/** Highest step number a pending job could have (cancellation tries every id up to it). */
export const MAX_ESCALATION_STEPS = 20;
