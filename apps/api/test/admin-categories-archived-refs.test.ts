import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamListSchema, ticketResponseSchema } from '@loons/shared';
import { createTestContext, type TestContext } from './helpers.ts';
import { apiAs, createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';

// Decision E6 (old tickets keep rendering archived config) — the parts the console needs beyond the
// detail DTO (see ticket-archived-refs.test.ts): archived category and sub-type markers, and a
// ticket on an archived team stays workable — GET /teams?archived=include still lists that team's
// members for the assignee picker, and assigning one of them works.

describe('tickets on archived config stay workable (E6)', () => {
  let ctx: TestContext;
  let w: World;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('marks an archived category and sub-type on the detail', async () => {
    const { category, subtypes } = await ctx.fixtures.category({ teamId: w.teamA.id });
    await ctx.app.services.ticketConfig.invalidate();
    const ticket = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { categoryId: category.id, subtypeId: subtypes[0]!.id }),
    );
    await ctx.prisma.subtype.update({ where: { id: subtypes[0]!.id }, data: { isActive: false } });
    await ctx.prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
    const { ticket: detail } = ticketResponseSchema.parse(
      (await apiAs(ctx, w.clientX).get(`/tickets/${ticket.id}`)).json(),
    );
    expect(detail.category).toMatchObject({ id: category.id, isActive: false });
    expect(detail.subtype).toMatchObject({ id: subtypes[0]!.id, isActive: false });
  });

  it('GET /teams?archived=include lists archived teams (after active ones) with their members', async () => {
    const team = await ctx.fixtures.team();
    const member = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      name: 'Archie Member',
    });
    await ctx.fixtures.member(team.id, member.id);
    await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });

    const active = teamListSchema.parse((await apiAs(ctx, w.agentA).get('/teams')).json()).items;
    expect(active.some((t) => t.id === team.id)).toBe(false);
    const all = teamListSchema.parse(
      (await apiAs(ctx, w.agentA).get('/teams?archived=include')).json(),
    ).items;
    const listed = all.find((t) => t.id === team.id);
    expect(listed?.members.map((m) => m.id)).toEqual([member.id]);
    // Active teams first.
    expect(all.findIndex((t) => t.id === w.teamA.id)).toBeLessThan(all.indexOf(listed!));
    expect((await apiAs(ctx, w.agentA).get('/teams?archived=yes')).statusCode).toBe(400);
    expect((await apiAs(ctx, w.clientX).get('/teams?archived=include')).statusCode).toBe(403);
  });

  it('a ticket on an archived team can still be assigned to that team’s members', async () => {
    const team = await ctx.fixtures.team();
    const { category, subtypes } = await ctx.fixtures.category({ teamId: team.id });
    const member = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    await ctx.fixtures.member(team.id, member.id);
    await ctx.app.services.ticketConfig.invalidate();
    const ticket = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { categoryId: category.id, subtypeId: subtypes[0]!.id }),
    );
    await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
    const res = await apiAs(ctx, w.admin).patch(`/tickets/${ticket.id}`, {
      assigneeId: member.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().ticket).toMatchObject({
      assignee: { id: member.id },
      team: { id: team.id, isActive: false },
    });
  });
});
