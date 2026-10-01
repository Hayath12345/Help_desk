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

// ───────────── Which rule fires next (decision E13) ─────────────
//
// Which rule a step fires is decided by rule, not by number: the first rule of the chain in force
// that has not fired in this P1 period (the fired rules are the period's ESCALATED events, whose
// meta carries the rule id). The worker (jobs/escalation.ts) fires by this rule and the ticket
// detail shows the same next step (`p1NextStep`, Phase 5 F15), so an admin reorder mid-chain
// never pages — or shows — a rule twice.

/** An ESCALATED event as stored (`toValue` = the step number it fired as). */
export interface EscalatedEventRow {
  toValue: string | null;
  meta: Prisma.JsonValue;
}

/** A step recorded in a P1 period: the job number it fired as and the rule it paged. */
export interface FiredStep {
  step: number;
  ruleId: string | null;
}

/** The steps an ESCALATED event list records for the P1 period that started at `p1Since`. */
export function firedSteps(events: readonly EscalatedEventRow[], p1Since: Date): FiredStep[] {
  const period = p1Since.toISOString();
  const out: FiredStep[] = [];
  for (const e of events) {
    const meta = (e.meta ?? {}) as { p1Since?: unknown; ruleId?: unknown };
    if (meta.p1Since !== period) continue;
    out.push({
      step: Number(e.toValue),
      ruleId: typeof meta.ruleId === 'string' ? meta.ruleId : null,
    });
  }
  return out;
}

/**
 * The rules of `chain` that already fired in the period: by rule id. A period whose steps were
 * counted but never recorded (no event: set by hand) falls back to the step numbers.
 */
export function firedRuleIds(
  chain: ReadonlyArray<{ id: string; step: number }>,
  fired: readonly FiredStep[],
  p1EscalationStep: number,
): Set<string> {
  if (fired.length === 0) {
    return new Set(chain.filter((r) => r.step <= p1EscalationStep).map((r) => r.id));
  }
  const ids = new Set<string>();
  for (const f of fired) {
    const id = f.ruleId ?? chain.find((r) => r.step === f.step)?.id;
    if (id) ids.add(id);
  }
  return ids;
}

/** The job number of the next step: never at or below the steps already counted. */
export function nextJobStep(next: { step: number }, counted: number): number {
  return Math.max(next.step, counted + 1);
}

/**
 * The step that fires next in a P1 period: the first rule of `chain` that has not fired, and the
 * job number it fires as (what the SLA scan's safety net schedules). Null when every rule fired.
 */
export function pendingEscalation<R extends { id: string; step: number }>(
  chain: readonly R[],
  events: readonly EscalatedEventRow[],
  p1Since: Date,
  p1EscalationStep: number,
): { rule: R; step: number } | null {
  const fired = firedRuleIds(chain, firedSteps(events, p1Since), p1EscalationStep);
  const rule = chain.find((r) => !fired.has(r.id));
  return rule ? { rule, step: nextJobStep(rule, p1EscalationStep) } : null;
}
