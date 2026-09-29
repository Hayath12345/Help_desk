import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDueDates, computeSlaTargets, resumeDueDate } from '@loons/shared';
import { createTestContext, rand, randomIp, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import { testChain } from './worker-helpers.ts';

const MIN = 60_000;

describe('PATCH /tickets/:id (status machine, SLA clocks, events)', () => {
  let ctx: TestContext;
  let w: World;
  let requester: Persona;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    requester = await w.newClientX('Pat Patch');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const newTicket = (overrides: Record<string, unknown> = {}) =>
    createTicket(ctx, requester, ticketBody(w, overrides));
  const patch = (as: Persona, id: string, body: Record<string, unknown>) =>
    apiAs(ctx, as).patch(`/tickets/${id}`, body);
  const events = (ticketId: string) =>
    ctx.prisma.ticketEvent.findMany({
      where: { ticketId, type: { not: 'CREATED' } },
      orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
    });
  const row = (id: string) => ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });

  describe('status', () => {
    it('staff: NEW → OPEN → PENDING → OPEN → SOLVED → OPEN (reopen), one event each', async () => {
      const t = await newTicket();
      for (const status of ['OPEN', 'PENDING', 'OPEN', 'SOLVED', 'OPEN']) {
        const res = await patch(w.agentA, t.id, { status });
        expect(res.statusCode, status).toBe(200);
        expect(res.json().ticket.status).toBe(status);
      }
      const history = (await events(t.id)).map((e) => [e.type, e.fromValue, e.toValue, e.actorId]);
      expect(history).toEqual([
        ['STATUS_CHANGED', 'NEW', 'OPEN', w.agentA.id],
        ['STATUS_CHANGED', 'OPEN', 'PENDING', w.agentA.id],
        ['STATUS_CHANGED', 'PENDING', 'OPEN', w.agentA.id],
        ['STATUS_CHANGED', 'OPEN', 'SOLVED', w.agentA.id],
        ['STATUS_CHANGED', 'SOLVED', 'OPEN', w.agentA.id],
      ]);
    });

    it('SOLVED stamps solvedAt; reopening clears it', async () => {
      const t = await newTicket();
      const solved = (await patch(w.agentA, t.id, { status: 'SOLVED' })).json().ticket;
      expect(solved.solvedAt).toEqual(expect.any(String));
      const reopened = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      expect(reopened.solvedAt).toBeNull();
    });

    it('clients: mark an active ticket solved, reopen a solved one; nothing else', async () => {
      const t = await newTicket();
      const c = requester;
      expect((await patch(c, t.id, { status: 'OPEN' })).statusCode).toBe(409); // NEW → OPEN
      expect((await patch(c, t.id, { status: 'PENDING' })).statusCode).toBe(409);
      const solved = await patch(c, t.id, { status: 'SOLVED' });
      expect(solved.statusCode).toBe(200);
      expect(solved.json().ticket.status).toBe('SOLVED');
      // Another client of the organisation may reopen it.
      const reopened = await patch(w.clientX, t.id, { status: 'OPEN' });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().ticket.status).toBe('OPEN');
      expect((await events(t.id)).map((e) => [e.fromValue, e.toValue, e.actorId])).toEqual([
        ['NEW', 'SOLVED', c.id],
        ['SOLVED', 'OPEN', w.clientX.id],
      ]);
    });

    it('CLOSED is final: status changes, edits and replies → 409 CONFLICT', async () => {
      const t = await newTicket();
      await ctx.prisma.ticket.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
      for (const [as, body] of [
        [w.agentA, { status: 'OPEN' }],
        [w.agentA, { priority: 'P1' }],
        [w.agentA, { tags: ['late'] }],
        [requester, { status: 'OPEN' }],
      ] as const) {
        const res = await patch(as, t.id, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(409);
        expect(res.json().error.code).toBe('CONFLICT');
      }
      expect((await postMessage(ctx, requester, t.id, { body: 'Still broken' })).statusCode).toBe(
        409,
      );
      expect((await events(t.id)).length).toBe(0);
    });

    it('a no-op PATCH → 200, unchanged, no events', async () => {
      const t = await newTicket();
      const before = await row(t.id);
      const res = await patch(w.agentA, t.id, {
        status: 'NEW',
        priority: 'P3',
        impact: 'SINGLE_USER',
        siteId: w.siteX1.id,
        tags: [],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ticket.updatedAt).toBe(before.updatedAt.toISOString());
      expect(await events(t.id)).toEqual([]);
    });

    it('an empty body → 400', async () => {
      const t = await newTicket();
      expect((await patch(w.agentA, t.id, {})).statusCode).toBe(400);
    });
  });

  describe('SLA clocks', () => {
    it('priority change recomputes both due dates from createdAt (P1: 24/7)', async () => {
      const t = await newTicket(); // P3, business hours
      expect((await row(t.id)).slaTargetsChangedAt).toBeNull();
      const before = Date.now();
      const res = await patch(w.agentA, t.id, { priority: 'P1' });
      // The SLA scan announces crossings the new targets put in the past from this moment (D10).
      expect((await row(t.id)).slaTargetsChangedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(res.statusCode).toBe(200);
      const ticket = res.json().ticket;
      const created = Date.parse(ticket.createdAt);
      expect(Date.parse(ticket.firstReplyDueAt) - created).toBe(15 * MIN);
      expect(Date.parse(ticket.resolveDueAt) - created).toBe(240 * MIN);
      expect(ticket.sla.priority).toBe('P1');
      // The at-risk instants move with them (D2): 75 % of 15 min / 4 h, wall-clock.
      expect(Date.parse(ticket.firstReplyAtRiskAt) - created).toBe(11.25 * MIN);
      expect(Date.parse(ticket.resolveAtRiskAt) - created).toBe(180 * MIN);

      // And back to P4 with the business calendar.
      const p4 = (await patch(w.agentA, t.id, { priority: 'P4' })).json().ticket;
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      const policy = await ctx.prisma.slaPolicy.findUniqueOrThrow({ where: { priority: 'P4' } });
      const due = computeSlaTargets(new Date(ticket.createdAt), policy, calendar);
      expect(p4.firstReplyDueAt).toBe(due.firstReplyDueAt.toISOString());
      expect(p4.resolveDueAt).toBe(due.resolveDueAt.toISOString());
      expect(p4.firstReplyAtRiskAt).toBe(due.firstReplyAtRiskAt.toISOString());
      expect(p4.resolveAtRiskAt).toBe(due.resolveAtRiskAt.toISOString());
      const stored = await row(t.id);
      expect([stored.firstReplyAtRiskAt, stored.resolveAtRiskAt]).toEqual([
        due.firstReplyAtRiskAt,
        due.resolveAtRiskAt,
      ]);
      expect((await events(t.id)).map((e) => [e.type, e.fromValue, e.toValue])).toEqual([
        ['PRIORITY_CHANGED', 'P3', 'P1'],
        ['PRIORITY_CHANGED', 'P1', 'P4'],
      ]);
    });

    it('priority change after the first reply keeps firstReplyDueAt', async () => {
      const t = await newTicket({ priority: 'P2' });
      await postMessage(ctx, w.agentA, t.id, { body: 'Looking into it.' });
      const before = await row(t.id);
      const after = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(after.firstReplyDueAt).toBe(before.firstReplyDueAt!.toISOString());
      expect(after.firstReplyAtRiskAt).toBe(before.firstReplyAtRiskAt!.toISOString());
      expect(Date.parse(after.resolveDueAt) - before.createdAt.getTime()).toBe(240 * MIN);
      expect(Date.parse(after.resolveAtRiskAt) - before.createdAt.getTime()).toBe(180 * MIN);
    });

    it('PENDING pauses the resolution clock; leaving it resumes with the time that was left', async () => {
      const t = await newTicket({ priority: 'P2' }); // 24/7: resume adds wall-clock minutes
      const pending = (await patch(w.agentA, t.id, { status: 'PENDING' })).json().ticket;
      expect(pending.slaPausedAt).toEqual(expect.any(String));
      // Pretend the pause started 90 minutes ago.
      const pausedAt = new Date(Date.now() - 90 * MIN);
      await ctx.prisma.ticket.update({ where: { id: t.id }, data: { slaPausedAt: pausedAt } });
      const dueBefore = (await row(t.id)).resolveDueAt!;
      const riskBefore = (await row(t.id)).resolveAtRiskAt!;
      const firstRiskBefore = (await row(t.id)).firstReplyAtRiskAt!;

      const resumed = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      expect(resumed.slaPausedAt).toBeNull();
      // Exactly the paused time later, to the millisecond (review F6: no whole-minute rounding).
      const resumedAt = Date.parse(resumed.updatedAt);
      expect(Date.parse(resumed.resolveDueAt)).toBe(
        dueBefore.getTime() + (resumedAt - pausedAt.getTime()),
      );
      // The resolution at-risk instant moves the same way (D2); the first-reply one never pauses.
      expect(Date.parse(resumed.resolveAtRiskAt)).toBe(
        riskBefore.getTime() + (resumedAt - pausedAt.getTime()),
      );
      expect(resumed.firstReplyAtRiskAt).toBe(firstRiskBefore.toISOString());
      // The finished pause is recorded for later priority changes.
      expect((await row(t.id)).slaPauses).toEqual([
        { from: pausedAt.toISOString(), to: resumed.updatedAt },
      ]);
    });

    it('repeated short pauses never move the target earlier (review F6)', async () => {
      const t = await newTicket({ priority: 'P2' });
      let due = Date.parse(t.resolveDueAt as string);
      let paused = 0;
      for (let i = 0; i < 4; i++) {
        const pending = (await patch(w.agentA, t.id, { status: 'PENDING' })).json().ticket;
        await new Promise((resolve) => setTimeout(resolve, 7 + i * 13));
        const open = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
        const pause = Date.parse(open.updatedAt) - Date.parse(pending.slaPausedAt);
        paused += pause;
        expect(Date.parse(open.resolveDueAt), `cycle ${i}`).toBe(due + pause);
        due = Date.parse(open.resolveDueAt);
      }
      expect(due - Date.parse(t.resolveDueAt as string)).toBe(paused);
      expect(((await row(t.id)).slaPauses as unknown[]).length).toBe(4);
    });

    it('a priority change keeps the credit of earlier pauses (review P2-CC-2 / F1)', async () => {
      // P2 (8 h, 24/7) raised 50 h ago; waited on the client for 48 h after 2 h of work.
      const t = await newTicket({ priority: 'P2' });
      const now = Date.now();
      const createdAt = new Date(now - 50 * 60 * MIN);
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          createdAt,
          status: 'PENDING',
          slaPausedAt: new Date(now - 48 * 60 * MIN),
          firstReplyDueAt: new Date(createdAt.getTime() + 60 * MIN),
          firstRepliedAt: new Date(createdAt.getTime() + 30 * MIN),
          resolveDueAt: new Date(createdAt.getTime() + 8 * 60 * MIN),
        },
      });
      const open = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      const resumedAt = Date.parse(open.updatedAt);
      expect(Date.parse(open.resolveDueAt)).toBe(resumedAt + 6 * 60 * MIN); // 6 h left

      // Escalated to P1 (4 h): 2 h of the window are used, 2 h are left — not 46 h overdue.
      const p1 = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(Date.parse(p1.resolveDueAt)).toBe(resumedAt + 2 * 60 * MIN);
      // At risk after 3 of the 4 h of SLA time: 2 h were used before the pause, so 1 h after it.
      expect(Date.parse(p1.resolveAtRiskAt)).toBe(resumedAt + 60 * MIN);
      const risk = (await apiAs(ctx, w.agentA).get('/tickets?view=risk&limit=100')).json();
      expect(risk.items.map((i: { id: string }) => i.id)).not.toContain(t.id);
      // Back to P2: the same target as before the escalation.
      const p2 = (await patch(w.agentA, t.id, { priority: 'P2' })).json().ticket;
      expect(p2.resolveDueAt).toBe(open.resolveDueAt);
      // A business-hours policy replays the same pause on its own clock.
      const p3 = (await patch(w.agentA, t.id, { priority: 'P3' })).json().ticket;
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      const policy = await ctx.prisma.slaPolicy.findUniqueOrThrow({ where: { priority: 'P3' } });
      const pauses = [{ from: new Date(now - 48 * 60 * MIN), to: new Date(resumedAt) }];
      expect(p3.resolveDueAt).toBe(
        computeDueDates(createdAt, policy, calendar, pauses).resolveDueAt.toISOString(),
      );
      expect(p3.resolveAtRiskAt).toBe(
        computeSlaTargets(createdAt, policy, calendar, pauses).resolveAtRiskAt.toISOString(),
      );
      // The first reply was sent: its target stays.
      expect(p3.firstReplyDueAt).toBe(new Date(createdAt.getTime() + 60 * MIN).toISOString());
    });

    it('pauses via replies are credited too; a change while PENDING keeps both pauses', async () => {
      const t = await newTicket({ priority: 'P2' });
      const now = Date.now();
      const createdAt = new Date(now - 50 * 60 * MIN);
      // 1 h of work, a 2 h pause (already finished), 1 h of work, then PENDING again 46 h ago.
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          createdAt,
          status: 'PENDING',
          slaPausedAt: new Date(now - 46 * 60 * MIN),
          resolveDueAt: new Date(createdAt.getTime() + 10 * 60 * MIN),
          slaPauses: [
            {
              from: new Date(now - 49 * 60 * MIN).toISOString(),
              to: new Date(now - 47 * 60 * MIN).toISOString(),
            },
          ],
        },
      });
      // Escalated while PENDING: 4 h window, 2 h used, the running pause is credited on resume.
      const p1 = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(Date.parse(p1.resolveDueAt)).toBe(now - 44 * 60 * MIN);
      expect(p1.slaPausedAt).not.toBeNull();
      // The client answers: the clock resumes with the 2 h that were left.
      const reply = await postMessage(ctx, requester, t.id, { body: 'Here are the details.' });
      expect(reply.statusCode).toBe(201);
      const resumed = await row(t.id);
      expect(resumed.status).toBe('OPEN');
      const pauses = resumed.slaPauses as Array<{ from: string; to: string }>;
      expect(pauses).toHaveLength(2);
      expect(pauses[0]).toEqual({
        from: new Date(now - 49 * 60 * MIN).toISOString(),
        to: new Date(now - 47 * 60 * MIN).toISOString(),
      });
      expect(pauses[1]!.from).toBe(new Date(now - 46 * 60 * MIN).toISOString());
      const resumedAt = Date.parse(pauses[1]!.to);
      expect(Math.abs(resumedAt - resumed.updatedAt.getTime())).toBeLessThan(5000);
      expect(resumed.resolveDueAt!.getTime()).toBe(resumedAt + 2 * 60 * MIN);
      // A later change replays both pauses: P2 → 8 h − 2 h used = 6 h after the resume.
      const p2 = (await patch(w.agentA, t.id, { priority: 'P2' })).json().ticket;
      expect(Date.parse(p2.resolveDueAt)).toBe(resumedAt + 6 * 60 * MIN);
    });

    it('a client reply on a PENDING ticket resumes the clock (business-hours policy too)', async () => {
      const t = await newTicket(); // P3, business hours
      await postMessage(ctx, w.agentA, t.id, { body: 'Can you send a photo?' }); // → PENDING
      const paused = await row(t.id);
      expect(paused.status).toBe('PENDING');
      expect(paused.slaPausedAt).not.toBeNull();
      const pausedAt = new Date(paused.slaPausedAt!.getTime() - 3 * 24 * 60 * MIN);
      await ctx.prisma.ticket.update({ where: { id: t.id }, data: { slaPausedAt: pausedAt } });

      const reply = await postMessage(ctx, requester, t.id, { body: 'Photo attached.' });
      expect(reply.statusCode).toBe(201);
      const resumed = await row(t.id);
      expect(resumed.status).toBe('OPEN');
      expect(resumed.slaPausedAt).toBeNull();
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      const expected = resumeDueDate(
        paused.resolveDueAt!,
        pausedAt,
        resumed.updatedAt,
        calendar,
        true,
      );
      expect(Math.abs(resumed.resolveDueAt!.getTime() - expected.getTime())).toBeLessThan(1000);
      expect(resumed.resolveDueAt!.getTime()).toBeGreaterThan(paused.resolveDueAt!.getTime());
      // The resolution at-risk instant is resumed by the same rule (message path, D2).
      const pauses = resumed.slaPauses as Array<{ from: string; to: string }>;
      const resumedAt = new Date(pauses.at(-1)!.to);
      expect(resumed.resolveAtRiskAt).toEqual(
        resumeDueDate(paused.resolveAtRiskAt!, pausedAt, resumedAt, calendar, true),
      );
      expect(resumed.resolveAtRiskAt!.getTime()).toBeGreaterThan(paused.resolveAtRiskAt!.getTime());
    });

    it('a target already passed when the pause started is not moved', async () => {
      const t = await newTicket({ priority: 'P1' });
      await patch(w.agentA, t.id, { status: 'PENDING' });
      const overdue = new Date(Date.now() - 60 * MIN);
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          resolveDueAt: overdue,
          resolveAtRiskAt: new Date(overdue.getTime() - 60 * MIN),
          slaPausedAt: new Date(Date.now() - 30 * MIN),
        },
      });
      const resumed = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      expect(resumed.resolveDueAt).toBe(overdue.toISOString());
      expect(resumed.resolveAtRiskAt).toBe(new Date(overdue.getTime() - 60 * MIN).toISOString());
    });

    it('an at-risk instant that passed during the work stays; the due date still moves', async () => {
      // P2 (24/7): at risk 60 min ago, due in 30 min when the pause started 10 min ago.
      const t = await newTicket({ priority: 'P2' });
      await patch(w.agentA, t.id, { status: 'PENDING' });
      const pausedAt = new Date(Date.now() - 10 * MIN);
      const riskAt = new Date(pausedAt.getTime() - 60 * MIN);
      const dueAt = new Date(pausedAt.getTime() + 30 * MIN);
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: { resolveDueAt: dueAt, resolveAtRiskAt: riskAt, slaPausedAt: pausedAt },
      });
      const resumed = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      expect(resumed.resolveAtRiskAt).toBe(riskAt.toISOString());
      expect(Date.parse(resumed.resolveDueAt)).toBe(Date.parse(resumed.updatedAt) + 30 * MIN);
    });

    it('a ticket without stored instants (pre-Phase 3) keeps them null on resume', async () => {
      const t = await newTicket({ priority: 'P2' });
      await patch(w.agentA, t.id, { status: 'PENDING' });
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: { firstReplyAtRiskAt: null, resolveAtRiskAt: null },
      });
      const resumed = (await patch(w.agentA, t.id, { status: 'OPEN' })).json().ticket;
      expect(resumed.resolveAtRiskAt).toBeNull();
      expect(resumed.firstReplyAtRiskAt).toBeNull();
      // A priority change computes them (the SLA scan backfills the others).
      const p1 = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(p1.firstReplyAtRiskAt).not.toBeNull();
      expect(p1.resolveAtRiskAt).not.toBeNull();
    });
  });

  describe('P1 period (p1Since, escalation step, acknowledgement)', () => {
    const ackBy = async (ticketId: string) => {
      // What the acknowledge endpoint and the escalation worker (other lanes) will write.
      await ctx.prisma.ticket.update({
        where: { id: ticketId },
        data: { p1AckedAt: new Date(), p1AckedById: w.agentA.id, p1EscalationStep: 2 },
      });
    };

    it('upgrade to P1 starts a new period; downgrade ends it; both reset step and ack', async () => {
      const t = await newTicket(); // P3
      expect(t).toMatchObject({ p1Since: null, p1EscalationStep: 0, p1AckedBy: null });
      const up = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(up.p1Since).toBe(up.updatedAt);
      expect(up).toMatchObject({ p1EscalationStep: 0, p1AckedAt: null, p1AckedBy: null });

      await ackBy(t.id);
      const acked = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(acked.p1AckedBy).toEqual({ id: w.agentA.id, name: w.agentA.name });
      expect(acked.p1EscalationStep).toBe(2);
      // Other changes keep the P1 period and its acknowledgement.
      const tagged = (await patch(w.agentA, t.id, { tags: ['p1-period'] })).json().ticket;
      expect(tagged).toMatchObject({
        p1Since: up.p1Since,
        p1EscalationStep: 2,
        p1AckedBy: { id: w.agentA.id },
      });

      const down = (await patch(w.agentA, t.id, { priority: 'P2' })).json().ticket;
      expect(down).toMatchObject({
        p1Since: null,
        p1EscalationStep: 0,
        p1AckedAt: null,
        p1AckedBy: null,
      });
      expect((await row(t.id)).p1AckedById).toBeNull();

      // Between non-P1 priorities nothing about P1 changes.
      await ctx.prisma.ticket.update({ where: { id: t.id }, data: { p1EscalationStep: 1 } });
      const p3 = (await patch(w.agentA, t.id, { priority: 'P3' })).json().ticket;
      expect(p3).toMatchObject({ p1Since: null, p1EscalationStep: 1 });

      // A second upgrade is a new period (a later p1Since, fresh step and acknowledgement).
      const again = (await patch(w.agentA, t.id, { priority: 'P1' })).json().ticket;
      expect(Date.parse(again.p1Since)).toBeGreaterThan(Date.parse(up.p1Since));
      expect(again).toMatchObject({ p1EscalationStep: 0, p1AckedAt: null, p1AckedBy: null });
    });

    it('a ticket created as P1 starts its period at creation and loses it on downgrade', async () => {
      const t = await newTicket({ priority: 'P1' });
      expect(t.p1Since).toBe(t.createdAt);
      const down = (await patch(w.agentA, t.id, { priority: 'P4' })).json().ticket;
      expect(down.p1Since).toBeNull();
    });

    it('p1AckedBy is only shown while acknowledged; closedAt is mapped', async () => {
      const t = await newTicket({ priority: 'P1' });
      const closedAt = new Date(Date.now() - MIN);
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: { p1AckedById: w.agentA.id, p1AckedAt: null, closedAt },
      });
      const ticket = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(ticket.p1AckedBy).toBeNull();
      expect(ticket.closedAt).toBe(closedAt.toISOString());
    });

    it("the detail carries the team's P1 chain for staff (team rules replace the global one); null for clients", async () => {
      const t = await newTicket({ priority: 'P1' });
      const global = await ctx.prisma.escalationRule.findMany({
        where: { priority: 'P1', teamId: null, isActive: true },
        orderBy: { step: 'asc' },
      });
      const staffView = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(staffView.p1Chain).toEqual(
        global.map((r) => ({ step: r.step, afterMins: r.afterMins })),
      );
      const clientView = (await apiAs(ctx, w.clientX).get(`/tickets/${t.id}`)).json().ticket;
      expect(clientView.p1Chain).toBeNull();
      // The team gets rules of its own (steps 1 and 2 only): they replace the global chain.
      await testChain(ctx, w.teamA.id, w.admin.id, [{ afterMins: 0 }, { afterMins: 7 }]);
      const own = (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).json().ticket;
      expect(own.p1Chain).toEqual([
        { step: 1, afterMins: 0 },
        { step: 2, afterMins: 7 },
      ]);
      await ctx.prisma.escalationRule.deleteMany({ where: { teamId: w.teamA.id } });
    });
  });

  describe('fields', () => {
    it('assignee: team members, super admins; null unassigns; others → 400', async () => {
      const t = await newTicket();
      const ok = await patch(w.agentA, t.id, { assigneeId: w.agentA2.id });
      expect(ok.json().ticket.assignee).toEqual({ id: w.agentA2.id, name: w.agentA2.name });
      expect((await patch(w.agentA, t.id, { assigneeId: w.admin.id })).statusCode).toBe(200);
      for (const bad of [w.agentB.id, w.clientX.id, w.disabledAgent.id]) {
        const res = await patch(w.agentA, t.id, { assigneeId: bad });
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().error.details).toContainEqual(
          expect.objectContaining({ path: ['assigneeId'] }),
        );
      }
      expect((await patch(w.agentA, t.id, { assigneeId: null })).json().ticket.assignee).toBeNull();
      expect((await events(t.id)).map((e) => [e.type, e.fromValue, e.toValue])).toEqual([
        ['ASSIGNEE_CHANGED', null, w.agentA2.id],
        ['ASSIGNEE_CHANGED', w.agentA2.id, w.admin.id],
        ['ASSIGNEE_CHANGED', w.admin.id, null],
      ]);
    });

    it('category change re-routes to its team, requires a matching sub-type, one event per field', async () => {
      const t = await newTicket();
      await patch(w.agentA, t.id, { assigneeId: w.agentA2.id });
      const missing = await patch(w.agentA, t.id, { categoryId: w.catB.category.id });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.details).toContainEqual(
        expect.objectContaining({ path: ['subtypeId'], message: 'validation.required' }),
      );
      const mismatch = await patch(w.agentA, t.id, {
        categoryId: w.catB.category.id,
        subtypeId: w.catA.subtypes[1]!.id,
      });
      expect(mismatch.statusCode).toBe(400);

      const res = await patch(w.agentA, t.id, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ticket).toMatchObject({
        category: { id: w.catB.category.id },
        subtype: { id: w.catB.subtypes[0]!.id },
        team: { id: w.teamB.id },
        // The assignee isn't on the new team: back to that team's queue.
        assignee: null,
      });
      const history = (await events(t.id)).slice(1).map((e) => [e.type, e.fromValue, e.toValue]);
      expect(history).toEqual(
        expect.arrayContaining([
          ['CATEGORY_CHANGED', w.catA.category.id, w.catB.category.id],
          ['SUBTYPE_CHANGED', w.catA.subtypes[0]!.id, w.catB.subtypes[0]!.id],
          ['TEAM_CHANGED', w.teamA.id, w.teamB.id],
          ['ASSIGNEE_CHANGED', w.agentA2.id, null],
        ]),
      );
      expect(history).toHaveLength(4);
      // The re-routed ticket is now invisible to team A (not assigned any more).
      expect((await apiAs(ctx, w.agentA).get(`/tickets/${t.id}`)).statusCode).toBe(404);
    });

    it('sub-type change alone (same category); an archived one → 400', async () => {
      const t = await newTicket();
      const res = await patch(w.agentA, t.id, { subtypeId: w.catA.subtypes[2]!.id });
      expect(res.json().ticket.subtype.id).toBe(w.catA.subtypes[2]!.id);
      expect(res.json().ticket.priority).toBe('P3'); // the priority is not changed implicitly
      expect((await patch(w.agentA, t.id, { subtypeId: w.catA.subtypes[4]!.id })).statusCode).toBe(
        400,
      );
      expect((await events(t.id)).map((e) => e.type)).toEqual(['SUBTYPE_CHANGED']);
    });

    it('a Security Incident cannot leave the security category', async () => {
      const config = await ctx.app.services.ticketConfig.getFormConfig();
      const cyber = config.categories.find((c) => c.key === 'cyber')!;
      const t = await newTicket({
        type: 'SECURITY_INCIDENT',
        categoryId: cyber.id,
        subtypeId: cyber.subtypes[0]!.id,
      });
      const res = await patch(w.admin, t.id, {
        categoryId: w.catA.category.id,
        subtypeId: w.catA.subtypes[0]!.id,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toContainEqual(
        expect.objectContaining({ code: 'security_category' }),
      );
    });

    it('tags: full set; missing Tag rows created; TAGS_CHANGED with added / removed', async () => {
      const t = await newTicket();
      const k1 = ctx.fixtures.trackTag(`t-${rand(3)}`);
      const k2 = ctx.fixtures.trackTag(`t-${rand(3)}`);
      const first = await patch(w.agentA, t.id, { tags: [k2, k1.toUpperCase(), k1] });
      expect(first.statusCode).toBe(200);
      expect(first.json().ticket.tags).toEqual([k1, k2].sort());
      const second = await patch(w.agentA, t.id, { tags: [k2, 'firewall'] });
      expect(second.json().ticket.tags).toEqual(['firewall', k2].sort());
      const history = (await events(t.id)).map((e) => ({
        from: e.fromValue,
        to: e.toValue,
        meta: e.meta,
      }));
      expect(history).toEqual([
        {
          from: null,
          to: [k1, k2].sort().join(','),
          meta: { added: [k1, k2].sort(), removed: [] },
        },
        {
          from: [k1, k2].sort().join(','),
          to: ['firewall', k2].sort().join(','),
          meta: { added: ['firewall'], removed: [k1] },
        },
      ]);
      expect(await ctx.prisma.tag.count({ where: { key: { in: [k1, k2] } } })).toBe(2);
      const bad = await patch(w.agentA, t.id, { tags: ['has space'] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.details[0].message).toBe('validation.tagFormat');
    });

    it('impact, site (own organisation only) and asset id, one event each', async () => {
      const t = await newTicket();
      const before = await row(t.id);
      const res = await patch(w.agentA, t.id, {
        impact: 'ENTIRE_SITE',
        siteId: w.siteX2.id,
        assetId: 'CAM-7',
      });
      expect(res.json().ticket).toMatchObject({
        impact: 'ENTIRE_SITE',
        site: { id: w.siteX2.id },
        assetId: 'CAM-7',
      });
      expect((await patch(w.agentA, t.id, { siteId: w.siteY1.id })).statusCode).toBe(400);
      expect((await patch(w.agentA, t.id, { siteId: w.siteXArchived.id })).statusCode).toBe(400);
      expect((await patch(w.agentA, t.id, { assetId: null })).json().ticket.assetId).toBeNull();
      expect((await events(t.id)).map((e) => [e.type, e.fromValue, e.toValue, e.actorId])).toEqual([
        ['IMPACT_CHANGED', before.impact, 'ENTIRE_SITE', w.agentA.id],
        ['SITE_CHANGED', before.siteId, w.siteX2.id, w.agentA.id],
        ['ASSET_CHANGED', before.assetId, 'CAM-7', w.agentA.id],
        ['ASSET_CHANGED', 'CAM-7', null, w.agentA.id],
      ]);
    });

    it('custom fields are validated against the ticket’s category', async () => {
      const cat = await ctx.fixtures.category({
        teamId: w.teamA.id,
        fields: [{ type: 'NUMBER', required: true }, { type: 'TEXT' }],
      });
      await ctx.app.services.ticketConfig.invalidate();
      const [num, text] = cat.fields.map((f) => f.key) as [string, string];
      const t = await newTicket({
        categoryId: cat.category.id,
        subtypeId: cat.subtypes[0]!.id,
        customFields: { [num]: 1 },
      });
      const missing = await patch(w.agentA, t.id, { customFields: { [text]: 'x' } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.details).toContainEqual(
        expect.objectContaining({ path: ['customFields', num], message: 'validation.required' }),
      );
      const ok = await patch(w.agentA, t.id, { customFields: { [num]: 2, [text]: 'x' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ticket.customFields.map((f: { value: unknown }) => f.value)).toEqual([
        2,
        'x',
      ]);
      // The same values in another key order change nothing (jsonb does not keep key order).
      const same = await patch(w.agentA, t.id, { customFields: { [text]: 'x', [num]: '2' } });
      expect(same.json().ticket.updatedAt).toBe(ok.json().ticket.updatedAt);
      // One event per effective change, naming the keys but never copying the values.
      const history = (await events(t.id)).map((e) => [e.type, e.fromValue, e.toValue, e.meta]);
      expect(history).toEqual([
        ['CUSTOM_FIELDS_CHANGED', null, null, { fields: [num, text].sort() }],
      ]);
    });

    it('a lone UTF-16 surrogate in a custom TEXT value becomes U+FFFD, never a 500 (RR-SEC-3)', async () => {
      const cat = await ctx.fixtures.category({
        teamId: w.teamA.id,
        fields: [{ type: 'TEXT' }, { type: 'ASSET_ID' }],
      });
      await ctx.app.services.ticketConfig.invalidate();
      const [text, asset] = cat.fields.map((f) => f.key) as [string, string];
      const t = await newTicket({ categoryId: cat.category.id, subtypeId: cat.subtypes[0]!.id });
      // The raw JSON escape reaches the parser as the probe sent it.
      const json = JSON.stringify({
        customFields: { [text]: 'p__LONE__q', [asset]: '__LONE__' },
      }).replaceAll('__LONE__', '\\ud800');
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/tickets/${t.id}`,
        headers: { authorization: `Bearer ${w.agentA.token}`, 'content-type': 'application/json' },
        remoteAddress: randomIp(),
        payload: json,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(
        res
          .json()
          .ticket.customFields.map((f: { key: string; value: unknown }) => [f.key, f.value]),
      ).toEqual([
        [text, 'p�q'],
        [asset, '�'],
      ]);
      expect((await row(t.id)).customFields).toEqual({ [text]: 'p�q', [asset]: '�' });
    });
  });

  it('realtime: PATCH emits ticket:updated to the ticket and queue:updated to old and new teams', async () => {
    const t = await newTicket();
    const emitted: Array<[string, unknown]> = [];
    const original = { ...ctx.app.realtime.tickets };
    ctx.app.realtime.tickets.ticketUpdated = (ticket) => {
      emitted.push(['ticket', ticket]);
    };
    ctx.app.realtime.tickets.queueUpdated = (teams, id, reason) =>
      emitted.push(['queue', { teams, id, reason }]);
    try {
      await patch(w.agentA, t.id, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      });
      await patch(w.admin, t.id, { impact: 'SINGLE_USER' }); // no-op → no events
    } finally {
      Object.assign(ctx.app.realtime.tickets, original);
    }
    expect(emitted).toHaveLength(2);
    const [ticketEvent, queueEvent] = emitted;
    expect(ticketEvent?.[0]).toBe('ticket');
    // The summary only: no detail / caller-specific fields.
    expect(Object.keys(ticketEvent?.[1] as object)).not.toContain('requesterCard');
    expect(Object.keys(ticketEvent?.[1] as object)).not.toContain('description');
    expect(queueEvent).toEqual([
      'queue',
      { teams: [w.teamA.id, w.teamB.id], id: t.id, reason: 'updated' },
    ]);
  });
});
