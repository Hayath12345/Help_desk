import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/jobs/context.ts';
import { earlyToleranceMs, processEscalationStep } from '../src/jobs/escalation.ts';
import type { Workers } from '../src/jobs/workers.ts';
import { runSlaScan } from '../src/jobs/sla-scan.ts';
import { escalationJobId } from '../src/lib/job-data.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import {
  startTestWorkers,
  testChain,
  testPhone,
  testWorkerContext,
  waitFor,
} from './worker-helpers.ts';

// E13 — admin edits re-time the pending steps of open P1 tickets (the Phase 3 carry-over): a step
// whose delay was lengthened fires at its old time, sees it is early and waits again under the same
// job id until `p1Since + afterMins`; a step whose delay was shortened is promoted by the next SLA
// scan (the safety net) instead of waiting for its old time. Real BullMQ workers on this context's
// own queues; an escalation "minute" lasts MINUTE_MS.

const MINUTE_MS = 300;

describe('escalation re-timing after admin edits (E13)', () => {
  let ctx: TestContext;
  let w: World;
  let workers: Workers;
  let superAdmin: Persona;
  let step2: { id: string };

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    await ctx.prisma.user.update({ where: { id: w.agentA.id }, data: { phone: testPhone() } });
    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { onCallUserId: w.agentA.id },
    });
    // Step 1 on-call at 0, step 2 team leads, step 3 far away (never reached here).
    await testChain(ctx, w.teamA.id, w.admin.id, [
      { channels: ['EMAIL'] },
      { afterMins: 2, channels: ['EMAIL'] },
      { afterMins: 500, channels: ['EMAIL'] },
    ]);
    step2 = await ctx.prisma.escalationRule.findFirstOrThrow({
      where: { teamId: w.teamA.id, step: 2 },
    });
    superAdmin = await persona(
      ctx,
      await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, role: 'SUPER_ADMIN' }),
    );
    workers = await startTestWorkers(ctx, { escalationMinuteMs: MINUTE_MS });
  });
  afterAll(async () => {
    await workers?.close();
    await ctx?.close();
  });

  /** Sets step 2's delay through the admin API (as an admin would). */
  async function setStep2(afterMins: number) {
    const rule = await ctx.prisma.escalationRule.findUniqueOrThrow({ where: { id: step2.id } });
    if (rule.afterMins === afterMins) return;
    const res = await apiAs(ctx, superAdmin).patch(`/admin/escalation/${step2.id}`, {
      expectedUpdatedAt: rule.updatedAt.toISOString(),
      afterMins,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  /** A P1 on team A (an upgrade starts the chain: step 1 now, step 2 scheduled by step 1). */
  async function p1() {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const up = await apiAs(ctx, w.agentA).patch(`/tickets/${t.id}`, { priority: 'P1' });
    expect(up.statusCode, up.body).toBe(200);
    const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    return { id: t.id, p1Since: row.p1Since! };
  }
  const state = (t: { id: string }) =>
    ctx.prisma.ticket.findUniqueOrThrow({
      where: { id: t.id },
      select: { p1EscalationStep: true },
    });
  const escalatedAt = async (t: { id: string }, step: number) =>
    (
      await ctx.prisma.ticketEvent.findFirst({
        where: { ticketId: t.id, type: 'ESCALATED', toValue: String(step) },
      })
    )?.createdAt ?? null;
  const step2Job = (t: { id: string; p1Since: Date }) =>
    ctx.queues.escalation.getJob(escalationJobId(t.id, t.p1Since, 2));

  it('a lengthened delay: the step fires at its old time, waits again, then fires at the new one', async () => {
    await setStep2(2);
    const t = await p1();
    // Step 1 fired and scheduled step 2 for p1Since + 2 minutes.
    await waitFor(async () => (await state(t)).p1EscalationStep === 1, { what: 'step 1' });
    await waitFor(async () => (await (await step2Job(t))?.getState()) === 'delayed', {
      what: 'step 2 scheduled',
    });
    await setStep2(8); // the admin lengthens it
    // Past the old time: step 2 ran, found it early, and is delayed again (same job, no attempt used).
    await waitFor(async () => Date.now() > t.p1Since.getTime() + 4 * MINUTE_MS, {
      what: 'the old time to pass',
    });
    expect((await state(t)).p1EscalationStep).toBe(1);
    const waiting = await step2Job(t);
    expect(await waiting?.getState()).toBe('delayed');
    expect(waiting?.attemptsMade).toBe(0);
    // It fires at the new time, not before.
    const fired = await waitFor(() => escalatedAt(t, 2), { what: 'step 2', timeout: 10_000 });
    expect(fired.getTime()).toBeGreaterThanOrEqual(
      t.p1Since.getTime() + 8 * MINUTE_MS - earlyToleranceMs(MINUTE_MS),
    );
    expect((await state(t)).p1EscalationStep).toBe(2);
  });

  it('a shortened delay: the next SLA scan fires the step instead of its old time', async () => {
    await setStep2(40); // 12 s
    const t = await p1();
    await waitFor(async () => (await (await step2Job(t))?.getState()) === 'delayed', {
      what: 'step 2 scheduled',
    });
    await setStep2(1); // the admin shortens it: due at p1Since + 300 ms
    await waitFor(async () => Date.now() > t.p1Since.getTime() + 2 * MINUTE_MS, {
      what: 'the new time to pass',
    });
    expect((await state(t)).p1EscalationStep).toBe(1); // still waiting for the old time
    const scan = await runSlaScan(workers.context, { now: new Date(), teamIds: [w.teamA.id] });
    expect(scan.escalationsResumed).toBeGreaterThanOrEqual(1);
    const fired = await waitFor(() => escalatedAt(t, 2), { what: 'step 2', timeout: 5_000 });
    expect(fired.getTime()).toBeLessThan(t.p1Since.getTime() + 40 * MINUTE_MS);
    // Nothing left to promote.
    const again = await runSlaScan(workers.context, { now: new Date(), teamIds: [w.teamA.id] });
    expect(again.escalationsResumed).toBe(0);
  });

  it('an early step run outside BullMQ is scheduled again under its own id', async () => {
    await setStep2(30);
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const p1Since = new Date();
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { priority: 'P1', p1Since, p1EscalationStep: 1 },
    });
    const direct: WorkerContext = testWorkerContext(ctx, { escalationMinuteMs: MINUTE_MS });
    const result = await processEscalationStep(direct, {
      ticketId: t.id,
      p1Since: p1Since.toISOString(),
      step: 2,
    });
    expect(result).toMatchObject({ waiting: expect.any(Number) });
    expect((result as { waiting: number }).waiting).toBeGreaterThan(20 * MINUTE_MS);
    const job = await ctx.queues.escalation.getJob(escalationJobId(t.id, p1Since, 2));
    expect(await job?.getState()).toBe('delayed');
    expect((await state(t)).p1EscalationStep).toBe(1);
    await job?.remove();
  });
});
