import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@loons/db';
import { computeSlaTargets } from '@loons/shared';
import type { WorkerContext } from '../src/jobs/context.ts';
import { queueDeliveries } from '../src/jobs/context.ts';
import { processDelivery } from '../src/jobs/deliver.ts';
import { processNotificationEvent } from '../src/jobs/events.ts';
import { SLA_NOTIFY_WINDOW_MS, crossingsOf, runSlaScan } from '../src/jobs/sla-scan.ts';
import { deliveryJobSchema, notificationEventSchema } from '../src/lib/job-data.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { createWorld, type World } from './ticket-world.ts';
import { allJobs, testWorkerContext } from './worker-helpers.ts';

// The SLA scan (D1 / D2 / D10) against real Postgres with a fake clock. Every ticket here lives
// 30 days in the future, so a worker running on the real clock (the dev stack) never sees these
// crossings; the scan is scoped to the test teams.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('SLA scan', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;
  /** 30 days ahead, on a whole minute. */
  const T0 = new Date(Math.floor((Date.now() + 30 * DAY) / MIN) * MIN);
  const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
  const scan = (now: Date, teamIds = [w.teamA.id]) => runSlaScan(worker, { now, teamIds });

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    worker = testWorkerContext(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A P2 (24/7: first reply 60 min, resolution 480 min, at risk at 75 %) created at T0. */
  async function ticket(data: Partial<Prisma.TicketUncheckedCreateInput> = {}) {
    return ctx.prisma.ticket.create({
      data: {
        type: 'INCIDENT',
        subject: `SLA scan ${Math.random().toString(36).slice(2, 8)}`,
        description: 'x',
        categoryId: w.catA.category.id,
        subtypeId: w.catA.subtypes[2]!.id,
        priority: 'P2',
        status: 'OPEN',
        orgId: w.orgX.id,
        siteId: w.siteX1.id,
        requesterId: w.clientX.id,
        teamId: w.teamA.id,
        assigneeId: w.agentA.id,
        createdAt: T0,
        firstReplyDueAt: at(60),
        firstReplyAtRiskAt: at(45),
        resolveDueAt: at(480),
        resolveAtRiskAt: at(360),
        ...data,
      },
    });
  }

  const signals = (ticketId: string) =>
    ctx.prisma.ticketSlaSignal.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  const events = (ticketId: string) =>
    ctx.prisma.ticketEvent.findMany({
      where: { ticketId, type: { in: ['SLA_AT_RISK', 'SLA_BREACHED'] } },
      orderBy: { createdAt: 'asc' },
    });
  const slaJobs = async (ticketId: string) =>
    (await allJobs(ctx.queues.notifications)).filter(
      (j) => j.name === 'event' && j.data.ticketId === ticketId,
    );

  it('flags an at-risk target once (signal, event, flag, one notification job) and is idempotent', async () => {
    const t = await ticket();
    const now = at(50);
    expect(await scan(now)).toMatchObject({ signals: 1, notified: 1 });
    expect(await signals(t.id)).toMatchObject([
      { target: 'FIRST_REPLY', kind: 'AT_RISK', dueAt: at(60) },
    ]);
    const [event] = await events(t.id);
    expect(event).toMatchObject({
      type: 'SLA_AT_RISK',
      actorId: null,
      meta: { target: 'FIRST_REPLY', dueAt: at(60).toISOString() },
      createdAt: at(45),
    });
    const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.slaAtRiskAt).toEqual(at(45));
    expect(row.slaBreached).toBe(false);
    // The flag is bookkeeping, not a change of the ticket.
    expect(row.updatedAt).toEqual(t.updatedAt);
    const jobs = await slaJobs(t.id);
    expect(jobs.map((j) => j.id)).toEqual([`sla-${t.id}-FIRST_REPLY-AT_RISK-${at(60).getTime()}`]);

    // Again (another tick, or another worker): nothing new.
    expect(await scan(at(51))).toMatchObject({ signals: 0, notified: 0 });
    expect(await signals(t.id)).toHaveLength(1);
    expect(await events(t.id)).toHaveLength(1);
    expect(await slaJobs(t.id)).toHaveLength(1);

    // Past the due date: the breach (sticky flag, due date as breach time).
    expect(await scan(at(61))).toMatchObject({ signals: 1, notified: 1 });
    const breached = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(breached).toMatchObject({ slaBreached: true, slaBreachedAt: at(60) });
    expect((await events(t.id)).map((e) => e.type)).toEqual(['SLA_AT_RISK', 'SLA_BREACHED']);
  });

  it('D10: a crossing older than 60 minutes is flagged but announces nothing', async () => {
    const t = await ticket();
    // The worker was down: both first-reply thresholds were crossed long ago.
    const now = at(60 + 3 * 60);
    const result = await scan(now);
    expect(result.signals).toBeGreaterThanOrEqual(2);
    expect(await signals(t.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'FIRST_REPLY', kind: 'AT_RISK' }),
        expect.objectContaining({ target: 'FIRST_REPLY', kind: 'BREACHED' }),
      ]),
    );
    expect(await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      slaBreached: true,
    });
    expect(await slaJobs(t.id)).toHaveLength(0);
    expect(now.getTime() - at(60).getTime()).toBeGreaterThan(SLA_NOTIFY_WINDOW_MS);
  });

  it('both thresholds crossed within the hour: only the breach is announced', async () => {
    const t = await ticket();
    await scan(at(70));
    const jobs = await slaJobs(t.id);
    expect(jobs.map((j) => j.data)).toEqual([
      expect.objectContaining({ event: 'sla', kind: 'BREACHED', target: 'FIRST_REPLY' }),
    ]);
  });

  it('honours pauses: PENDING stops the resolution clock but not an unanswered first reply', async () => {
    // Answered, then PENDING: the resolution instant has passed, but the clock is paused.
    const paused = await ticket({
      status: 'PENDING',
      firstRepliedAt: at(10),
      slaPausedAt: at(20),
      resolveAtRiskAt: at(100),
    });
    // Never answered, PENDING: the first-reply clock still runs.
    const unanswered = await ticket({ status: 'PENDING', slaPausedAt: at(20) });
    await scan(at(120));
    expect(await signals(paused.id)).toHaveLength(0);
    expect((await signals(unanswered.id)).map((s) => `${s.target}/${s.kind}`).sort()).toEqual([
      'FIRST_REPLY/AT_RISK',
      'FIRST_REPLY/BREACHED',
    ]);
    // The same rule as the risk view: once answered and PENDING, the summary flag goes.
    expect(
      (await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: paused.id } })).slaAtRiskAt,
    ).toBeNull();
    // Solved / closed tickets are never scanned.
    const solved = await ticket({ status: 'SOLVED', solvedAt: at(5) });
    await scan(at(600));
    expect(await signals(solved.id)).toHaveLength(0);
  });

  it('the summary flag follows the live rule: cleared once no target is at risk (breach stays)', async () => {
    const t = await ticket();
    await scan(at(61));
    expect(await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      slaAtRiskAt: at(45),
      slaBreached: true,
    });
    // Answered: the first-reply clock stops; the resolution target is far away.
    await ctx.prisma.ticket.update({ where: { id: t.id }, data: { firstRepliedAt: at(62) } });
    await scan(at(63));
    expect(await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      slaAtRiskAt: null,
      slaBreached: true,
      slaBreachedAt: at(60),
    });
  });

  it('pure rule: which targets run and which thresholds are crossed', () => {
    const base = {
      status: 'OPEN',
      firstRepliedAt: null,
      firstReplyDueAt: at(60),
      firstReplyAtRiskAt: at(45),
      resolveDueAt: at(480),
      resolveAtRiskAt: at(360),
    };
    expect(crossingsOf(base, at(44))).toEqual([]);
    expect(crossingsOf(base, at(45)).map((c) => c.kind)).toEqual(['AT_RISK']);
    expect(crossingsOf(base, at(60)).map((c) => c.kind)).toEqual(['AT_RISK']);
    expect(crossingsOf({ ...base, firstRepliedAt: at(1) }, at(400))).toEqual([
      { target: 'RESOLUTION', kind: 'AT_RISK', dueAt: at(480), at: at(360) },
    ]);
    expect(crossingsOf({ ...base, firstReplyAtRiskAt: null }, at(50))).toEqual([]);
    expect(crossingsOf({ ...base, status: 'SOLVED' }, at(999))).toEqual([]);
    // PENDING pauses the resolution clock only: an unanswered PENDING keeps its first reply.
    expect(crossingsOf({ ...base, status: 'PENDING', firstRepliedAt: at(1) }, at(999))).toEqual([]);
    expect(crossingsOf({ ...base, status: 'PENDING' }, at(50))).toEqual([
      { target: 'FIRST_REPLY', kind: 'AT_RISK', dueAt: at(60), at: at(45) },
    ]);
  });

  it('backfills missing at-risk instants (never after the stored due date)', async () => {
    const t = await ticket({ firstReplyAtRiskAt: null, resolveAtRiskAt: null });
    // Seeded-style: a resolution due date earlier than the policy would give.
    const short = await ticket({
      firstReplyAtRiskAt: null,
      resolveAtRiskAt: null,
      resolveDueAt: at(100),
    });
    const result = await scan(at(1));
    expect(result.backfilled).toBeGreaterThanOrEqual(4);
    const policy = (await ctx.app.services.ticketConfig.getFormConfig()).slaPolicies.find(
      (p) => p.priority === 'P2',
    )!;
    const expected = computeSlaTargets(
      T0,
      policy,
      await ctx.app.services.ticketConfig.getCalendar(),
    );
    expect(await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      firstReplyAtRiskAt: expected.firstReplyAtRiskAt,
      resolveAtRiskAt: expected.resolveAtRiskAt,
    });
    const clamped = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: short.id } });
    expect(clamped.resolveAtRiskAt).toEqual(
      expected.resolveAtRiskAt < at(100) ? expected.resolveAtRiskAt : at(100),
    );
  });

  it('seeded history is not duplicated: the signal goes in, the identical event is not written again', async () => {
    const t = await ticket();
    await ctx.prisma.ticketEvent.create({
      data: {
        ticketId: t.id,
        type: 'SLA_AT_RISK',
        meta: { target: 'FIRST_REPLY', dueAt: at(60).toISOString() },
        createdAt: at(45),
      },
    });
    await scan(at(50));
    expect(await signals(t.id)).toHaveLength(1);
    expect(await events(t.id)).toHaveLength(1);
  });

  it('two scans at once record a crossing once', async () => {
    const t = await ticket();
    await Promise.all([scan(at(50)), scan(at(50)), scan(at(50))]);
    expect(await signals(t.id)).toHaveLength(1);
    expect(await events(t.id)).toHaveLength(1);
    expect(await slaJobs(t.id)).toHaveLength(1);
  });

  it('notifies the assignee and the team leads (in-app + email); unassigned → leads only', async () => {
    const assigned = await ticket();
    const unassigned = await ticket({ assigneeId: null });
    await scan(at(50));
    for (const [t, expected] of [
      [assigned, [w.agentA.id, w.leadA.id]],
      [unassigned, [w.leadA.id]],
    ] as const) {
      const [job] = await slaJobs(t.id);
      const result = await processNotificationEvent(
        worker,
        notificationEventSchema.parse(job!.data),
      );
      expect(result).toMatchObject({ deliveries: expected.length, inApp: expected.length });
      const inApp = await ctx.prisma.notification.findMany({ where: { ticketId: t.id } });
      expect(inApp.map((n) => n.userId).sort()).toEqual([...expected].sort());
      expect(inApp[0]).toMatchObject({
        type: 'SLA_AT_RISK',
        data: { target: 'FIRST_REPLY', dueAt: at(60).toISOString(), priority: 'P2' },
      });
      const deliveries = await ctx.prisma.notificationDelivery.findMany({
        where: { ticketId: t.id },
      });
      expect(deliveries.map((d) => `${d.templateKey}:${d.userId}`).sort()).toEqual(
        expected.map((id) => `SLA_AT_RISK:${id}`).sort(),
      );
      // A retried job creates nothing new.
      expect(
        await processNotificationEvent(worker, notificationEventSchema.parse(job!.data)),
      ).toMatchObject({ inApp: 0 });
    }
  });

  it('an announcement whose enqueue failed after the commit is retried by the next scan', async () => {
    const t = await ticket();
    let calls = 0;
    const down: WorkerContext = {
      ...worker,
      queues: {
        ...worker.queues,
        enqueueEvent: async () => {
          calls += 1;
          throw new Error('Redis is down');
        },
      },
    };
    // The crossing is recorded (and marked to announce), the enqueue fails: not thrown, kept.
    expect(await runSlaScan(down, { now: at(50), teamIds: [w.teamA.id] })).toMatchObject({
      signals: 1,
      notified: 0,
    });
    expect(calls).toBe(1);
    expect(await signals(t.id)).toMatchObject([
      { kind: 'AT_RISK', notify: true, enqueuedAt: null },
    ]);
    expect(await slaJobs(t.id)).toHaveLength(0);
    // The next tick (any worker) enqueues it once and marks it.
    expect(await scan(at(51))).toMatchObject({ signals: 0, notified: 1 });
    expect((await slaJobs(t.id)).map((j) => j.id)).toEqual([
      `sla-${t.id}-FIRST_REPLY-AT_RISK-${at(60).getTime()}`,
    ]);
    expect((await signals(t.id))[0]!.enqueuedAt).toEqual(at(51));
    expect(await scan(at(52))).toMatchObject({ notified: 0 });
  });

  it('a pending announcement is given up after 60 minutes (D10)', async () => {
    const t = await ticket({ firstReplyDueAt: at(600), firstReplyAtRiskAt: at(45) });
    const down: WorkerContext = {
      ...worker,
      queues: {
        ...worker.queues,
        enqueueEvent: async () => {
          throw new Error('Redis is down');
        },
      },
    };
    await runSlaScan(down, { now: at(50), teamIds: [w.teamA.id] });
    await scan(at(50 + 61));
    expect(await slaJobs(t.id)).toHaveLength(0);
  });

  it('a crossing a priority change put in the past is announced as fresh from the change', async () => {
    // Re-targeted at +300 min: the first reply was due at +60, so its breach is 4 hours old.
    const retargeted = await ticket({ slaTargetsChangedAt: at(300) });
    const historical = await ticket();
    await scan(at(301));
    expect((await slaJobs(retargeted.id)).map((j) => j.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'FIRST_REPLY', kind: 'BREACHED' }),
      ]),
    );
    // Without a re-targeting the same crossing is historical: flagged silently.
    expect(await signals(historical.id)).not.toHaveLength(0);
    expect(await slaJobs(historical.id)).toHaveLength(0);
  });

  it('the newest crossings are scanned first (an old backlog cannot hold a fresh one back)', async () => {
    const old = await ticket({
      createdAt: at(-2000),
      firstReplyDueAt: at(-1940),
      firstReplyAtRiskAt: at(-1955),
      resolveDueAt: at(-1520),
      resolveAtRiskAt: at(-1640),
    });
    const fresh = await ticket();
    const result = await runSlaScan(worker, { now: at(50), teamIds: [w.teamA.id], batch: 1 });
    expect(result).toMatchObject({ signals: 1, notified: 1 });
    expect(await signals(fresh.id)).toHaveLength(1);
    expect(await signals(old.id)).toHaveLength(0);
    // The backlog is drained by the following ticks, silently.
    await runSlaScan(worker, { now: at(51), teamIds: [w.teamA.id], batch: 1 });
    expect(await signals(old.id)).not.toHaveLength(0);
    expect(await slaJobs(old.id)).toHaveLength(0);
  });

  it('an alert answered, paused or re-targeted before it goes out is dropped (event and delivery)', async () => {
    const t = await ticket();
    await scan(at(50));
    const [job] = await slaJobs(t.id);
    // The agent answers before the fan-out runs.
    await ctx.prisma.ticket.update({ where: { id: t.id }, data: { firstRepliedAt: at(50) } });
    expect(
      await processNotificationEvent(worker, notificationEventSchema.parse(job!.data)),
    ).toEqual({
      skipped: 'sla-target-met-or-moved',
    });
    // A delivery already queued (e.g. retried after an SMTP outage) is skipped too.
    const u = await ticket();
    const delivery = {
      dedupeKey: `test-sla-${u.id}`,
      channel: 'EMAIL',
      template: 'SLA_AT_RISK',
      ticketId: u.id,
      userId: w.agentA.id,
      context: { target: 'RESOLUTION', kind: 'AT_RISK', dueAt: at(480).toISOString() },
    } as const;
    await queueDeliveries(worker, [{ job: delivery, recipientMasked: 'x' }]);
    await ctx.prisma.ticket.update({ where: { id: u.id }, data: { status: 'PENDING' } });
    expect(await processDelivery(worker, deliveryJobSchema.parse(delivery))).toMatchObject({
      status: 'SKIPPED',
    });
    // Still valid: it goes out.
    await ctx.prisma.ticket.update({ where: { id: u.id }, data: { status: 'OPEN' } });
    const second = { ...delivery, dedupeKey: `test-sla2-${u.id}` };
    await queueDeliveries(worker, [{ job: second, recipientMasked: 'x' }]);
    expect(await processDelivery(worker, deliveryJobSchema.parse(second))).toEqual({
      status: 'SENT',
    });
  });
});
