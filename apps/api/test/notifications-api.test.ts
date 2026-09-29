import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationListSchema, type NotificationType } from '@loons/shared';
import { createTestContext, type TestContext } from './helpers.ts';
import { apiAs, createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';

// GET /me/notifications and POST /me/notifications/read (D13): the caller's own notifications
// only, newest first with cursor paging, unread filter and count; marking read is idempotent and
// ignores other people's ids.

describe('in-app notifications API', () => {
  let ctx: TestContext;
  let w: World;
  const ids: string[] = [];
  let otherId: string;
  let ticketNumber: number;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    ticketNumber = t.number;
    const base = Date.now() - 60_000;
    const types: NotificationType[] = [
      'CLIENT_REPLY',
      'SLA_AT_RISK',
      'SLA_BREACHED',
      'P1_CREATED',
      'P1_ESCALATED',
    ];
    for (const [i, type] of types.entries()) {
      const n = await ctx.prisma.notification.create({
        data: {
          userId: w.agentA.id,
          type,
          ticketId: t.id,
          data: {
            subject: 'Door',
            priority: 'P3',
            ...(type === 'P1_ESCALATED' ? { step: 2 } : {}),
          },
          createdAt: new Date(base + i * 1000),
        },
      });
      ids.push(n.id);
    }
    otherId = (
      await ctx.prisma.notification.create({
        data: { userId: w.agentB.id, type: 'CLIENT_REPLY', ticketId: null, data: {} },
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('lists only the caller’s notifications, newest first, with cursor paging and the unread count', async () => {
    const api = apiAs(ctx, w.agentA);
    const first = await api.get('/me/notifications?limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = notificationListSchema.parse(first.json());
    expect(page1.items.map((n) => n.id)).toEqual([ids[4], ids[3]]);
    expect(page1.unreadCount).toBe(5);
    expect(page1.items[0]).toMatchObject({
      type: 'P1_ESCALATED',
      ticketNumber,
      readAt: null,
      data: { subject: 'Door', priority: 'P3', step: 2 },
    });
    const seen = [...page1.items.map((n) => n.id)];
    let cursor = page1.nextCursor;
    while (cursor) {
      const res = await api.get(`/me/notifications?limit=2&cursor=${encodeURIComponent(cursor)}`);
      const page = notificationListSchema.parse(res.json());
      seen.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids].reverse());
    // Someone else's never appear.
    expect(seen).not.toContain(otherId);
    const b = notificationListSchema.parse(
      (await apiAs(ctx, w.agentB).get('/me/notifications')).json(),
    );
    expect(b.items.map((n) => n.id)).toEqual([otherId]);
    expect(b.items[0]!.ticketNumber).toBeNull();
  });

  it('marks some or all read (idempotent; other people’s ids are ignored) and filters unread', async () => {
    const api = apiAs(ctx, w.agentA);
    const some = await api.post('/me/notifications/read', { ids: [ids[0], ids[1], otherId] });
    expect(some.statusCode).toBe(200);
    expect(some.json()).toEqual({ updated: 2, unreadCount: 3 });
    expect((await api.post('/me/notifications/read', { ids: [ids[0]] })).json()).toEqual({
      updated: 0,
      unreadCount: 3,
    });
    const unread = notificationListSchema.parse(
      (await api.get('/me/notifications?unreadOnly=true')).json(),
    );
    expect(unread.items.map((n) => n.id)).toEqual([ids[4], ids[3], ids[2]]);
    const read = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: ids[0]! } });
    // "Mark all" up to the newest one the client has shown: one that arrived after it stays.
    const shown = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: ids[3]! } });
    const upTo = await api.post('/me/notifications/read', {
      all: true,
      upTo: shown.createdAt.toISOString(),
    });
    expect(upTo.json()).toEqual({ updated: 2, unreadCount: 1 });
    expect(
      (await ctx.prisma.notification.findUniqueOrThrow({ where: { id: ids[4]! } })).readAt,
    ).toBeNull();
    const again = await api.post('/me/notifications/read', { all: true });
    expect(again.json()).toEqual({ updated: 1, unreadCount: 0 });
    // The first read time is kept.
    expect(
      (await ctx.prisma.notification.findUniqueOrThrow({ where: { id: ids[0]! } })).readAt,
    ).toEqual(read.readAt);
    // B's notification is untouched.
    expect(
      (await ctx.prisma.notification.findUniqueOrThrow({ where: { id: otherId } })).readAt,
    ).toBeNull();
  });

  it('validates input and requires a signed-in user', async () => {
    const api = apiAs(ctx, w.agentA);
    for (const body of [
      {},
      { ids: [] },
      { ids: ['nope'] },
      { ids: [ids[0]], all: true },
      { all: false },
      { all: true, upTo: 'yesterday' },
      { ids: [ids[0]], upTo: new Date().toISOString() },
    ]) {
      expect(
        (await api.post('/me/notifications/read', body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await api.get('/me/notifications?limit=51')).statusCode).toBe(400);
    expect((await api.get('/me/notifications?cursor=garbage')).statusCode).toBe(400);
    expect((await apiAs(ctx, null).get('/me/notifications')).statusCode).toBe(401);
    expect((await apiAs(ctx, null).post('/me/notifications/read', { all: true })).statusCode).toBe(
      401,
    );
    expect((await apiAs(ctx, w.pending).get('/me/notifications')).statusCode).toBe(403);
  });

  it('is documented in OpenAPI with schemas, security and error responses', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json();
    for (const [method, path] of [
      ['get', '/me/notifications'],
      ['post', '/me/notifications/read'],
      ['post', '/tickets/{id}/acknowledge'],
    ] as const) {
      const op = doc.paths[path]?.[method];
      expect(op, path).toBeDefined();
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      for (const code of ['200', '400', '401', '403', '429']) {
        expect(op.responses[code], `${path} ${code}`).toBeDefined();
      }
      expect(op.responses['200'].content['application/json'].schema).toBeDefined();
    }
    expect(doc.paths['/tickets/{id}/acknowledge'].post.responses['404']).toBeDefined();
    expect(doc.paths['/tickets/{id}/acknowledge'].post.responses['409']).toBeDefined();
  });
});
