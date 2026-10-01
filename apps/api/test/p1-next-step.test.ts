import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ticketResponseSchema, type TicketDetailDto } from '@loons/shared';
import type { WorkerContext } from '../src/jobs/context.ts';
import { processEscalationStep } from '../src/jobs/escalation.ts';
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
import { testChain, testWorkerContext } from './worker-helpers.ts';

// Phase 5 F15 (Phase 4 limitation): the ticket detail's staff-only `p1NextStep` is the step the
// worker fires next — the first rule of the chain in force that has not fired in this P1 period
// (fired rules are the period's ESCALATED events), with the job number it fires as — so after an
// admin reorder mid-chain the banner shows the rule that really pages next, not "the rule after
// step N". Checked against the real step processor. Escalation minutes are 1 s here.

const MINUTE_MS = 1_000;

describe('ticket detail p1NextStep (F15)', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;
  let superAdmin: Persona;
  let agentP: Persona;
  let team: { id: string };
  let rules: Array<{ id: string; step: number; afterMins: number }>;

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    worker = testWorkerContext(ctx, { escalationMinuteMs: MINUTE_MS });
    const staffDomain = ctx.config.staffEmailDomain;
    superAdmin = await persona(ctx, await ctx.fixtures.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    team = await ctx.fixtures.team();
    const p = await ctx.fixtures.staff({ staffDomain, name: 'Pia Agent' });
    await ctx.fixtures.member(team.id, p.id);
    agentP = await persona(ctx, p);
    // On-call at 0, team leads at 5, a manager at 15 (team rules replace the global chain).
    await testChain(ctx, team.id, w.admin.id);
    rules = await ctx.prisma.escalationRule.findMany({
      where: { teamId: team.id },
      orderBy: { step: 'asc' },
      select: { id: true, step: true, afterMins: true },
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** A P1 of team P whose period started `minutesAgo` escalation minutes ago. */
  async function p1(minutesAgo: number) {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const p1Since = new Date(Date.now() - minutesAgo * MINUTE_MS);
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { team: { connect: { id: team.id } }, priority: 'P1', p1Since, status: 'OPEN' },
    });
    return { id: t.id, p1Since };
  }
  async function detail(as: Persona, id: string): Promise<TicketDetailDto> {
    const res = await apiAs(ctx, as).get(`/tickets/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return ticketResponseSchema.parse(res.json()).ticket;
  }
  const stepJob = (t: { id: string; p1Since: Date }, step: number) => ({
    ticketId: t.id,
    p1Since: t.p1Since.toISOString(),
    step,
  });
  const lastFired = async (ticketId: string) => {
    const e = await ctx.prisma.ticketEvent.findFirstOrThrow({
      where: { ticketId, type: 'ESCALATED' },
      orderBy: { createdAt: 'desc' },
    });
    return { step: Number(e.toValue), ruleId: (e.meta as { ruleId: string }).ruleId };
  };
  const dueAt = (p1Since: Date, afterMins: number) =>
    new Date(p1Since.getTime() + afterMins * MINUTE_MS).toISOString();

  it('follows the rules that fired, across an admin reorder mid-chain — as the worker does', async () => {
    const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
    const t = await p1(20);

    // Nothing fired yet: step 1, the on-call rule, due at once.
    expect((await detail(agentP, t.id)).p1NextStep).toEqual({
      step: 1,
      ruleId: a.id,
      ruleStep: 1,
      targetType: 'ON_CALL',
      afterMins: 0,
      dueAt: dueAt(t.p1Since, 0),
    });

    // The worker fires step 1 (rule a); next: rule b as step 2, five minutes in.
    expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ step: 1 });
    expect(await lastFired(t.id)).toEqual({ step: 1, ruleId: a.id });
    const afterOne = await detail(agentP, t.id);
    expect(afterOne.p1EscalationStep).toBe(1);
    expect(afterOne.p1NextStep).toEqual({
      step: 2,
      ruleId: b.id,
      ruleStep: 2,
      targetType: 'ROLE',
      afterMins: 5,
      dueAt: dueAt(t.p1Since, 5),
    });

    // An admin reorder mid-chain: c, a, b (each step keeps its time slot: c now at 0, a at 5,
    // b at 15). Rule a already fired, so c — now first — is next, as step 2 and overdue. "The
    // rule after step 1" would be a again.
    const res = await apiAs(ctx, superAdmin).post('/admin/escalation/reorder', {
      teamId: team.id,
      expectedIds: [a.id, b.id, c.id],
      ids: [c.id, a.id, b.id],
    });
    expect(res.statusCode, res.body).toBe(204);
    const afterReorder = await detail(agentP, t.id);
    expect(afterReorder.p1Chain).toEqual([
      { step: 1, afterMins: 0 },
      { step: 2, afterMins: 5 },
      { step: 3, afterMins: 15 },
    ]);
    expect(afterReorder.p1NextStep).toEqual({
      step: 2,
      ruleId: c.id,
      ruleStep: 1,
      targetType: 'USER',
      afterMins: 0,
      dueAt: dueAt(t.p1Since, 0),
    });

    // The worker agrees: the step 2 job fires rule c.
    expect(await processEscalationStep(worker, stepJob(t, 2))).toMatchObject({ step: 2 });
    expect(await lastFired(t.id)).toEqual({
      step: afterReorder.p1NextStep!.step,
      ruleId: afterReorder.p1NextStep!.ruleId,
    });
    // Then rule b (now step 3 at 15) as step 3.
    const afterTwo = await detail(agentP, t.id);
    expect(afterTwo.p1NextStep).toEqual({
      step: 3,
      ruleId: b.id,
      ruleStep: 3,
      targetType: 'ROLE',
      afterMins: 15,
      dueAt: dueAt(t.p1Since, 15),
    });
    expect(await processEscalationStep(worker, stepJob(t, 3))).toMatchObject({ step: 3 });
    expect(await lastFired(t.id)).toEqual({ step: 3, ruleId: b.id });
    // Every rule has fired: nothing next.
    expect((await detail(agentP, t.id)).p1NextStep).toBeNull();
    await ctx.queues.removeJobs(
      'escalation',
      [1, 2, 3, 4].map((step) => escalationJobId(t.id, t.p1Since, step)),
    );

    // Put the chain back for the next test.
    const back = await apiAs(ctx, superAdmin).post('/admin/escalation/reorder', {
      teamId: team.id,
      expectedIds: [c.id, a.id, b.id],
      ids: [a.id, b.id, c.id],
    });
    expect(back.statusCode, back.body).toBe(204);
  });

  it('events of an earlier P1 period do not count', async () => {
    const t = await p1(3);
    // An ESCALATED event of a previous period (another p1Since) for rule a.
    await ctx.prisma.ticketEvent.create({
      data: {
        ticketId: t.id,
        type: 'ESCALATED',
        fromValue: '0',
        toValue: '1',
        meta: { step: 1, ruleId: rules[0]!.id, p1Since: new Date(0).toISOString() },
      },
    });
    expect((await detail(agentP, t.id)).p1NextStep).toMatchObject({
      step: 1,
      ruleId: rules[0]!.id,
    });
  });

  it('null for clients, and when nothing more fires', async () => {
    const t = await p1(1);
    expect((await detail(w.clientX, t.id)).p1NextStep).toBeNull();
    expect((await detail(w.clientX, t.id)).p1Chain).toBeNull();
    expect((await detail(agentP, t.id)).p1NextStep).not.toBeNull();
    // Acknowledged.
    const ack = await apiAs(ctx, agentP).post(`/tickets/${t.id}/acknowledge`);
    expect(ack.statusCode, ack.body).toBe(200);
    expect((await detail(agentP, t.id)).p1NextStep).toBeNull();
    // Solved, not P1, or a P1 without a period (from before Phase 3).
    const solved = await p1(1);
    await ctx.prisma.ticket.update({ where: { id: solved.id }, data: { status: 'SOLVED' } });
    expect((await detail(agentP, solved.id)).p1NextStep).toBeNull();
    const p2 = await p1(1);
    await ctx.prisma.ticket.update({
      where: { id: p2.id },
      data: { priority: 'P2', p1Since: null },
    });
    expect((await detail(agentP, p2.id)).p1NextStep).toBeNull();
    const old = await p1(1);
    await ctx.prisma.ticket.update({ where: { id: old.id }, data: { p1Since: null } });
    expect((await detail(agentP, old.id)).p1NextStep).toBeNull();
  });
});
