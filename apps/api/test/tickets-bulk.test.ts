import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BULK_TICKETS_MAX, bulkTicketResultSchema } from '@loons/shared';
import { TICKET_RATE_LIMITS } from '../src/routes/tickets.ts';
import { bulkFailureReason } from '../src/services/queue.service.ts';
import { AppError, errors } from '../src/lib/errors.ts';
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

// Phase 5 bulk actions (decision F6): POST /tickets/bulk runs the single-ticket update for each
// id — same permissions, TicketEvents, realtime — and answers per ticket. Invisible and unknown
// ids are the same `not_found` (existence is never revealed); a closed ticket can't be solved;
// assigning a NEW ticket to yourself opens it; clients get 403; a per-user rate limit.

describe('POST /tickets/bulk', () => {
  let ctx: TestContext;
  let w: World;
  const tag = rand(4);

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** A team A ticket (org X) with its status / assignee set directly. */
  async function ticket(
    name: string,
    data: { status?: string; assigneeId?: string | null; team?: 'A' | 'B' } = {},
  ) {
    const cat = data.team === 'B' ? w.catB : w.catA;
    const t = await createTicket(
      ctx,
      await w.newClientX(),
      ticketBody(w, {
        subject: `Bulk ${tag} ${name}`,
        categoryId: cat.category.id,
        subtypeId: cat.subtypes[0]!.id,
      }),
    );
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: {
        ...(data.status ? { status: data.status as never } : {}),
        ...(data.status === 'SOLVED' || data.status === 'CLOSED' ? { solvedAt: new Date() } : {}),
        ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
      },
    });
    return t.id;
  }

  const bulk = (as: Persona, body: unknown) => apiAs(ctx, as).post('/tickets/bulk', body);
  const events = (ticketId: string) =>
    ctx.prisma.ticketEvent.findMany({
      where: { ticketId, type: { not: 'CREATED' } },
      // Events of one update share their time: then in enum order (STATUS before ASSIGNEE).
      orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
      select: { type: true, actorId: true, fromValue: true, toValue: true },
    });

  /** Captures the realtime calls of the requests run inside `fn`. */
  async function captureRealtime(fn: () => Promise<void>) {
    const emitted: Array<{ kind: 'ticket' | 'queue'; id: string }> = [];
    const original = { ...ctx.app.realtime.tickets };
    ctx.app.realtime.tickets.ticketUpdated = (ticket) => {
      emitted.push({ kind: 'ticket', id: ticket.id });
    };
    ctx.app.realtime.tickets.queueUpdated = (_teams, id) => {
      emitted.push({ kind: 'queue', id });
    };
    try {
      await fn();
    } finally {
      Object.assign(ctx.app.realtime.tickets, original);
    }
    return emitted;
  }

  it('assign to me: per-ticket results, NEW opens, events and realtime once per changed ticket', async () => {
    const agent = await persona(
      ctx,
      await ctx.fixtures.staff({
        staffDomain: ctx.config.staffEmailDomain,
        name: 'Bulk Agent',
      }),
    );
    await ctx.fixtures.member(w.teamA.id, agent.id);
    const fresh = await ticket('new'); // NEW, unassigned → assigned + OPEN
    const open = await ticket('open', { status: 'OPEN', assigneeId: w.agentA2.id }); // reassigned
    const mine = await ticket('mine', { status: 'OPEN', assigneeId: agent.id }); // unchanged
    const solved = await ticket('solved', { status: 'SOLVED' }); // assigned, stays SOLVED
    const closed = await ticket('closed', { status: 'CLOSED' }); // 409
    const otherTeam = await ticket('team-b', { team: 'B' }); // invisible → not_found
    const unknown = randomUUID();

    let body: ReturnType<typeof bulkTicketResultSchema.parse> | undefined;
    const emitted = await captureRealtime(async () => {
      const res = await bulk(agent, {
        action: 'assignToMe',
        ids: [fresh, open, mine, solved, closed, otherTeam, unknown],
      });
      expect(res.statusCode, res.body).toBe(200);
      body = bulkTicketResultSchema.parse(res.json());
    });
    expect(body!.results).toEqual([
      { id: fresh, ok: true, changed: true },
      { id: open, ok: true, changed: true },
      { id: mine, ok: true, changed: false },
      { id: solved, ok: true, changed: true },
      { id: closed, ok: false, error: { reason: 'conflict', message: expect.any(String) } },
      { id: otherTeam, ok: false, error: { reason: 'not_found', message: 'Ticket not found' } },
      { id: unknown, ok: false, error: { reason: 'not_found', message: 'Ticket not found' } },
    ]);
    expect(body).toMatchObject({ updated: 4, failed: 3 });
    // Invisible and unknown tickets fail identically (existence is not revealed).
    expect(body!.results[5]).toEqual({ ...body!.results[6], id: otherTeam });

    const rows = await ctx.prisma.ticket.findMany({
      where: { id: { in: [fresh, open, mine, solved, closed, otherTeam] } },
      select: { id: true, status: true, assigneeId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(fresh)).toMatchObject({ status: 'OPEN', assigneeId: agent.id });
    expect(byId.get(open)).toMatchObject({ status: 'OPEN', assigneeId: agent.id });
    expect(byId.get(mine)).toMatchObject({ status: 'OPEN', assigneeId: agent.id });
    expect(byId.get(solved)).toMatchObject({ status: 'SOLVED', assigneeId: agent.id });
    expect(byId.get(closed)).toMatchObject({ status: 'CLOSED', assigneeId: null });
    expect(byId.get(otherTeam)).toMatchObject({ status: 'NEW', assigneeId: null });

    // The single-ticket update's events, by the caller.
    expect(await events(fresh)).toEqual([
      { type: 'STATUS_CHANGED', actorId: agent.id, fromValue: 'NEW', toValue: 'OPEN' },
      { type: 'ASSIGNEE_CHANGED', actorId: agent.id, fromValue: null, toValue: agent.id },
    ]);
    expect(await events(open)).toEqual([
      { type: 'ASSIGNEE_CHANGED', actorId: agent.id, fromValue: w.agentA2.id, toValue: agent.id },
    ]);
    expect(await events(mine)).toEqual([]);
    expect(await events(closed)).toEqual([]);
    expect(await events(otherTeam)).toEqual([]);

    // Realtime: one ticket:updated and one queue:updated per changed ticket, nothing else.
    const changed = [fresh, open, solved];
    expect(emitted.filter((e) => e.kind === 'ticket').map((e) => e.id)).toEqual(changed);
    expect(emitted.filter((e) => e.kind === 'queue').map((e) => e.id)).toEqual(changed);
  });

  it('mark solved: SOLVED with solvedAt; closed tickets conflict; already solved is unchanged', async () => {
    const a = await ticket('solve-a', { status: 'OPEN' });
    const b = await ticket('solve-b'); // NEW
    const done = await ticket('solve-done', { status: 'SOLVED' });
    const closed = await ticket('solve-closed', { status: 'CLOSED' });
    const res = await bulk(w.agentA, { action: 'solve', ids: [a, b, done, closed] });
    expect(res.statusCode, res.body).toBe(200);
    const body = bulkTicketResultSchema.parse(res.json());
    expect(body.results.map((r) => (r.ok ? r.changed : r.error.reason))).toEqual([
      true,
      true,
      false,
      'conflict',
    ]);
    const rows = await ctx.prisma.ticket.findMany({
      where: { id: { in: [a, b] } },
      select: { status: true, solvedAt: true },
    });
    for (const row of rows) {
      expect(row.status).toBe('SOLVED');
      expect(row.solvedAt).toBeInstanceOf(Date);
    }
    expect(await events(a)).toEqual([
      { type: 'STATUS_CHANGED', actorId: w.agentA.id, fromValue: 'OPEN', toValue: 'SOLVED' },
    ]);
  });

  it('a ticket assigned to the caller on another team is visible to them and can be solved', async () => {
    const t = await ticket('assigned-elsewhere', { team: 'B', status: 'OPEN' });
    await ctx.prisma.ticket.update({ where: { id: t }, data: { assigneeId: w.agentA.id } });
    const res = await bulk(w.agentA, { action: 'solve', ids: [t] });
    expect(bulkTicketResultSchema.parse(res.json()).results).toEqual([
      { id: t, ok: true, changed: true },
    ]);
    // Agent A2 (team A only) can't see it: not_found, nothing written.
    const other = await ticket('assigned-elsewhere-2', { team: 'B', status: 'OPEN' });
    await ctx.prisma.ticket.update({ where: { id: other }, data: { assigneeId: w.agentA.id } });
    const denied = await bulk(w.agentA2, { action: 'assignToMe', ids: [other] });
    expect(bulkTicketResultSchema.parse(denied.json()).results[0]).toMatchObject({
      ok: false,
      error: { reason: 'not_found' },
    });
    expect(await events(other)).toEqual([]);
  });

  it('a super admin can act on any ticket', async () => {
    const t = await ticket('admin', { team: 'B' });
    const res = await bulk(w.admin, { action: 'assignToMe', ids: [t] });
    expect(bulkTicketResultSchema.parse(res.json()).results).toEqual([
      { id: t, ok: true, changed: true },
    ]);
    expect(
      await ctx.prisma.ticket.findUniqueOrThrow({
        where: { id: t },
        select: { status: true, assigneeId: true },
      }),
    ).toEqual({ status: 'OPEN', assigneeId: w.admin.id });
  });

  it('clients get 403 (nothing changes); no token 401', async () => {
    const t = await ticket('client');
    const res = await bulk(w.clientX, { action: 'solve', ids: [t] });
    expect(res.statusCode).toBe(403);
    expect(await events(t)).toEqual([]);
    expect((await apiAs(ctx).post('/tickets/bulk', { action: 'solve', ids: [t] })).statusCode).toBe(
      401,
    );
  });

  it('400: no ids, more than 50, duplicates, an unknown action or a malformed id', async () => {
    const id = randomUUID();
    const bodies = [
      { action: 'solve', ids: [] },
      { action: 'solve', ids: Array.from({ length: BULK_TICKETS_MAX + 1 }, () => randomUUID()) },
      { action: 'solve', ids: [id, id] },
      { action: 'solve', ids: [id, id.toUpperCase()] },
      { action: 'close', ids: [id] },
      { action: 'solve', ids: ['LG-1'] },
      { ids: [id] },
    ];
    for (const body of bodies) {
      expect((await bulk(w.agentA, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // 50 is fine.
    const ok = await bulk(w.agentA, {
      action: 'solve',
      ids: Array.from({ length: BULK_TICKETS_MAX }, () => randomUUID()),
    });
    expect(ok.statusCode).toBe(200);
    expect(bulkTicketResultSchema.parse(ok.json())).toMatchObject({ updated: 0, failed: 50 });
  });

  it('per-user rate limit: 429 after the allowance, other users unaffected', async () => {
    const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    await ctx.fixtures.member(w.teamA.id, user.id);
    const limited = await persona(ctx, user);
    const body = { action: 'solve', ids: [randomUUID()] };
    for (let i = 0; i < TICKET_RATE_LIMITS.bulk.max; i += 1) {
      expect((await bulk(limited, body)).statusCode).toBe(200);
    }
    const refused = await bulk(limited, body);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    expect((await bulk(w.agentA2, body)).statusCode).toBe(200);
  });

  it('maps update errors to failure reasons', () => {
    expect(bulkFailureReason(errors.notFound())).toBe('not_found');
    expect(bulkFailureReason(errors.forbidden())).toBe('forbidden');
    expect(bulkFailureReason(errors.conflict())).toBe('conflict');
    expect(bulkFailureReason(errors.validation([]))).toBe('invalid');
    expect(bulkFailureReason(new AppError(500, 'INTERNAL', 'x'))).toBe('internal');
    expect(bulkFailureReason(new Error('boom'))).toBe('internal');
  });
});
