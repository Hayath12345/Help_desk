import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escalationJobId } from '../src/lib/job-data.ts';
import { MINUTE_MS } from '../src/lib/escalation.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  postMessage,
  ticketBody,
  type World,
} from './ticket-world.ts';
import { allJobs, testChain } from './worker-helpers.ts';

// The API side of Phase 3 (no worker running here, so the queues can be inspected): producers
// enqueue after the commit with deterministic job ids (D15), a P1 period schedules its first
// escalation step at p1Since + afterMins (D3), a downgrade and an acknowledgement cancel the
// pending step, internal notes never notify, and POST /tickets/:id/acknowledge (D5).

describe('notification producers and P1 acknowledge', () => {
  let ctx: TestContext;
  let w: World;

  const eventJobs = async (ticketId: string) =>
    (await allJobs(ctx.queues.notifications)).filter(
      (j) => j.name === 'event' && j.data.ticketId === ticketId,
    );
  const escalationJobs = async (ticketId: string) =>
    (await allJobs(ctx.queues.escalation)).filter((j) => j.data.ticketId === ticketId);

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    await testChain(ctx, w.teamA.id, w.admin.id);
    // Team B's chain starts 2 minutes after the ticket became P1 (cumulative, D3).
    await testChain(ctx, w.teamB.id, w.admin.id, [
      { afterMins: 2 },
      { afterMins: 5 },
      { afterMins: 15 },
    ]);
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe('producers', () => {
    it('ticket created: one event job (any creator); a P1 also schedules escalation step 1', async () => {
      const p3 = await createTicket(ctx, w.clientX, ticketBody(w));
      expect((await eventJobs(p3.id)).map((j) => [j.id, j.data])).toEqual([
        [`ticket-created-${p3.id}`, { event: 'ticket-created', ticketId: p3.id }],
      ]);
      expect(await escalationJobs(p3.id)).toHaveLength(0);

      const byStaff = await createTicket(
        ctx,
        w.agentA,
        ticketBody(w, { requesterId: w.clientX.id }),
      );
      expect((await eventJobs(byStaff.id)).map((j) => j.id)).toEqual([
        `ticket-created-${byStaff.id}`,
      ]);

      const p1 = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
      );
      const [step1] = await escalationJobs(p1.id);
      expect(step1!.id).toBe(escalationJobId(p1.id, p1.p1Since as string, 1));
      expect(step1!.data).toEqual({ ticketId: p1.id, p1Since: p1.p1Since, step: 1 });
      expect(step1!.opts.delay ?? 0).toBeLessThan(1000);
    });

    it('D3: step 1 waits afterMins after p1Since (team rules replace the global chain)', async () => {
      const before = Date.now();
      const p1 = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, {
          categoryId: w.catB.category.id,
          subtypeId: w.catB.subtypes[0]!.id,
          priority: 'P1',
        }),
      );
      const [step1] = await escalationJobs(p1.id);
      const p1Since = Date.parse(p1.p1Since as string);
      expect(step1!.timestamp + (step1!.opts.delay ?? 0)).toBeGreaterThanOrEqual(
        p1Since + 2 * MINUTE_MS - 50,
      );
      expect(step1!.timestamp + (step1!.opts.delay ?? 0)).toBeLessThanOrEqual(
        Date.now() + 2 * MINUTE_MS + 50,
      );
      expect(p1Since).toBeGreaterThanOrEqual(before - 5);
    });

    it('PATCH priority: to P1 starts a period (event + step 1), away from P1 removes the pending step', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const agent = apiAs(ctx, w.agentA);
      const up = (await agent.patch(`/tickets/${t.id}`, { priority: 'P1' })).json().ticket;
      const events = await eventJobs(t.id);
      expect(events.map((j) => j.id).sort()).toEqual(
        [`ticket-created-${t.id}`, `p1-started-${t.id}-${Date.parse(up.p1Since)}`].sort(),
      );
      const stepId = escalationJobId(t.id, up.p1Since, 1);
      expect((await escalationJobs(t.id)).map((j) => j.id)).toEqual([stepId]);

      await agent.patch(`/tickets/${t.id}`, { priority: 'P2' });
      expect(await ctx.queues.escalation.getJob(stepId)).toBeUndefined();
      // Between non-P1 priorities: nothing.
      await agent.patch(`/tickets/${t.id}`, { priority: 'P3' });
      expect(await eventJobs(t.id)).toHaveLength(2);
      expect(await escalationJobs(t.id)).toHaveLength(0);
    });

    it('messages: staff PUBLIC reply → agent-reply; client reply → client-reply; internal notes never', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const reply = await postMessage(ctx, w.agentA, t.id, { body: 'On it.' });
      const note = await postMessage(ctx, w.agentA, t.id, { type: 'INTERNAL', body: 'Secret' });
      const client = await postMessage(ctx, w.clientX, t.id, { body: 'Thanks' });
      const ids = (await eventJobs(t.id)).map((j) => j.id).sort();
      expect(ids).toEqual(
        [
          `ticket-created-${t.id}`,
          `agent-reply-${reply.json().message.id}`,
          `client-reply-${client.json().message.id}`,
        ].sort(),
      );
      expect(JSON.stringify(ids)).not.toContain(note.json().message.id);
    });

    it('a queue failure never fails the request (best effort after commit)', async () => {
      const original = ctx.queues.enqueueEvent;
      ctx.queues.enqueueEvent = async () => {
        throw new Error('redis unavailable');
      };
      try {
        const res = await apiAs(ctx, w.clientX).post('/tickets', ticketBody(w));
        expect(res.statusCode).toBe(201);
      } finally {
        ctx.queues.enqueueEvent = original;
      }
    });
  });

  describe('POST /tickets/:id/acknowledge', () => {
    it('acknowledges once: event, first acknowledger kept, pending step cancelled, fan-out enqueued', async () => {
      const t = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
      );
      const stepId = escalationJobId(t.id, t.p1Since as string, 1);
      expect(await ctx.queues.escalation.getJob(stepId)).toBeTruthy();

      const first = await apiAs(ctx, w.agentA).post(`/tickets/${t.id}/acknowledge`);
      expect(first.statusCode).toBe(200);
      const body = first.json();
      expect(body.alreadyAcknowledged).toBe(false);
      expect(body.ticket.p1AckedBy).toEqual({ id: w.agentA.id, name: 'Alice Agent' });
      expect(body.ticket.p1AckedAt).toEqual(expect.any(String));
      expect(await ctx.queues.escalation.getJob(stepId)).toBeUndefined();
      expect((await eventJobs(t.id)).map((j) => j.id)).toContain(
        `p1-ack-${t.id}-${Date.parse(t.p1Since as string)}`,
      );

      const second = await apiAs(ctx, w.leadA).post(`/tickets/${t.id}/acknowledge`);
      expect(second.statusCode).toBe(200);
      expect(second.json().alreadyAcknowledged).toBe(true);
      expect(second.json().ticket.p1AckedBy.id).toBe(w.agentA.id);
      expect(second.json().ticket.p1AckedAt).toBe(body.ticket.p1AckedAt);
      const events = await ctx.prisma.ticketEvent.findMany({
        where: { ticketId: t.id, type: 'P1_ACKNOWLEDGED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorId: w.agentA.id, toValue: w.agentA.id });
    });

    it('concurrent acknowledgements: exactly one wins', async () => {
      const t = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
      );
      const results = await Promise.all(
        [w.agentA, w.agentA2, w.leadA, w.admin].map((p) =>
          apiAs(ctx, p).post(`/tickets/${t.id}/acknowledge`),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(results.filter((r) => !r.json().alreadyAcknowledged)).toHaveLength(1);
      const ackers = new Set(results.map((r) => r.json().ticket.p1AckedBy.id));
      expect(ackers.size).toBe(1);
      expect(
        await ctx.prisma.ticketEvent.count({ where: { ticketId: t.id, type: 'P1_ACKNOWLEDGED' } }),
      ).toBe(1);
    });

    it('refuses clients (403), hides other teams’ tickets (404) and rejects non-P1 / closed tickets (409)', async () => {
      const p1 = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
      );
      expect((await apiAs(ctx, w.clientX).post(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(
        403,
      );
      expect((await apiAs(ctx, w.agentB).post(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(
        404,
      );
      expect((await apiAs(ctx, w.clientY).post(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(
        404,
      );
      expect((await apiAs(ctx, null).post(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(401);
      expect((await apiAs(ctx, w.agentA).post(`/tickets/not-a-uuid/acknowledge`)).statusCode).toBe(
        400,
      );
      const p3 = await createTicket(ctx, w.clientX, ticketBody(w));
      const notP1 = await apiAs(ctx, w.agentA).post(`/tickets/${p3.id}/acknowledge`);
      expect(notP1.statusCode).toBe(409);
      expect(notP1.json().error.code).toBe('CONFLICT');
      await ctx.prisma.ticket.update({ where: { id: p1.id }, data: { status: 'CLOSED' } });
      expect((await apiAs(ctx, w.agentA).post(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(
        409,
      );
      // GET never acknowledges (links in emails / Teams / SMS open the console).
      expect((await apiAs(ctx, w.agentA).get(`/tickets/${p1.id}/acknowledge`)).statusCode).toBe(
        404,
      );
    });
  });
});
