import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNotificationEvent } from '../src/jobs/events.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import { fakeEmail, fakeSms, testWorkerContext } from './worker-helpers.ts';

// Skills-based auto-assignment (docs/AUTO_ASSIGN.md): a new ticket in a category that asks for
// skills goes to the best-matching active member of its team; otherwise it waits in the queue.

describe('auto-assignment by skill', () => {
  let ctx: TestContext;
  let w: World;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A category on team A (P3 and P1 sub-types) that asks for `skills`, and a client to use it. */
  async function setup(skills: string[]) {
    const cat = await ctx.fixtures.category({
      teamId: w.teamA.id,
      subtypes: [{ defaultPriority: 'P3' }, { defaultPriority: 'P1' }],
    });
    if (skills.length) await ctx.fixtures.requireSkills(cat.category.id, skills);
    await ctx.app.services.ticketConfig.invalidate();
    return cat;
  }
  const raise = async (cat: Awaited<ReturnType<typeof setup>>, subtype = 0, as?: Persona) =>
    createTicket(
      ctx,
      as ?? (await w.newClientX()),
      ticketBody(w, { categoryId: cat.category.id, subtypeId: cat.subtypes[subtype]!.id }),
    );
  /** A fresh agent on team A with the skills (no tickets yet, so load comparisons are exact). */
  async function freshAgent(skills: string[]) {
    const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    await ctx.fixtures.member(w.teamA.id, user.id);
    if (skills.length) await ctx.fixtures.giveSkills(user.id, skills);
    return user;
  }
  const assigneeOf = async (ticketId: string) =>
    (await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).assigneeId;

  it('leaves a category without skills in the team queue, as before', async () => {
    const cat = await setup([]);
    const ticket = await raise(cat);
    expect(await assigneeOf(ticket.id)).toBeNull();
  });

  it('assigns to the one team member who has the skill, with a system event', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    const cat = await setup([net.id]);
    const ticket = await raise(cat);

    expect(await assigneeOf(ticket.id)).toBe(w.agentA.id);
    const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    // A client's ticket is still NEW: the assignee hasn't touched it yet.
    expect(row.status).toBe('NEW');
    const events = await ctx.prisma.ticketEvent.findMany({
      where: { ticketId: ticket.id, type: 'ASSIGNEE_CHANGED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: null,
      fromValue: null,
      toValue: w.agentA.id,
      meta: { auto: true },
    });
  });

  it('shows the automatic assignment in the ticket history', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    const cat = await setup([net.id]);
    const ticket = await raise(cat);
    const res = await apiAs(ctx, w.agentA).get(`/tickets/${ticket.id}/events`);
    expect(res.statusCode).toBe(200);
    const assigned = (
      res.json().items as Array<{ type: string; actor: unknown; meta: { auto?: boolean } }>
    ).find((e) => e.type === 'ASSIGNEE_CHANGED');
    expect(assigned).toMatchObject({ actor: null, meta: { auto: true } });
  });

  it('ignores people without the skill, on another team, disabled, or paused', async () => {
    const net = await ctx.fixtures.skill();
    const other = await ctx.fixtures.skill();
    // Has the skill but is on team B; has another skill; disabled; paused; the one who qualifies.
    await ctx.fixtures.giveSkills(w.agentB.id, [net.id]);
    await ctx.fixtures.giveSkills(w.agentA2.id, [other.id]);
    await ctx.fixtures.giveSkills(w.disabledAgent.id, [net.id]);
    await ctx.fixtures.giveSkills(w.leadA.id, [net.id]);
    await ctx.prisma.user.update({ where: { id: w.leadA.id }, data: { acceptsAutoAssign: false } });
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    try {
      const cat = await setup([net.id]);
      const ticket = await raise(cat);
      expect(await assigneeOf(ticket.id)).toBe(w.agentA.id);
    } finally {
      await ctx.prisma.user.update({
        where: { id: w.leadA.id },
        data: { acceptsAutoAssign: true },
      });
    }
  });

  it('leaves the ticket in the queue when nobody qualifies', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentB.id, [net.id]); // wrong team
    const cat = await setup([net.id]);
    const ticket = await raise(cat);
    expect(await assigneeOf(ticket.id)).toBeNull();
    expect(
      await ctx.prisma.ticketEvent.count({
        where: { ticketId: ticket.id, type: 'ASSIGNEE_CHANGED' },
      }),
    ).toBe(0);
  });

  it('does not count an archived skill, and counts it again once restored', async () => {
    const net = await ctx.fixtures.skill({ isActive: false });
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    const cat = await setup([net.id]);
    expect(await assigneeOf((await raise(cat)).id)).toBeNull();
    await ctx.prisma.skill.update({ where: { id: net.id }, data: { isActive: true } });
    expect(await assigneeOf((await raise(cat)).id)).toBe(w.agentA.id);
  });

  it('matches any one of the skills the category asks for', async () => {
    const a = await ctx.fixtures.skill();
    const b = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA.id, [b.id]);
    const cat = await setup([a.id, b.id]);
    expect(await assigneeOf((await raise(cat)).id)).toBe(w.agentA.id);
  });

  it('shares tickets out: the least loaded person gets the next one', async () => {
    const net = await ctx.fixtures.skill();
    const one = await freshAgent([net.id]);
    const two = await freshAgent([net.id]);
    const cat = await setup([net.id]);

    const picks = [];
    for (let i = 0; i < 4; i++) picks.push(await assigneeOf((await raise(cat)).id));
    // Never the same person twice in a row, and two each after four.
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[2]).not.toBe(picks[3]);
    expect(picks.filter((id) => id === one.id)).toHaveLength(2);
    expect(picks.filter((id) => id === two.id)).toHaveLength(2);
  });

  it('counts open tickets only: solved ones no longer weigh on a person', async () => {
    const net = await ctx.fixtures.skill();
    const one = await freshAgent([net.id]);
    const two = await freshAgent([net.id]);
    const cat = await setup([net.id]);
    // Make the first agent busy with a hand-assigned open ticket, so the second is the lighter one.
    const busy = await createTicket(
      ctx,
      await w.newClientX(),
      ticketBody(w, { categoryId: w.catB.category.id, subtypeId: w.catB.subtypes[0]!.id }),
    );
    await ctx.prisma.ticket.update({ where: { id: busy.id }, data: { assigneeId: one.id } });
    expect(await assigneeOf((await raise(cat)).id)).toBe(two.id);
    // Once that ticket is solved, the first agent is the lighter one again (0 open against 1).
    await ctx.prisma.ticket.update({ where: { id: busy.id }, data: { status: 'SOLVED' } });
    expect(await assigneeOf((await raise(cat)).id)).toBe(one.id);
  });

  it('never auto-assigns a P1: it goes through the escalation chain', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    const cat = await setup([net.id]);
    const p1 = await raise(cat, 1);
    expect(p1.priority).toBe('P1');
    expect(await assigneeOf(p1.id)).toBeNull();
  });

  it('a staff member raising a ticket for their own team keeps it, whatever the skills say', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA2.id, [net.id]);
    const cat = await setup([net.id]);
    const ticket = await createTicket(
      ctx,
      w.agentA,
      ticketBody(w, {
        categoryId: cat.category.id,
        subtypeId: cat.subtypes[0]!.id,
        requesterId: w.clientX.id,
      }),
    );
    expect(await assigneeOf(ticket.id)).toBe(w.agentA.id);
    const [event] = await ctx.prisma.ticketEvent.findMany({
      where: { ticketId: ticket.id, type: 'ASSIGNEE_CHANGED' },
    });
    expect(event).toMatchObject({ actorId: w.agentA.id, meta: null });
  });

  it('tells the person who was handed the ticket, in-app (and nobody who took it themselves)', async () => {
    const net = await ctx.fixtures.skill();
    await ctx.fixtures.giveSkills(w.agentA.id, [net.id]);
    const cat = await setup([net.id]);
    const worker = testWorkerContext(ctx, {
      emailProvider: fakeEmail().provider,
      smsProvider: fakeSms().provider,
    });

    const handedOut = await raise(cat);
    await processNotificationEvent(worker, { event: 'ticket-created', ticketId: handedOut.id });
    const notes = await ctx.prisma.notification.findMany({
      where: { ticketId: handedOut.id, type: 'TICKET_ASSIGNED' },
    });
    expect(notes.map((n) => n.userId)).toEqual([w.agentA.id]);

    // Run it again (a retried job): still one notification.
    await processNotificationEvent(worker, { event: 'ticket-created', ticketId: handedOut.id });
    expect(
      await ctx.prisma.notification.count({
        where: { ticketId: handedOut.id, type: 'TICKET_ASSIGNED' },
      }),
    ).toBe(1);

    const own = await createTicket(
      ctx,
      w.agentA,
      ticketBody(w, {
        categoryId: cat.category.id,
        subtypeId: cat.subtypes[0]!.id,
        requesterId: w.clientX.id,
      }),
    );
    await processNotificationEvent(worker, { event: 'ticket-created', ticketId: own.id });
    expect(
      await ctx.prisma.notification.count({
        where: { ticketId: own.id, type: 'TICKET_ASSIGNED' },
      }),
    ).toBe(0);
  });
});
