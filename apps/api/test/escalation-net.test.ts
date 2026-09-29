import { UnrecoverableError, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/jobs/context.ts';
import { processEscalationStep, resumeStalledEscalations } from '../src/jobs/escalation.ts';
import { runSlaScan } from '../src/jobs/sla-scan.ts';
import { escalationJobId } from '../src/lib/job-data.ts';
import { ESCALATION_JOB_OPTIONS } from '../src/lib/queues.ts';
import { createBullConnection } from '../src/lib/redis.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';
import { testChain, testPhone, testWorkerContext, waitFor } from './worker-helpers.ts';

// Escalation reliability (integration review): step jobs retry for about 30 minutes, the SLA
// scan's safety net re-schedules an overdue step that has no live job (a failed enqueue of step 1,
// a step that dead-lettered during an outage), and an acknowledgement that lands while a step
// fans out leaves no "escalated" bell item. Escalation minutes are 1 s here; tickets are made P1
// behind the API's back, so no job exists unless the test adds one.

const MINUTE_MS = 1_000;

describe('P1 escalation safety net', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    await ctx.prisma.user.update({ where: { id: w.agentA.id }, data: { phone: testPhone() } });
    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { onCallUserId: w.agentA.id },
    });
    await testChain(ctx, w.teamA.id, w.admin.id);
    worker = testWorkerContext(ctx, { escalationMinuteMs: MINUTE_MS });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A P1 period that started `minutesAgo` escalation minutes ago, `step` steps fired. */
  async function p1(minutesAgo: number, data: Record<string, unknown> = {}) {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const p1Since = new Date(Date.now() - minutesAgo * MINUTE_MS);
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { priority: 'P1', p1Since, ...data },
    });
    return { ...t, p1Since };
  }
  const job = (t: { id: string; p1Since: Date }, step: number) =>
    ctx.queues.escalation.getJob(escalationJobId(t.id, t.p1Since, step));
  const net = () => resumeStalledEscalations(worker, { now: new Date(), teamIds: [w.teamA.id] });

  it('step jobs retry for about 30 minutes, not ~150 s', async () => {
    const t = await p1(0);
    await ctx.queues.scheduleEscalation(
      { ticketId: t.id, p1Since: t.p1Since.toISOString(), step: 1 },
      60_000,
    );
    const j = await job(t, 1);
    expect(j!.opts.attempts).toBe(ESCALATION_JOB_OPTIONS.attempts);
    expect(j!.opts.backoff).toEqual(ESCALATION_JOB_OPTIONS.backoff);
    expect(
      ESCALATION_JOB_OPTIONS.attempts * ESCALATION_JOB_OPTIONS.backoff.delay,
    ).toBeGreaterThanOrEqual(30 * 60_000);
    await j!.remove();
  });

  it('re-schedules an overdue step that has no job (e.g. the API could not enqueue step 1)', async () => {
    const lost = await p1(10);
    const onTime = await p1(1); // step 1 is due, but not past the grace period yet
    expect(await net()).toBeGreaterThanOrEqual(1);
    const resumed = await job(lost, 1);
    expect(resumed).toBeDefined();
    expect(resumed!.data).toEqual({
      ticketId: lost.id,
      p1Since: lost.p1Since.toISOString(),
      step: 1,
    });
    expect(await job(onTime, 1)).toBeUndefined();
    // Idempotent: a second tick sees the live job and adds nothing.
    const again = await net();
    expect(await job(lost, 1)).toBeDefined();
    expect(again).toBe(0);
    await resumed!.remove();
  });

  it('retries a step that failed for good, and continues after the last step fired', async () => {
    // Step 2 (team leads, +5) is overdue; its job dead-lettered.
    const t = await p1(10, { p1EscalationStep: 1 });
    await ctx.queues.scheduleEscalation(
      { ticketId: t.id, p1Since: t.p1Since.toISOString(), step: 2 },
      0,
    );
    // Attempts exhausted: a worker whose every run fails (the database is down).
    const connection = createBullConnection(ctx.config.redisUrl, undefined, 'net-test');
    const down = new Worker(
      ctx.queues.escalation.name,
      async () => {
        throw new UnrecoverableError('database unavailable');
      },
      { connection, prefix: ctx.queues.prefix },
    );
    await waitFor(async () => (await (await job(t, 2))?.getState()) === 'failed');
    await down.close();
    await connection.quit();
    expect(await net()).toBeGreaterThanOrEqual(1);
    expect(await (await job(t, 2))!.getState()).not.toBe('failed');
    await (await job(t, 2))!.remove();
  });

  it('leaves alone: acknowledged, historical (no p1Since), finished chains, completed steps', async () => {
    const acked = await p1(10, { p1AckedAt: new Date(), p1AckedById: w.agentA.id });
    const historical = await createTicket(ctx, w.clientX, ticketBody(w));
    await ctx.prisma.ticket.update({ where: { id: historical.id }, data: { priority: 'P1' } });
    const done = await p1(30, { p1EscalationStep: 3 });
    const old = await p1(25 * 60 * 60); // started more than 24 h (of escalation minutes) ago
    await net();
    expect(await job(acked, 1)).toBeUndefined();
    expect(await job(done, 1)).toBeUndefined();
    expect(await job(old, 1)).toBeUndefined();
    const jobs = await ctx.queues.escalation.getJobs(['waiting', 'delayed']);
    expect(jobs.filter((j) => j?.data.ticketId === historical.id)).toHaveLength(0);
  });

  it('runs on every SLA scan tick', async () => {
    const t = await p1(10);
    const result = await runSlaScan(worker, { now: new Date(), teamIds: [w.teamA.id] });
    expect(result.escalationsResumed).toBeGreaterThanOrEqual(1);
    const resumed = await job(t, 1);
    expect(resumed).toBeDefined();
    await resumed!.remove();
  });

  it('an acknowledgement that lands while a step fans out creates no "escalated" bell item', async () => {
    const t = await p1(6, { p1EscalationStep: 1 });
    let acked = false;
    const racing: WorkerContext = {
      ...worker,
      queues: {
        ...worker.queues,
        // The first delivery is being queued when an agent acknowledges.
        enqueueDelivery: async (d) => {
          if (!acked) {
            acked = true;
            await ctx.prisma.ticket.update({
              where: { id: t.id },
              data: { p1AckedAt: new Date(), p1AckedById: w.agentA.id },
            });
          }
          return worker.queues.enqueueDelivery(d);
        },
      },
    };
    const result = await processEscalationStep(racing, {
      ticketId: t.id,
      p1Since: t.p1Since.toISOString(),
      step: 2,
    });
    expect(result).toMatchObject({ step: 2 });
    expect(acked).toBe(true);
    expect(await ctx.prisma.notification.count({ where: { ticketId: t.id } })).toBe(0);
    await ctx.queues.removeJobs('escalation', [escalationJobId(t.id, t.p1Since, 3)]);
  });
});
