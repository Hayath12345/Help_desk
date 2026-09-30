import type { Prisma } from '@loons/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/jobs/context.ts';
import { processEscalationStep, resumeStalledEscalations } from '../src/jobs/escalation.ts';
import { processNotificationEvent } from '../src/jobs/events.ts';
import { deliveryJobId, escalationJobId } from '../src/lib/job-data.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import { testChain, testPhone, testWorkerContext } from './worker-helpers.ts';

// The order of a P1 chain (review findings api-sla-1, api-sla-2, api-sla-3):
// - `afterMins` never goes down along a chain: create, edit and restore refuse a step that would
//   fire before the step above it (or after the step below it), and a reorder keeps the delays in
//   place (step k keeps its time slot; the targets and channels move). A chain that is out of order
//   anyway (older data) still pages everyone: the "next step in" minutes of the P1 alert are never
//   negative, so the alert, the list email and the Teams card are queued.
// - A step job fires the first rule of the chain that has not fired in this P1 period (the fired
//   rules are the ESCALATED events' rule ids), so a reorder while a P1 is mid-chain neither pages a
//   rule twice nor skips one.
// - The safety net promotes a step whose shortened delay has passed even for P1 periods older than
//   a day (step delays go up to 7 days).
// Each test uses its own team; tickets are moved to it behind the API's back and no BullMQ worker
// runs (the processors are called directly). Escalation minutes are 1 s.

const MINUTE_MS = 1_000;

describe('P1 chain order', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;
  let superAdmin: Persona;

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    await ctx.prisma.user.update({ where: { id: w.agentA.id }, data: { phone: testPhone() } });
    worker = testWorkerContext(ctx, { escalationMinuteMs: MINUTE_MS });
    superAdmin = await persona(
      ctx,
      await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, role: 'SUPER_ADMIN' }),
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const api = () => apiAs(ctx, superAdmin);

  /** A team with an on-call user, a webhook, a list address and its own chain (by step). */
  async function chainTeam(steps: Array<Partial<Prisma.EscalationRuleUncheckedCreateInput>> = []) {
    const team = await ctx.fixtures.team();
    await ctx.prisma.team.update({
      where: { id: team.id },
      data: {
        onCallUserId: w.agentA.id,
        teamsWebhookUrl: 'https://contoso.webhook.office.com/webhookb2/test',
        emails: [`p1-list-${rand(4)}@example.test`],
      },
    });
    await testChain(ctx, team.id, w.admin.id, steps);
    const rules = await ctx.prisma.escalationRule.findMany({
      where: { teamId: team.id },
      orderBy: { step: 'asc' },
    });
    return { team, rules };
  }

  /** A P1 of `teamId` that started `minutesAgo` escalation minutes ago. */
  async function p1(teamId: string, minutesAgo: number, data: Prisma.TicketUpdateInput = {}) {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const p1Since = new Date(Date.now() - minutesAgo * MINUTE_MS);
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { team: { connect: { id: teamId } }, priority: 'P1', p1Since, ...data },
    });
    return { id: t.id, p1Since };
  }
  const stepJob = (t: { id: string; p1Since: Date }, step: number) => ({
    ticketId: t.id,
    p1Since: t.p1Since.toISOString(),
    step,
  });
  /** The delivery rows of a ticket, each with its queued job (undefined when none was added). */
  async function deliveries(ticketId: string) {
    const rows = await ctx.prisma.notificationDelivery.findMany({ where: { ticketId } });
    return Promise.all(
      rows.map(async (row) => ({
        row,
        job: await ctx.queues.notifications.getJob(deliveryJobId(row.dedupeKey)),
      })),
    );
  }
  /** The "next step in" minutes a queued delivery job carries. */
  const minsOf = (job: { data: unknown } | undefined) =>
    (job?.data as { context?: { escalationMins?: number } } | undefined)?.context?.escalationMins;
  const escalations = (ticketId: string) =>
    ctx.prisma.ticketEvent.findMany({
      where: { ticketId, type: 'ESCALATED' },
      orderBy: { createdAt: 'asc' },
    });
  const ruleOf = (e: { meta: Prisma.JsonValue }) => (e.meta as { ruleId?: string }).ruleId;
  async function removeEscalationJobs(t: { id: string; p1Since: Date }) {
    await ctx.queues.removeJobs(
      'escalation',
      Array.from({ length: 6 }, (_, i) => escalationJobId(t.id, t.p1Since, i + 1)),
    );
  }

  describe('a chain whose delays go down (api-sla-1)', () => {
    it('step 1 still pages the on-call user and schedules step 2', async () => {
      // Older data, written behind the API's back: step 1 at 5, step 2 at 0, step 3 at 15.
      const { team } = await chainTeam([{ afterMins: 5 }, { afterMins: 0 }, { afterMins: 15 }]);
      const t = await p1(team.id, 20);
      const result = await processEscalationStep(worker, stepJob(t, 1));
      expect(result).toMatchObject({ step: 1, recipients: 1, next: 2 });
      const queued = await deliveries(t.id);
      const alerts = queued.filter((d) => d.row.templateKey === 'P1_ALERT');
      expect(alerts.map((d) => d.row.channel).sort()).toEqual(['EMAIL', 'SMS']);
      for (const { job } of alerts) {
        expect(job, 'a job behind every P1_ALERT row').toBeDefined();
        // Step 2 fires right after step 1: "0 minutes", never negative.
        expect(minsOf(job)).toBe(0);
      }
      expect(
        await ctx.prisma.notification.count({ where: { ticketId: t.id, type: 'P1_CREATED' } }),
      ).toBe(1);
      expect(await ctx.queues.escalation.getJob(escalationJobId(t.id, t.p1Since, 2))).toBeDefined();
      await removeEscalationJobs(t);
    });

    it('an upgrade to P1 queues the list email and the Teams card', async () => {
      const { team } = await chainTeam([{ afterMins: 20 }, { afterMins: 15 }]);
      const t = await p1(team.id, 0);
      const result = await processNotificationEvent(worker, {
        event: 'p1-started',
        ticketId: t.id,
        p1Since: t.p1Since.toISOString(),
      });
      expect(result).toMatchObject({ deliveries: 2 });
      const queued = await deliveries(t.id);
      const list = queued.find((d) => d.row.templateKey === 'P1_ALERT');
      const card = queued.find((d) => d.row.templateKey === 'P1_CREATED');
      expect(minsOf(list?.job)).toBe(0);
      expect(card?.row.channel).toBe('TEAMS');
      expect(card?.job).toBeDefined();
    });
  });

  describe('the admin API keeps the delays in step order (api-sla-1)', () => {
    it('reorder moves the targets and keeps each step’s time slot', async () => {
      const { team, rules } = await chainTeam();
      const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
      // "Move up" on step 2: the team leads first, then the on-call user.
      const res = await api().post('/admin/escalation/reorder', {
        teamId: team.id,
        expectedIds: [a.id, b.id, c.id],
        ids: [b.id, a.id, c.id],
      });
      expect(res.statusCode, res.body).toBe(204);
      const after = await ctx.prisma.escalationRule.findMany({
        where: { teamId: team.id },
        orderBy: { step: 'asc' },
      });
      expect(after.map((r) => [r.id, r.step, r.afterMins, r.targetType])).toEqual([
        [b.id, 1, 0, 'ROLE'],
        [a.id, 2, 5, 'ON_CALL'],
        [c.id, 3, 15, 'USER'],
      ]);
      // A rule whose delay moved is a changed row (an open edit sheet reloads it); c did not move.
      expect(after[0]!.updatedAt.getTime()).toBeGreaterThan(b.updatedAt.getTime());
      expect(after[2]!.updatedAt.toISOString()).toBe(c.updatedAt.toISOString());
      const audit = await ctx.prisma.adminAuditLog.findFirstOrThrow({
        where: { entity: 'EscalationRule', entityId: team.id, action: 'REORDER' },
      });
      expect(audit).toMatchObject({
        before: { order: [a.id, b.id, c.id], afterMins: { [a.id]: 0, [b.id]: 5 } },
        after: { order: [b.id, a.id, c.id], afterMins: { [b.id]: 0, [a.id]: 5 } },
      });
      // The chain still fires: step 1 pages the leads with a "next step in 5 minutes" alert.
      const t = await p1(team.id, 1);
      expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ step: 1 });
      await removeEscalationJobs(t);
    });

    it('create, edit and restore refuse a step that fires before the one above it', async () => {
      const { team, rules } = await chainTeam(); // 0 / 5 / 15
      const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
      const patch = (rule: { id: string }, body: Record<string, unknown>) =>
        ctx.prisma.escalationRule.findUniqueOrThrow({ where: { id: rule.id } }).then((row) =>
          api().patch(`/admin/escalation/${rule.id}`, {
            expectedUpdatedAt: row.updatedAt.toISOString(),
            ...body,
          }),
        );
      const chainOrder = (res: { statusCode: number; json: () => unknown }) => {
        expect(res.statusCode).toBe(400);
        expect((res.json() as { error: { details: unknown } }).error.details).toEqual([
          expect.objectContaining({ path: ['afterMins'], message: 'validation.chainOrder' }),
        ]);
      };
      chainOrder(await patch(a, { afterMins: 20 })); // after step 2 (5)
      chainOrder(await patch(c, { afterMins: 3 })); // before step 2 (5)
      expect((await patch(b, { afterMins: 15 })).statusCode).toBe(200); // equal is fine
      expect((await patch(b, { afterMins: 10 })).statusCode).toBe(200);
      chainOrder(
        await api().post('/admin/escalation', {
          teamId: team.id,
          step: 4,
          targetType: 'ON_CALL',
          afterMins: 14,
          channels: ['EMAIL'],
        }),
      );
      // Restore: b (10) archived, a moved to 12, then b would fire before a.
      const bRow = await ctx.prisma.escalationRule.findUniqueOrThrow({ where: { id: b.id } });
      const archived = await api().post(`/admin/escalation/${b.id}/archive`, {
        expectedUpdatedAt: bRow.updatedAt.toISOString(),
      });
      expect(archived.statusCode).toBe(200);
      expect((await patch(a, { afterMins: 12 })).statusCode).toBe(200); // next active: c (15)
      chainOrder(
        await api().post(`/admin/escalation/${b.id}/restore`, {
          expectedUpdatedAt: archived.json().item.updatedAt,
        }),
      );
      expect(
        (await ctx.prisma.escalationRule.findUniqueOrThrow({ where: { id: b.id } })).isActive,
      ).toBe(false);
    });

    it('a chain already out of order can still be edited (only a new delay is checked)', async () => {
      const { rules } = await chainTeam([{ afterMins: 5 }, { afterMins: 0 }, { afterMins: 15 }]);
      const a = rules[0]!;
      const res = await api().patch(`/admin/escalation/${a.id}`, {
        expectedUpdatedAt: a.updatedAt.toISOString(),
        channels: ['EMAIL'],
      });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  describe('a reorder while a P1 is mid-chain (api-sla-2)', () => {
    it('the pending step pages the rule that has not fired, never one that already did', async () => {
      const { team, rules } = await chainTeam(); // A on-call 0, B team leads 5, C manager 15
      const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
      await ctx.fixtures.member(team.id, w.leadA.id, 'LEAD');
      const t = await p1(team.id, 20);
      expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ next: 2 });
      expect(await processEscalationStep(worker, stepJob(t, 2))).toMatchObject({ next: 3 });
      expect((await escalations(t.id)).map(ruleOf)).toEqual([a.id, b.id]);
      // Only the step-3 job the worker scheduled is pending (steps 1 and 2 ran here, not in BullMQ).
      await ctx.queues.removeJobs('escalation', [escalationJobId(t.id, t.p1Since, 2)]);
      // The admin moves the manager up: A, C, B.
      const res = await api().post('/admin/escalation/reorder', {
        teamId: team.id,
        expectedIds: [a.id, b.id, c.id],
        ids: [a.id, c.id, b.id],
      });
      expect(res.statusCode, res.body).toBe(204);
      // The safety net sees the same pending job (no second one under another id).
      await resumeStalledEscalations(worker, { now: new Date(), teamIds: [team.id] });
      const pending = await ctx.queues.escalation.getJobs(['waiting', 'delayed']);
      expect(
        pending
          .filter((j) => j?.data.ticketId === t.id)
          .map((j) => j!.id)
          .sort(),
      ).toEqual([escalationJobId(t.id, t.p1Since, 3)]);
      // The pending step-3 job pages the manager (C), not the team leads again, and ends the chain.
      const third = await processEscalationStep(worker, stepJob(t, 3));
      expect(third).toMatchObject({ step: 3, recipients: 1, next: null });
      expect((await escalations(t.id)).map(ruleOf)).toEqual([a.id, b.id, c.id]);
      const leadPages = await ctx.prisma.notification.count({
        where: { ticketId: t.id, userId: w.leadA.id },
      });
      expect(leadPages).toBe(1);
      expect(
        await ctx.prisma.notification.count({ where: { ticketId: t.id, userId: w.admin.id } }),
      ).toBe(1);
      await removeEscalationJobs(t);
    });

    it('a step still to come after a reorder fires at its new slot; a fired one is not repeated', async () => {
      const { team, rules } = await chainTeam(); // A 0, B 5, C 15
      const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
      const t = await p1(team.id, 20);
      expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ next: 2 });
      // Before step 2 fires the admin puts C first: C, A, B (slots 0, 5, 15).
      const res = await api().post('/admin/escalation/reorder', {
        teamId: team.id,
        expectedIds: [a.id, b.id, c.id],
        ids: [c.id, a.id, b.id],
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(await processEscalationStep(worker, stepJob(t, 2))).toMatchObject({
        step: 2,
        next: 3,
      });
      expect(await processEscalationStep(worker, stepJob(t, 3))).toMatchObject({
        step: 3,
        next: null,
      });
      expect((await escalations(t.id)).map(ruleOf)).toEqual([a.id, c.id, b.id]);
      await removeEscalationJobs(t);
    });

    it('after a reorder the next job is scheduled for the next rule still to fire, at its slot', async () => {
      const { team, rules } = await chainTeam(); // A on-call 0, B team leads 5, C manager 15
      const [a, b, c] = rules as [(typeof rules)[0], (typeof rules)[0], (typeof rules)[0]];
      const t = await p1(team.id, 0);
      expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ next: 2 });
      // A has fired; the admin reorders to B, C, A (slots 0, 5, 15).
      const res = await api().post('/admin/escalation/reorder', {
        teamId: team.id,
        expectedIds: [a.id, b.id, c.id],
        ids: [b.id, c.id, a.id],
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(await processEscalationStep(worker, stepJob(t, 2))).toMatchObject({
        step: 2,
        next: 3,
      });
      expect((await escalations(t.id)).map(ruleOf)).toEqual([a.id, b.id]);
      // Job 3 is C at its 5-minute slot, not A (fired already) at 15.
      const third = await ctx.queues.escalation.getJob(escalationJobId(t.id, t.p1Since, 3));
      expect(third).toBeTruthy();
      const dueAt = third!.timestamp + (third!.opts.delay ?? 0);
      expect(dueAt - t.p1Since.getTime()).toBeLessThanOrEqual(5 * MINUTE_MS + 500);
      await removeEscalationJobs(t);
    });

    it('the first page of a period is the P1 alert even when the first rule is not step 1', async () => {
      const { team, rules } = await chainTeam(); // A on-call 0, B team leads 5, C manager 15
      const [a, b] = rules as [(typeof rules)[0], (typeof rules)[0]];
      await ctx.fixtures.member(team.id, w.leadA.id, 'LEAD');
      // Step 1 is archived before the P1 starts: the chain now begins at step 2 (B).
      const archived = await api().post(`/admin/escalation/${a.id}/archive`, {
        expectedUpdatedAt: a.updatedAt.toISOString(),
      });
      expect(archived.statusCode, archived.body).toBe(200);
      const t = await p1(team.id, 20);
      expect(await processEscalationStep(worker, stepJob(t, 1))).toMatchObject({ step: 1 });
      expect((await escalations(t.id)).map(ruleOf)).toEqual([b.id]);
      // Nothing had fired in the period: this is the P1 alert, not an "escalated" page.
      const pages = await ctx.prisma.notification.findMany({
        where: { ticketId: t.id, userId: w.leadA.id },
        select: { type: true },
      });
      expect(pages).toEqual([{ type: 'P1_CREATED' }]);
      await removeEscalationJobs(t);
    });
  });

  describe('the safety net and long delays (api-sla-3)', () => {
    it('promotes a shortened step of a P1 that started more than a day ago', async () => {
      const { team } = await chainTeam(); // step 2 at 5 (due long ago)
      const DAY = 24 * 60 * 60_000;
      const since = (DAY + 60 * 60_000) / MINUTE_MS; // 25 h ago
      const t = await p1(team.id, since, { p1EscalationStep: 1 });
      await ctx.queues.scheduleEscalation(stepJob(t, 2), 2 * DAY);
      const lost = await p1(team.id, since, { p1EscalationStep: 1 }); // no job at all
      const resumed = await resumeStalledEscalations(worker, {
        now: new Date(),
        teamIds: [team.id],
      });
      expect(resumed).toBe(1);
      const job = await ctx.queues.escalation.getJob(escalationJobId(t.id, t.p1Since, 2));
      expect(await job?.getState()).toBe('waiting');
      // D10: a missing step of a period older than a day is not re-created.
      expect(
        await ctx.queues.escalation.getJob(escalationJobId(lost.id, lost.p1Since, 2)),
      ).toBeUndefined();
      await removeEscalationJobs(t);
    });
  });
});
