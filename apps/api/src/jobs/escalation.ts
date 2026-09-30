import { DelayedError, type Job } from 'bullmq';
import type { Prisma } from '@loons/db';
import { ESCALATION_LIMITS } from '@loons/shared';
import { escalationDelayMs, loadP1Chain, type EscalationRuleRow } from '../lib/escalation.ts';
import { escalationJobId, type EscalationJob } from '../lib/job-data.ts';
import {
  createInApp,
  queueDeliveries,
  type PlannedDelivery,
  type PlannedInApp,
  type WorkerContext,
} from './context.ts';
import { escalationTargets, maskedPhoneOf } from './recipients.ts';

// One P1 escalation step (decisions D3 / D4 / D10). Steps only run from delayed jobs scheduled
// when a ticket becomes P1 (the API schedules the first, each step schedules the next), so a
// historical ticket never pages anyone. When the job fires it re-reads everything: nothing
// happens when the ticket is gone, solved / closed, no longer P1, acknowledged, in another P1
// period (`p1Since` moved) or already past this step. The step is claimed with a conditional
// update of `p1EscalationStep` (two workers can't both fire it); only the claimer writes the
// ESCALATED event. The fan-out itself is idempotent (dedupe keys), so a retry after a crash
// finishes it without paging anyone twice.
//
// Re-timing (decision E13): the rules may have changed since the job was scheduled. A step whose
// rule now says `p1Since + afterMins` is later than now fired early (its delay was lengthened): it
// waits again — the running job moves itself back to delayed under the same id (so cancellation
// and the safety net still find it) — and fires then. A shortened delay is the safety net's job:
// the next SLA scan promotes a pending step that is already due (`resumeStalledEscalations`).
//
// Which rule a step job fires is decided by rule, not by number: the first rule of the chain in
// force that has not fired in this P1 period (the fired rules are the period's ESCALATED events,
// whose meta carries the rule id). An admin reorder while a P1 is mid-chain renumbers the rules; the
// pending job then pages the rule that has not fired yet, never one that already did. The job
// number counts the steps fired (`p1EscalationStep`): the next job is `max(next rule's step, this
// job's + 1)`, which the safety net computes the same way (same job id).

export type EscalationResult =
  | { skipped: string }
  | { step: number; recipients: number; next: number | null }
  | { waiting: number };

/** The running BullMQ job and its lock token, so an early step can move itself back to delayed. */
export interface EscalationJobHandle {
  job: Pick<Job, 'moveToDelayed'>;
  token: string | undefined;
}

/** A step this close to its time (or later) fires; earlier than that, it waits again. */
export function earlyToleranceMs(minuteMs: number): number {
  return Math.min(1_000, Math.max(1, Math.floor(minuteMs / 20)));
}

const DONE = ['SOLVED', 'CLOSED'] as const;

/** A step recorded in a P1 period: the job number it fired as and the rule it paged. */
interface FiredStep {
  step: number;
  ruleId: string | null;
}

/** The steps an ESCALATED event list records for the P1 period that started at `p1Since`. */
function firedSteps(
  events: ReadonlyArray<{ toValue: string | null; meta: Prisma.JsonValue }>,
  p1Since: Date,
): FiredStep[] {
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
function firedRuleIds(
  chain: readonly EscalationRuleRow[],
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
function nextJobStep(next: EscalationRuleRow, counted: number): number {
  return Math.max(next.step, counted + 1);
}

async function loadFiredSteps(
  db: WorkerContext['prisma'],
  ticketIds: readonly string[],
): Promise<Map<string, Array<{ toValue: string | null; meta: Prisma.JsonValue }>>> {
  const events = await db.ticketEvent.findMany({
    where: { ticketId: { in: [...ticketIds] }, type: 'ESCALATED' },
    select: { ticketId: true, toValue: true, meta: true },
  });
  const byTicket = new Map<string, Array<{ toValue: string | null; meta: Prisma.JsonValue }>>();
  for (const e of events) {
    const list = byTicket.get(e.ticketId) ?? [];
    list.push(e);
    byTicket.set(e.ticketId, list);
  }
  return byTicket;
}

export async function processEscalationStep(
  ctx: WorkerContext,
  job: EscalationJob,
  handle?: EscalationJobHandle,
): Promise<EscalationResult> {
  const p1Since = new Date(job.p1Since);
  const t = await ctx.prisma.ticket.findUnique({
    where: { id: job.ticketId },
    select: {
      id: true,
      subject: true,
      priority: true,
      status: true,
      teamId: true,
      p1Since: true,
      p1AckedAt: true,
      p1EscalationStep: true,
      team: { select: { id: true, onCallUserId: true, teamsWebhookUrl: true } },
    },
  });
  if (!t) return { skipped: 'ticket-gone' };
  if ((DONE as readonly string[]).includes(t.status)) return { skipped: 'ticket-done' };
  if (t.priority !== 'P1') return { skipped: 'not-p1' };
  if (t.p1AckedAt) return { skipped: 'acknowledged' };
  if (!t.p1Since || t.p1Since.getTime() !== p1Since.getTime())
    return { skipped: 'p1-period-moved' };
  if (t.p1EscalationStep > job.step) return { skipped: 'already-past-this-step' };

  // The rules in force now (a Phase 4 edit applies to the next step that fires), and the ones that
  // already fired in this period.
  const chain = await loadP1Chain(ctx.prisma, t.teamId);
  const recorded = firedSteps((await loadFiredSteps(ctx.prisma, [t.id])).get(t.id) ?? [], p1Since);
  const fired = firedRuleIds(chain, recorded, t.p1EscalationStep);
  // This job's rule: the one it already claimed (a retry), else the first that has not fired.
  let rule: EscalationRuleRow | null;
  if (t.p1EscalationStep === job.step) {
    const own = recorded.find((f) => f.step === job.step);
    rule = chain.find((r) => (own?.ruleId ? r.id === own.ruleId : r.step === job.step)) ?? null;
  } else {
    rule = chain.find((r) => !fired.has(r.id)) ?? null;
  }
  const next = chain.find((r) => r.id !== rule?.id && !fired.has(r.id)) ?? null;
  const now = ctx.now();

  const scheduleNext = async () => {
    if (!next) return null;
    const step = nextJobStep(next, job.step);
    await ctx.queues.scheduleEscalation(
      { ticketId: t.id, p1Since: p1Since.toISOString(), step },
      escalationDelayMs(p1Since, next.afterMins, now, ctx.minuteMs),
    );
    return step;
  };

  if (!rule) {
    // Every rule has fired, or the claimed one was removed since: go on with the chain.
    await scheduleNext();
    return { skipped: 'no-rule-for-step' };
  }

  // E13: the rule's delay was lengthened since this job was scheduled — wait until its new time.
  const waitMs = escalationDelayMs(p1Since, rule.afterMins, now, ctx.minuteMs);
  if (t.p1EscalationStep < job.step && waitMs > earlyToleranceMs(ctx.minuteMs)) {
    if (handle) {
      // Same job id, attempts untouched: BullMQ runs it again at the new time.
      await handle.job.moveToDelayed(Date.now() + waitMs, handle.token);
      throw new DelayedError();
    }
    // Run outside BullMQ (tests, tools): schedule the step again under its id.
    await ctx.queues.scheduleEscalation(job, waitMs);
    return { waiting: waitMs };
  }

  // Claim the step (first worker wins) and record it, in one transaction.
  if (t.p1EscalationStep < job.step) {
    const claimed = await ctx.prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: {
          id: t.id,
          priority: 'P1',
          p1AckedAt: null,
          p1Since,
          p1EscalationStep: { lt: job.step },
          status: { notIn: [...DONE] },
        },
        data: { p1EscalationStep: job.step },
      });
      if (count === 0) return false;
      await tx.ticketEvent.create({
        data: {
          ticketId: t.id,
          type: 'ESCALATED',
          actorId: null,
          fromValue: String(t.p1EscalationStep),
          toValue: String(job.step),
          meta: {
            step: job.step,
            ruleId: rule.id,
            targetType: rule.targetType,
            channels: rule.channels,
            p1Since: p1Since.toISOString(),
          } satisfies Prisma.InputJsonObject,
          createdAt: now,
        },
      });
      return true;
    });
    if (!claimed) {
      // Acknowledged, downgraded or fired by another worker in the meantime: re-check.
      const fresh = await ctx.prisma.ticket.findUnique({
        where: { id: t.id },
        select: { p1EscalationStep: true, p1AckedAt: true, priority: true, p1Since: true },
      });
      if (
        !fresh ||
        fresh.p1AckedAt ||
        fresh.priority !== 'P1' ||
        fresh.p1Since?.getTime() !== p1Since.getTime() ||
        fresh.p1EscalationStep !== job.step
      ) {
        return { skipped: 'lost-race' };
      }
    } else {
      await ctx.publish({ kind: 'ticket', ticketId: t.id });
    }
  }

  // Fan-out (idempotent). The first step of the period is the P1 alert to the on-call user; its
  // TEAMS channel is the card already posted when the ticket became P1 (D4). Later steps post an
  // "escalated" card.
  const recipients = await escalationTargets(ctx.prisma, rule, t.team);
  const first = [...fired].every((id) => id === rule.id);
  const stepCount = chain.length;
  const base = `p1esc-${t.id}-${p1Since.getTime()}-${job.step}`;
  const context = {
    p1Since: p1Since.toISOString(),
    step: job.step,
    stepCount,
    // The next step never fires before this one: never a negative "next step in" (a chain whose
    // delays go down — older data — fires the next step at once).
    ...(first && next ? { escalationMins: Math.max(0, next.afterMins - rule.afterMins) } : {}),
  };
  const deliveries: PlannedDelivery[] = [];
  const inApp: PlannedInApp[] = [];
  for (const user of recipients) {
    inApp.push({
      userId: user.id,
      type: first ? 'P1_CREATED' : 'P1_ESCALATED',
      ticketId: t.id,
      data: { subject: t.subject, priority: t.priority, step: job.step },
      dedupeKey: `${base}-inapp-${user.id}`,
    });
    if (rule.channels.includes('EMAIL')) {
      deliveries.push({
        job: {
          dedupeKey: `${base}-EMAIL-${user.id}`,
          channel: 'EMAIL',
          template: first ? 'P1_ALERT' : 'P1_ESCALATION',
          ticketId: t.id,
          userId: user.id,
          context,
        },
        recipientMasked: user.email,
      });
    }
    if (rule.channels.includes('SMS')) {
      deliveries.push({
        job: {
          dedupeKey: `${base}-SMS-${user.id}`,
          channel: 'SMS',
          template: first ? 'P1_ALERT' : 'P1_ESCALATION',
          ticketId: t.id,
          userId: user.id,
          context,
        },
        recipientMasked: maskedPhoneOf(user.phone),
      });
    }
  }
  if (!first && rule.channels.includes('TEAMS')) {
    deliveries.push({
      job: {
        dedupeKey: `${base}-TEAMS-team`,
        channel: 'TEAMS',
        template: 'P1_ESCALATED',
        ticketId: t.id,
        teamId: t.teamId,
        context,
      },
      recipientMasked: ctx.teams.describe(t.team.teamsWebhookUrl),
    });
  }
  if (recipients.length === 0) {
    ctx.logger.warn({ ticketId: t.id, step: job.step }, 'escalation step has nobody to page');
  }
  await queueDeliveries(ctx, deliveries);
  // An acknowledgement that landed after the claim: the deliveries skip themselves when they run
  // (P1 closed), and the bell must not say "escalated" for a P1 that is already acknowledged.
  const current = await ctx.prisma.ticket.findUnique({
    where: { id: t.id },
    select: { p1AckedAt: true, p1Since: true, priority: true },
  });
  const stillOpen =
    current !== null &&
    current.priority === 'P1' &&
    !current.p1AckedAt &&
    current.p1Since?.getTime() === p1Since.getTime();
  if (stillOpen) await createInApp(ctx, inApp);
  return { step: job.step, recipients: recipients.length, next: await scheduleNext() };
}

// ───────────── Safety net ─────────────

/** How far back the safety net looks at P1 periods (D10: only periods started since deploy). */
export const ESCALATION_NET_WINDOW_MS = 24 * 60 * 60_000;
/** A step this many escalation minutes late with no live job is re-scheduled. */
export const ESCALATION_NET_GRACE_MINUTES = 2;
const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);
const NET_BATCH = 200;

/**
 * How far back a shortened delay is still promoted (E13): a step can be up to `afterMinsMax`
 * after `p1Since`, so a period older than the D10 day can still have a step job waiting.
 */
export function escalationPromoteWindowMs(minuteMs: number): number {
  return ESCALATION_NET_WINDOW_MS + ESCALATION_LIMITS.afterMinsMax * minuteMs;
}

/**
 * Re-schedules P1 steps that are overdue and have no live job: the API's best-effort enqueue of
 * step 1 failed, or a step dead-lettered during an outage. Only unacknowledged P1 periods that
 * started in the last 24 hours are looked at for that (historical tickets have no `p1Since`, D10);
 * a step whose job failed is retried, a missing one is added (deterministic id), a completed one is
 * left alone (it ran and decided). A step that is due by its rule but whose job still waits for a
 * later time (an admin shortened the delay, E13) is promoted: it fires now — for periods up to
 * `escalationPromoteWindowMs` old, since step delays go up to 7 days. Run by every SLA scan tick.
 */
export async function resumeStalledEscalations(
  ctx: WorkerContext,
  opts: { now: Date; teamIds?: readonly string[] | undefined },
): Promise<number> {
  const { now } = opts;
  const recentSince = new Date(now.getTime() - ESCALATION_NET_WINDOW_MS);
  const where = {
    priority: 'P1',
    p1AckedAt: null,
    status: { notIn: [...DONE] },
    ...(opts.teamIds ? { teamId: { in: [...opts.teamIds] } } : {}),
  } satisfies Prisma.TicketWhereInput;
  const select = { id: true, teamId: true, p1Since: true, p1EscalationStep: true } as const;
  const recent = await ctx.prisma.ticket.findMany({
    where: { ...where, p1Since: { gte: recentSince, lte: now } },
    orderBy: { p1Since: 'asc' },
    take: NET_BATCH,
    select,
  });
  // Older periods: only a promotion (newest first, so a backlog of stale P1s can't crowd them out).
  const older = await ctx.prisma.ticket.findMany({
    where: {
      ...where,
      p1Since: {
        gte: new Date(now.getTime() - escalationPromoteWindowMs(ctx.minuteMs)),
        lt: recentSince,
      },
    },
    orderBy: { p1Since: 'desc' },
    take: NET_BATCH,
    select,
  });
  const rows = [
    ...recent.map((t) => ({ ...t, recent: true })),
    ...older.map((t) => ({ ...t, recent: false })),
  ];
  if (rows.length === 0) return 0;
  const events = await loadFiredSteps(
    ctx.prisma,
    rows.map((t) => t.id),
  );
  const chains = new Map<string, Awaited<ReturnType<typeof loadP1Chain>>>();
  let resumed = 0;
  for (const t of rows) {
    if (!t.p1Since) continue;
    let chain = chains.get(t.teamId);
    if (!chain) {
      chain = await loadP1Chain(ctx.prisma, t.teamId);
      chains.set(t.teamId, chain);
    }
    // The next rule to fire and its job number, as the last step that fired scheduled it.
    const fired = firedRuleIds(
      chain,
      firedSteps(events.get(t.id) ?? [], t.p1Since),
      t.p1EscalationStep,
    );
    const next = chain.find((r) => !fired.has(r.id));
    if (!next) continue;
    const step = nextJobStep(next, t.p1EscalationStep);
    const lateMs = now.getTime() - (t.p1Since.getTime() + next.afterMins * ctx.minuteMs);
    if (lateMs < 0) continue; // not due yet
    const graceMs = ESCALATION_NET_GRACE_MINUTES * ctx.minuteMs;
    const jobId = escalationJobId(t.id, t.p1Since, step);
    const job = { ticketId: t.id, p1Since: t.p1Since.toISOString(), step };
    const existing = await ctx.queues.escalation.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // E13: due by its (shortened) rule, but still waiting for the old time. Not a retry backoff
      // (attemptsMade > 0): those keep their pace.
      if (state === 'delayed' && existing.attemptsMade === 0) {
        const firesAt = await delayedUntil(ctx, jobId);
        if (firesAt !== null && firesAt - Date.now() > earlyToleranceMs(ctx.minuteMs)) {
          await existing.promote();
          resumed += 1;
          ctx.logger.info(
            { ticketId: t.id, step },
            'escalation step re-timed: its shorter delay has passed (safety net)',
          );
        }
        continue;
      }
      if (!t.recent || lateMs < graceMs) continue;
      if (LIVE_STATES.has(state) || state === 'completed') continue;
      if (state === 'failed') {
        await existing.retry('failed');
        resumed += 1;
        ctx.logger.warn({ ticketId: t.id, step }, 'escalation step retried (safety net)');
        continue;
      }
    }
    if (!t.recent || lateMs < graceMs) continue;
    await ctx.queues.scheduleEscalation(job, 0);
    resumed += 1;
    ctx.logger.warn({ ticketId: t.id, step }, 'escalation step re-scheduled (safety net)');
  }
  return resumed;
}

/**
 * When a delayed escalation job is due (ms since the epoch, BullMQ's clock), or null when it is not
 * in the delayed set. BullMQ scores delayed jobs `due * 0x1000 + sequence`.
 */
async function delayedUntil(ctx: WorkerContext, jobId: string): Promise<number | null> {
  const backend = ctx.queues.escalation.getBackend();
  const client = await backend.client;
  const score = await client.zscore(backend.keys.delayed!, jobId);
  return score === null ? null : Math.floor(Number(score) / 0x1000);
}
