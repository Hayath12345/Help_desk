import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ticketEventListSchema, type TicketEventDto } from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Phase 5 activity timeline (decision F14, Phase 3 carry-over): GET /tickets/:id/events lists a
// ticket's events newest first, cursor-paged, with who and when, ids resolved to labels —
// archived categories, sub-types, teams, sites and disabled users included — and only the known
// meta keys. Staff only (clients 403), a ticket the caller can't see is 404.

describe('GET /tickets/:id/events', () => {
  let ctx: TestContext;
  let w: World;
  let ticketId: string;
  let agentE1: Persona;
  let agentE2: Persona;
  let teamE1: { id: string };
  let teamE2: { id: string };
  let catE1: Awaited<ReturnType<TestContext['fixtures']['category']>>;
  let catE2: Awaited<ReturnType<TestContext['fixtures']['category']>>;
  const tag = rand(4);
  // Tags are global rows: unique keys, removed in cleanup.
  const tagA = `qa-${tag}-a`;
  const tagB = `qa-${tag}-b`;
  const system = { base: 0 };

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    f.trackTag(tagA);
    f.trackTag(tagB);
    const staffDomain = ctx.config.staffEmailDomain;
    teamE1 = await f.team();
    teamE2 = await f.team();
    catE1 = await f.category({
      teamId: teamE1.id,
      subtypes: [{ defaultPriority: 'P3' }],
      fields: [{ type: 'TEXT' }],
    });
    catE2 = await f.category({ teamId: teamE2.id, subtypes: [{ defaultPriority: 'P3' }] });
    await ctx.app.services.ticketConfig.invalidate();
    const e1 = await f.staff({ staffDomain, name: `Eve ${tag}` });
    await f.member(teamE1.id, e1.id);
    agentE1 = await persona(ctx, e1);
    const e2 = await f.staff({ staffDomain, name: `Ezra ${tag}` });
    await f.member(teamE2.id, e2.id);
    agentE2 = await persona(ctx, e2);

    const created = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, {
        subject: `Events ${tag}`,
        categoryId: catE1.category.id,
        subtypeId: catE1.subtypes[0]!.id,
      }),
    );
    ticketId = created.id;
    const patch = async (as: Persona, body: Record<string, unknown>) => {
      const res = await apiAs(ctx, as).patch(`/tickets/${ticketId}`, body);
      expect(res.statusCode, res.body).toBe(200);
    };
    await patch(agentE1, {
      status: 'OPEN',
      priority: 'P2',
      assigneeId: agentE1.id,
      impact: 'DEPARTMENT',
      siteId: w.siteX2.id,
      assetId: 'CAM-014',
      tags: [tagA, tagB],
      customFields: { [catE1.fields[0]!.key]: 'hello' },
    });
    // Re-routed: category E2 (team E2); agent E1 is not on team E2 → unassigned.
    await patch(w.admin, {
      categoryId: catE2.category.id,
      subtypeId: catE2.subtypes[0]!.id,
    });
    // First public reply by agent E2: FIRST_REPLY, takes the ticket, OPEN → PENDING.
    const reply = await postMessage(ctx, agentE2, ticketId, { body: 'On it.' });
    expect(reply.statusCode, reply.body).toBe(201);

    // System events as the worker writes them, each later than the API's.
    system.base = Date.now() + 60_000;
    const at = (i: number) => new Date(system.base + i * 1000);
    const ruleId = randomUUID();
    await ctx.prisma.ticketEvent.createMany({
      data: [
        {
          ticketId,
          type: 'SLA_AT_RISK',
          meta: { target: 'FIRST_REPLY', dueAt: '2026-09-30T10:00:00.000Z' },
          createdAt: at(1),
        },
        {
          ticketId,
          type: 'SLA_BREACHED',
          meta: { target: 'RESOLUTION', dueAt: '2026-09-30T12:00:00.000Z' },
          createdAt: at(2),
        },
        {
          ticketId,
          type: 'ESCALATED',
          fromValue: '0',
          toValue: '1',
          meta: {
            step: 1,
            ruleId,
            targetType: 'ON_CALL',
            channels: ['EMAIL', 'SMS'],
            p1Since: '2026-09-30T09:00:00.000Z',
          },
          createdAt: at(3),
        },
        {
          ticketId,
          type: 'P1_ACKNOWLEDGED',
          actorId: agentE2.id,
          toValue: agentE2.id,
          meta: { step: 1, p1Since: null, minutesToAcknowledge: 3 },
          createdAt: at(4),
        },
        {
          ticketId,
          type: 'AUTO_CLOSED',
          fromValue: 'SOLVED',
          toValue: 'CLOSED',
          meta: { days: 5, secret: 'not passed on' },
          createdAt: at(5),
        },
        // An assignee that no longer exists, and a value that is not an id.
        {
          ticketId,
          type: 'ASSIGNEE_CHANGED',
          fromValue: randomUUID(),
          toValue: 'someone',
          createdAt: at(6),
        },
      ],
    });

    // Archive what the history refers to; disable agent E1.
    await ctx.prisma.category.update({
      where: { id: catE1.category.id },
      data: { isActive: false },
    });
    await ctx.prisma.subtype.update({
      where: { id: catE1.subtypes[0]!.id },
      data: { isActive: false },
    });
    await ctx.prisma.customField.update({
      where: { id: catE1.fields[0]!.id },
      data: { isActive: false },
    });
    await ctx.prisma.team.update({ where: { id: teamE1.id }, data: { isActive: false } });
    await ctx.prisma.site.update({ where: { id: w.siteX2.id }, data: { isActive: false } });
    await ctx.prisma.user.update({ where: { id: agentE1.id }, data: { status: 'DISABLED' } });
    await ctx.app.services.ticketConfig.invalidate();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function page(as: Persona, query = '') {
    const res = await apiAs(ctx, as).get(`/tickets/${ticketId}/events${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return ticketEventListSchema.parse(res.json());
  }

  async function all(as: Persona, limit: number) {
    const items: TicketEventDto[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await page(
        as,
        `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...body.items);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    return items;
  }

  it('lists every event newest first, with who and when', async () => {
    const { items, nextCursor } = await page(w.admin, '?limit=100');
    expect(nextCursor).toBeNull();
    const times = items.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The system events (distinct times) first, newest first.
    expect(items.slice(0, 6).map((e) => e.type)).toEqual([
      'ASSIGNEE_CHANGED',
      'AUTO_CLOSED',
      'P1_ACKNOWLEDGED',
      'ESCALATED',
      'SLA_BREACHED',
      'SLA_AT_RISK',
    ]);
    expect(items.map((e) => e.type).sort()).toEqual(
      [
        'CREATED',
        // Agent E1's edit.
        'STATUS_CHANGED',
        'PRIORITY_CHANGED',
        'ASSIGNEE_CHANGED',
        'IMPACT_CHANGED',
        'SITE_CHANGED',
        'ASSET_CHANGED',
        'TAGS_CHANGED',
        'CUSTOM_FIELDS_CHANGED',
        // The admin's re-route.
        'CATEGORY_CHANGED',
        'SUBTYPE_CHANGED',
        'TEAM_CHANGED',
        'ASSIGNEE_CHANGED',
        // Agent E2's reply.
        'FIRST_REPLY',
        'ASSIGNEE_CHANGED',
        'STATUS_CHANGED',
        // System.
        'SLA_AT_RISK',
        'SLA_BREACHED',
        'ESCALATED',
        'P1_ACKNOWLEDGED',
        'AUTO_CLOSED',
        'ASSIGNEE_CHANGED',
      ].sort(),
    );
    expect(items.at(-1)).toMatchObject({
      type: 'CREATED',
      actor: { id: w.clientX.id, name: w.clientX.name, role: 'CLIENT' },
      from: null,
      to: { kind: 'status', value: 'NEW' },
    });
    // System events have no actor.
    expect(items[1]).toMatchObject({ type: 'AUTO_CLOSED', actor: null });
  });

  it('resolves ids to labels, archived and disabled ones included', async () => {
    const { items } = await page(w.admin, '?limit=100');
    const one = (type: string, where: (e: TicketEventDto) => boolean = () => true) => {
      const found = items.filter((e) => e.type === type && where(e));
      expect(found, type).toHaveLength(1);
      return found[0]!;
    };
    const created = one('CREATED');
    expect(created.meta).toEqual({
      priority: 'P3',
      type: 'INCIDENT',
      channel: 'PORTAL',
      category: {
        kind: 'category',
        id: catE1.category.id,
        key: catE1.category.key,
        labelEn: catE1.category.labelEn,
        labelAr: catE1.category.labelAr,
        icon: catE1.category.icon,
        isActive: false,
      },
      subtype: {
        kind: 'subtype',
        id: catE1.subtypes[0]!.id,
        key: catE1.subtypes[0]!.key,
        labelEn: catE1.subtypes[0]!.labelEn,
        labelAr: catE1.subtypes[0]!.labelAr,
        isActive: false,
      },
    });
    expect(one('PRIORITY_CHANGED')).toMatchObject({
      actor: { id: agentE1.id, role: 'AGENT' },
      from: { kind: 'priority', value: 'P3' },
      to: { kind: 'priority', value: 'P2' },
    });
    expect(one('IMPACT_CHANGED')).toMatchObject({
      from: { kind: 'impact', value: 'SINGLE_USER' },
      to: { kind: 'impact', value: 'DEPARTMENT' },
    });
    expect(one('SITE_CHANGED')).toMatchObject({
      from: { kind: 'site', id: w.siteX1.id, name: 'X HQ', isActive: true },
      to: { kind: 'site', id: w.siteX2.id, name: 'X Branch', isActive: false },
    });
    expect(one('ASSET_CHANGED')).toMatchObject({
      from: null,
      to: { kind: 'text', value: 'CAM-014' },
    });
    expect(one('TAGS_CHANGED')).toMatchObject({
      from: null,
      to: { kind: 'tags', value: [tagA, tagB] },
      meta: { added: [tagA, tagB], removed: [] },
    });
    expect(one('CUSTOM_FIELDS_CHANGED').meta).toEqual({
      fields: [
        {
          key: catE1.fields[0]!.key,
          labelEn: catE1.fields[0]!.labelEn,
          labelAr: catE1.fields[0]!.labelAr,
          isActive: false,
        },
      ],
    });
    expect(one('CATEGORY_CHANGED')).toMatchObject({
      actor: { id: w.admin.id, role: 'SUPER_ADMIN' },
      from: { kind: 'category', id: catE1.category.id, isActive: false },
      to: { kind: 'category', id: catE2.category.id, isActive: true },
    });
    expect(one('SUBTYPE_CHANGED')).toMatchObject({
      from: { kind: 'subtype', id: catE1.subtypes[0]!.id, isActive: false },
      to: { kind: 'subtype', id: catE2.subtypes[0]!.id, isActive: true },
    });
    expect(one('TEAM_CHANGED')).toMatchObject({
      from: { kind: 'team', id: teamE1.id, isActive: false },
      to: { kind: 'team', id: teamE2.id, isActive: true },
    });
    // Agent E1 (disabled since) assigned themselves; the re-route unassigned them; E2 took it.
    expect(
      one('ASSIGNEE_CHANGED', (e) => e.from === null && e.actor?.id === agentE1.id),
    ).toMatchObject({ to: { kind: 'user', id: agentE1.id, name: agentE1.name, isActive: false } });
    expect(one('ASSIGNEE_CHANGED', (e) => e.to === null)).toMatchObject({
      from: { kind: 'user', id: agentE1.id, isActive: false },
    });
    expect(one('ASSIGNEE_CHANGED', (e) => e.actor?.id === agentE2.id)).toMatchObject({
      from: null,
      to: { kind: 'user', id: agentE2.id, isActive: true },
    });
    expect(one('ASSIGNEE_CHANGED', (e) => e.to?.kind === 'text')).toMatchObject({
      from: { kind: 'removed', entity: 'user' },
      to: { kind: 'text', value: 'someone' },
    });
    expect(one('FIRST_REPLY')).toMatchObject({
      actor: { id: agentE2.id },
      from: null,
      to: null,
      meta: { minutesToFirstReply: expect.any(Number) },
    });
    expect(one('STATUS_CHANGED', (e) => e.actor?.id === agentE2.id)).toMatchObject({
      from: { kind: 'status', value: 'OPEN' },
      to: { kind: 'status', value: 'PENDING' },
    });
    expect(one('SLA_AT_RISK')).toMatchObject({
      actor: null,
      meta: { target: 'FIRST_REPLY', dueAt: '2026-09-30T10:00:00.000Z' },
    });
    expect(one('SLA_BREACHED').meta).toEqual({
      target: 'RESOLUTION',
      dueAt: '2026-09-30T12:00:00.000Z',
    });
    // Escalation: the step numbers, the target and channels (the rule id stays internal).
    expect(one('ESCALATED')).toMatchObject({
      from: { kind: 'step', value: 0 },
      to: { kind: 'step', value: 1 },
    });
    expect(one('ESCALATED').meta).toEqual({
      step: 1,
      targetType: 'ON_CALL',
      channels: ['EMAIL', 'SMS'],
    });
    expect(one('P1_ACKNOWLEDGED')).toMatchObject({
      actor: { id: agentE2.id },
      to: { kind: 'user', id: agentE2.id },
      meta: { step: 1, minutesToAcknowledge: 3 },
    });
    expect(one('AUTO_CLOSED')).toMatchObject({
      from: { kind: 'status', value: 'SOLVED' },
      to: { kind: 'status', value: 'CLOSED' },
    });
    expect(one('AUTO_CLOSED').meta).toEqual({ days: 5 });
  });

  it.each([1, 2, 5])(
    'pages with a cursor, newest first, without gaps or repeats (page size %i)',
    async (limit) => {
      const full = (await page(w.admin, '?limit=100')).items.map((e) => e.id);
      const paged = (await all(w.admin, limit)).map((e) => e.id);
      expect(paged).toEqual(full);
    },
  );

  it('a malformed cursor or limit is 400', async () => {
    for (const query of [
      '?cursor=garbage',
      `?cursor=${'x'.repeat(201)}`,
      '?limit=0',
      '?limit=101',
    ]) {
      const res = await apiAs(ctx, w.admin).get(`/tickets/${ticketId}/events${query}`);
      expect(res.statusCode, query).toBe(400);
    }
    const bad = Buffer.from(`not-a-date|${randomUUID()}`).toString('base64url');
    expect(
      (await apiAs(ctx, w.admin).get(`/tickets/${ticketId}/events?cursor=${bad}`)).statusCode,
    ).toBe(400);
    // Well-formed ISO instants Postgres can't store are a 400 too, never a 500.
    for (const at of [
      '0000-01-01T00:00:00.000Z',
      '-010000-01-01T00:00:00.000Z',
      '+275760-09-13T00:00:00.000Z',
    ]) {
      const cursor = Buffer.from(`${at}|${randomUUID()}`).toString('base64url');
      const res = await apiAs(ctx, w.admin).get(`/tickets/${ticketId}/events?cursor=${cursor}`);
      expect(res.statusCode, at).toBe(400);
    }
    // The first and last storable instants still page.
    for (const at of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      const cursor = Buffer.from(`${at}|${randomUUID()}`).toString('base64url');
      const res = await apiAs(ctx, w.admin).get(`/tickets/${ticketId}/events?cursor=${cursor}`);
      expect(res.statusCode, at).toBe(200);
    }
  });

  it('staff who can see the ticket only: clients 403, other teams and unknown tickets 404', async () => {
    // Agent E2's team has the ticket now; agent A's team doesn't.
    expect((await page(agentE2)).items.length).toBeGreaterThan(0);
    expect((await apiAs(ctx, w.agentA).get(`/tickets/${ticketId}/events`)).statusCode).toBe(404);
    expect((await apiAs(ctx, w.agentA).get(`/tickets/${randomUUID()}/events`)).statusCode).toBe(
      404,
    );
    // The requester's organisation can read the ticket, but not its staff timeline.
    expect((await apiAs(ctx, w.clientX).get(`/tickets/${ticketId}/events`)).statusCode).toBe(403);
    expect((await apiAs(ctx, w.clientY).get(`/tickets/${randomUUID()}/events`)).statusCode).toBe(
      403,
    );
    expect((await apiAs(ctx).get(`/tickets/${ticketId}/events`)).statusCode).toBe(401);
    expect((await apiAs(ctx, w.admin).get('/tickets/LG-1/events')).statusCode).toBe(400);
  });
});
