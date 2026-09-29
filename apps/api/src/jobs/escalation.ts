import type { Prisma } from '@loons/db';
import { escalationDelayMs, loadP1Chain, nextRule } from '../lib/escalation.ts';
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

export type EscalationResult =
  { skipped: string } | { step: number; recipients: number; next: number | null };

const DONE = ['SOLVED', 'CLOSED'] as const;

export async function processEscalationStep(
  ctx: WorkerContext,
  job: EscalationJob,
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

  // The rules in force now (a Phase 4 edit applies to the next step that fires).
  const chain = await loadP1Chain(ctx.prisma, t.teamId);
  const rule = chain.find((r) => r.step === job.step) ?? null;
  const next = nextRule(chain, job.step);
  const now = ctx.now();

  const scheduleNext = async () => {
    if (!next) return null;
    await ctx.queues.scheduleEscalation(
      { ticketId: t.id, p1Since: p1Since.toISOString(), step: next.step },
      escalationDelayMs(p1Since, next.afterMins, now, ctx.minuteMs),
    );
    return next.step;
  };

  if (!rule) {
    // The step was removed since it was scheduled: go on with the chain.
    await scheduleNext();
    return { skipped: 'no-rule-for-step' };
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

  // Fan-out (idempotent). Step 1 is the P1 alert to the on-call user; its TEAMS channel is the
  // card already posted when the ticket became P1 (D4). Later steps post an "escalated" card.
  const recipients = await escalationTargets(ctx.prisma, rule, t.team);
  const first = job.step === chain[0]?.step;
  const stepCount = chain.length;
  const base = `p1esc-${t.id}-${p1Since.getTime()}-${job.step}`;
  const context = {
    p1Since: p1Since.toISOString(),
    step: job.step,
    stepCount,
    ...(first && next ? { escalationMins: next.afterMins - rule.afterMins } : {}),
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

/**
 * Re-schedules P1 steps that are overdue and have no live job: the API's best-effort enqueue of
 * step 1 failed, or a step dead-lettered during an outage. Only unacknowledged P1 periods that
 * started in the last 24 hours are looked at (historical tickets have no `p1Since`, D10); a step
 * whose job failed is retried, a missing one is added (deterministic id), a completed one is left
 * alone (it ran and decided). Run by every SLA scan tick.
 */
export async function resumeStalledEscalations(
  ctx: WorkerContext,
  opts: { now: Date; teamIds?: readonly string[] | undefined },
): Promise<number> {
  const { now } = opts;
  const rows = await ctx.prisma.ticket.findMany({
    where: {
      priority: 'P1',
      p1AckedAt: null,
      p1Since: { gte: new Date(now.getTime() - ESCALATION_NET_WINDOW_MS), lte: now },
      status: { notIn: [...DONE] },
      ...(opts.teamIds ? { teamId: { in: [...opts.teamIds] } } : {}),
    },
    orderBy: { p1Since: 'asc' },
    take: 200,
    select: { id: true, teamId: true, p1Since: true, p1EscalationStep: true },
  });
  const chains = new Map<string, Awaited<ReturnType<typeof loadP1Chain>>>();
  let resumed = 0;
  for (const t of rows) {
    if (!t.p1Since) continue;
    let chain = chains.get(t.teamId);
    if (!chain) {
      chain = await loadP1Chain(ctx.prisma, t.teamId);
      chains.set(t.teamId, chain);
    }
    const next = nextRule(chain, t.p1EscalationStep);
    if (!next) continue;
    const lateMs = now.getTime() - (t.p1Since.getTime() + next.afterMins * ctx.minuteMs);
    if (lateMs < ESCALATION_NET_GRACE_MINUTES * ctx.minuteMs) continue;
    const job = { ticketId: t.id, p1Since: t.p1Since.toISOString(), step: next.step };
    const existing = await ctx.queues.escalation.getJob(
      escalationJobId(t.id, t.p1Since, next.step),
    );
    if (existing) {
      const state = await existing.getState();
      if (LIVE_STATES.has(state) || state === 'completed') continue;
      if (state === 'failed') {
        await existing.retry('failed');
        resumed += 1;
        ctx.logger.warn(
          { ticketId: t.id, step: next.step },
          'escalation step retried (safety net)',
        );
        continue;
      }
    }
    await ctx.queues.scheduleEscalation(job, 0);
    resumed += 1;
    ctx.logger.warn(
      { ticketId: t.id, step: next.step },
      'escalation step re-scheduled (safety net)',
    );
  }
  return resumed;
}
