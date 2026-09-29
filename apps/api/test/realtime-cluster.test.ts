import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rooms, type SocketAck } from '@loons/shared';
import { usersWhoLostAccess } from '../src/realtime/tickets.ts';
import { createTestContext, rand, testRedisPrefix, type TestContext } from './helpers.ts';
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

// Room evictions across API instances (review SEC-RT-3) and without the Redis adapter.

interface Received {
  event: string;
  payload: unknown;
}

/** `local`: look at each instance's own rooms only (another instance may never answer). */
function harness(contexts: () => TestContext[], options: { local?: boolean } = {}) {
  const membersOf = (ctx: TestContext, room: string) =>
    (options.local ? ctx.app.realtime.io.local : ctx.app.realtime.io)
      .in(room as never)
      .fetchSockets();
  const sockets: Socket[] = [];
  const urls = new Map<TestContext, string>();

  async function listen(): Promise<void> {
    for (const ctx of contexts()) {
      await ctx.app.listen({ host: '127.0.0.1', port: 0 });
      urls.set(ctx, `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`);
    }
  }

  async function connectTo(ctx: TestContext, as: Pick<Persona, 'id' | 'token'>) {
    const socket = connect(urls.get(ctx)!, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: as.token },
      extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
    });
    sockets.push(socket);
    const received: Received[] = [];
    socket.onAny((event: string, payload: unknown) => received.push({ event, payload }));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    await expect
      .poll(async () => (await membersOf(ctx, rooms.user(as.id))).length)
      .toBeGreaterThan(0);
    return { socket, received };
  }

  const join = (socket: Socket, ticketId: string): Promise<SocketAck> =>
    socket.timeout(5000).emitWithAck('ticket:join', { ticketId });

  const inRoom = async (ctx: TestContext, room: string, socket: Socket) =>
    (await membersOf(ctx, room)).some((s) => s.id === socket.id);

  const updatesFor = (received: Received[], ticketId: string) =>
    received.filter(
      (r) =>
        r.event === 'ticket:updated' &&
        (r.payload as { ticket: { id: string } }).ticket.id === ticketId,
    );

  return {
    sockets,
    listen,
    connectTo,
    join,
    inRoom,
    updatesFor,
    disconnectAll: () => sockets.forEach((s) => s.disconnect()),
  };
}

describe('two API instances sharing Redis (Socket.IO Redis adapter)', () => {
  let one: TestContext;
  let two: TestContext;
  let w: World;
  const h = harness(() => [one, two]);

  beforeAll(async () => {
    const redisPrefix = testRedisPrefix();
    one = await createTestContext({ config: { redisPrefix, socketRedisAdapter: true } });
    two = await createTestContext({ config: { redisPrefix, socketRedisAdapter: true } });
    await h.listen();
    w = await createWorld(one);
    await two.app.services.ticketConfig.invalidate();
  });
  afterAll(async () => {
    h.disconnectAll();
    await two.app.close();
    await one.close();
    await two.queues.close().catch(() => undefined);
    await two.redis.quit().catch(() => undefined);
    await two.prisma.$disconnect();
  });

  it('a re-route on one instance evicts the other instance’s sockets before ticket:updated goes out', async () => {
    for (let run = 0; run < 3; run++) {
      const t = await createTicket(one, w.clientX, ticketBody(w));
      const remote = await h.connectTo(two, w.agentA2); // team A, not assigned
      const local = await h.connectTo(one, w.agentA2);
      const stays = await h.connectTo(two, w.admin);
      for (const s of [remote, local, stays]) {
        expect(await h.join(s.socket, t.id)).toEqual({ ok: true });
      }
      const res = await apiAs(one, w.agentA).patch(`/tickets/${t.id}`, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      });
      expect(res.statusCode).toBe(200);
      const secret = `REMOTE-${rand(6)}`;
      await postMessage(one, w.agentB, t.id, { type: 'INTERNAL', body: secret });
      // The admin (still allowed) on instance two gets both: the events did travel.
      await expect.poll(() => JSON.stringify(stays.received)).toContain(secret);
      expect(h.updatesFor(stays.received, t.id).length).toBeGreaterThan(0);
      for (const s of [remote, local]) {
        expect(h.updatesFor(s.received, t.id), `run ${run}`).toEqual([]);
        expect(JSON.stringify(s.received)).not.toContain(secret);
      }
      expect(await h.inRoom(two, rooms.ticket(t.id), remote.socket)).toBe(false);
      expect(await h.inRoom(one, rooms.ticket(t.id), local.socket)).toBe(false);
      for (const s of [remote, local, stays]) s.socket.disconnect();
    }
  });

  it('refreshUser reaches the user’s sockets on the other instance', async () => {
    const t = await createTicket(one, w.clientX, ticketBody(w));
    const user = await one.fixtures.staff({
      staffDomain: one.config.staffEmailDomain,
      name: 'Rita Remote',
    });
    await one.fixtures.member(w.teamA.id, user.id);
    const remote = await h.connectTo(two, await persona(one, user));
    expect(await h.join(remote.socket, t.id)).toEqual({ ok: true });
    await expect.poll(() => h.inRoom(two, rooms.team(w.teamA.id), remote.socket)).toBe(true);

    await one.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
    });
    await one.app.principals.invalidate(user.id); // on instance one
    await expect.poll(() => h.inRoom(two, rooms.ticket(t.id), remote.socket)).toBe(false);
    await expect.poll(() => h.inRoom(two, rooms.team(w.teamA.id), remote.socket)).toBe(false);
    expect(remote.socket.connected).toBe(true);
  });
});

describe('a single instance without the Redis adapter', () => {
  let ctx: TestContext;
  let w: World;
  const h = harness(() => [ctx]);

  beforeAll(async () => {
    ctx = await createTestContext({ config: { socketRedisAdapter: false } });
    await h.listen();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    h.disconnectAll();
    await ctx.close();
  });

  it('usersWhoLostAccess: old-team members not on the new team, and a replaced assignee', async () => {
    const orgId = w.orgX.id;
    const [a, b] = [w.teamA.id, w.teamB.id];
    // Re-routed from team A (assigned to agent A) to team B, unassigned.
    const lost = await usersWhoLostAccess(
      ctx.prisma,
      { orgId, teamId: a, assigneeId: w.agentA.id },
      { orgId, teamId: b, assigneeId: null },
    );
    expect(new Set(lost)).toEqual(
      new Set([w.agentA.id, w.agentA2.id, w.leadA.id, w.disabledAgent.id]),
    );
    // Re-routed, but agent A2 is the new assignee: they keep it.
    expect(
      await usersWhoLostAccess(
        ctx.prisma,
        { orgId, teamId: a, assigneeId: null },
        { orgId, teamId: b, assigneeId: w.agentA2.id },
      ),
    ).not.toContain(w.agentA2.id);
    // Same team, re-assigned: the old assignee is still on the team; one from another team isn't.
    const sameTeam = { orgId, teamId: a, assigneeId: w.agentA2.id };
    expect(
      await usersWhoLostAccess(ctx.prisma, { orgId, teamId: a, assigneeId: w.agentA.id }, sameTeam),
    ).toEqual([]);
    expect(
      await usersWhoLostAccess(ctx.prisma, { orgId, teamId: a, assigneeId: w.agentB.id }, sameTeam),
    ).toEqual([w.agentB.id]);
    // Nothing that decides access changed: nothing to look up.
    expect(await usersWhoLostAccess(ctx.prisma, sameTeam, sameTeam)).toEqual([]);
  });

  it('re-routes and stale permissions evict members the same way', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const agent = await h.connectTo(ctx, w.agentA2);
    const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    await ctx.fixtures.member(w.teamA.id, user.id);
    const stale = await h.connectTo(ctx, await persona(ctx, user));
    const client = await h.connectTo(ctx, w.clientX);
    for (const s of [agent, stale, client])
      expect(await h.join(s.socket, t.id)).toEqual({ ok: true });

    // Stale: removed from the team, only the principal cache entry expired.
    await ctx.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
    });
    await ctx.redis.del(`${ctx.config.redisPrefix}principal:${user.id}`);
    expect(
      (await apiAs(ctx, w.agentA).patch(`/tickets/${t.id}`, { priority: 'P2' })).statusCode,
    ).toBe(200);
    expect(await h.inRoom(ctx, rooms.ticket(t.id), stale.socket)).toBe(false);
    expect(await h.inRoom(ctx, rooms.ticket(t.id), agent.socket)).toBe(true);

    // Re-route: agent A2 (team A) loses the ticket, the client keeps it.
    await apiAs(ctx, w.admin).patch(`/tickets/${t.id}`, {
      categoryId: w.catB.category.id,
      subtypeId: w.catB.subtypes[0]!.id,
    });
    expect(await h.inRoom(ctx, rooms.ticket(t.id), agent.socket)).toBe(false);
    expect(await h.inRoom(ctx, rooms.ticketStaff(t.id), agent.socket)).toBe(false);
    expect(await h.inRoom(ctx, rooms.ticket(t.id), client.socket)).toBe(true);
    await expect.poll(() => h.updatesFor(client.received, t.id).length).toBe(2);
    expect(h.updatesFor(agent.received, t.id)).toHaveLength(1); // the priority change only
    expect(h.updatesFor(stale.received, t.id)).toEqual([]);
  });
});

// Sweep: with the Redis adapter, the room re-check of every ticket update asked every instance
// for its members and waited up to the adapter's 5 s for a silent one (an instance whose event
// loop is stuck, or a host that died without closing its Redis connection) — then broadcast to
// the whole room, evicted users on other instances included.
describe('two instances and a subscribed peer that never answers', () => {
  let one: TestContext;
  let two: TestContext;
  let ghost: Redis;
  let w: World;
  const h = harness(() => [one, two], { local: true });

  beforeAll(async () => {
    const redisPrefix = testRedisPrefix();
    one = await createTestContext({ config: { redisPrefix, socketRedisAdapter: true } });
    two = await createTestContext({ config: { redisPrefix, socketRedisAdapter: true } });
    await h.listen();
    w = await createWorld(one);
    await two.app.services.ticketConfig.invalidate();
    const channel = `${redisPrefix}socket.io-request#/#`;
    ghost = one.redis.duplicate();
    await ghost.subscribe(channel);
    const [, subscribers] = (await one.redis.pubsub('NUMSUB', channel)) as [string, number];
    expect(subscribers).toBe(3); // one, two and the silent peer
  });
  afterAll(async () => {
    h.disconnectAll();
    await ghost.quit().catch(() => undefined);
    await two.app.close();
    await one.close();
    await two.queues.close().catch(() => undefined);
    await two.redis.quit().catch(() => undefined);
    await two.prisma.$disconnect();
  });

  it('updates and messages answer within the bound; users a re-route locked out get nothing more', async () => {
    const t = await createTicket(one, w.clientX, ticketBody(w));
    const remote = await h.connectTo(two, w.agentA2); // team A, not assigned: loses the ticket
    const stays = await h.connectTo(two, w.admin);
    const client = await h.connectTo(two, w.clientX);
    for (const s of [remote, stays, client]) {
      expect(await h.join(s.socket, t.id)).toEqual({ ok: true });
    }

    // A public reply updates the ticket (ticket:updated): it doesn't wait for the silent peer.
    let started = Date.now();
    const reply = await postMessage(one, w.clientX, t.id, { body: `hello ${rand(4)}` });
    expect(reply.statusCode).toBe(201);
    expect(Date.now() - started).toBeLessThan(2000);
    // Everyone could still see the ticket then.
    for (const s of [remote, stays, client]) {
      await expect.poll(() => h.updatesFor(s.received, t.id).length).toBe(1);
    }

    started = Date.now();
    const res = await apiAs(one, w.agentA).patch(`/tickets/${t.id}`, {
      categoryId: w.catB.category.id,
      subtypeId: w.catB.subtypes[0]!.id,
    });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    const secret = `SILENT-${rand(6)}`;
    const note = await postMessage(one, w.agentB, t.id, { type: 'INTERNAL', body: secret });
    expect(note.statusCode).toBe(201);

    // The admin and the client (still allowed) on instance two get the re-route; the admin the note.
    await expect.poll(() => JSON.stringify(stays.received)).toContain(secret);
    expect(h.updatesFor(stays.received, t.id)).toHaveLength(2);
    await expect.poll(() => h.updatesFor(client.received, t.id).length).toBe(2);
    // Agent A2 on instance two got neither, and is out of both rooms there.
    expect(h.updatesFor(remote.received, t.id)).toHaveLength(1);
    expect(JSON.stringify(remote.received)).not.toContain(secret);
    expect(await h.inRoom(two, rooms.ticket(t.id), remote.socket)).toBe(false);
    expect(await h.inRoom(two, rooms.ticketStaff(t.id), remote.socket)).toBe(false);
    expect(remote.socket.connected).toBe(true);
  });

  it('when the other instances do not answer, local members are still judged with fresh permissions', async () => {
    const t = await createTicket(one, w.clientX, ticketBody(w));
    const user = await one.fixtures.staff({ staffDomain: one.config.staffEmailDomain });
    await one.fixtures.member(w.teamA.id, user.id);
    const stale = await h.connectTo(one, await persona(one, user));
    const agent = await h.connectTo(one, w.agentA2);
    for (const s of [stale, agent]) expect(await h.join(s.socket, t.id)).toEqual({ ok: true });
    // Removed from the team; only the principal cache entry expired (no refreshUser ran).
    await one.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
    });
    await one.redis.del(`${one.config.redisPrefix}principal:${user.id}`);
    const started = Date.now();
    const res = await apiAs(one, w.agentA).patch(`/tickets/${t.id}`, { priority: 'P2' });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await h.inRoom(one, rooms.ticket(t.id), stale.socket)).toBe(false);
    expect(await h.inRoom(one, rooms.ticket(t.id), agent.socket)).toBe(true);
    await expect.poll(() => h.updatesFor(agent.received, t.id).length).toBe(1);
    expect(h.updatesFor(stale.received, t.id)).toEqual([]);
  });

  it('when the database cannot list who lost access either, the old team’s rooms leave (fail closed)', async () => {
    const t = await createTicket(one, w.clientX, ticketBody(w));
    const remote = await h.connectTo(two, w.agentA2); // team A: loses the ticket
    const client = await h.connectTo(two, w.clientX); // keeps it
    for (const s of [remote, client]) expect(await h.join(s.socket, t.id)).toEqual({ ok: true });
    const lookup = vi.spyOn(one.prisma.user, 'findMany').mockRejectedValue(new Error('db down'));
    try {
      const res = await apiAs(one, w.agentA).patch(`/tickets/${t.id}`, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      });
      expect(res.statusCode).toBe(200);
      expect(lookup).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
    const secret = `NODB-${rand(6)}`;
    expect(
      (await postMessage(one, w.agentB, t.id, { type: 'INTERNAL', body: secret })).statusCode,
    ).toBe(201);
    await expect.poll(() => h.updatesFor(client.received, t.id).length).toBe(1);
    await expect.poll(() => h.inRoom(two, rooms.ticket(t.id), remote.socket)).toBe(false);
    expect(h.updatesFor(remote.received, t.id)).toEqual([]);
    expect(JSON.stringify(remote.received)).not.toContain(secret);
    expect(await h.inRoom(two, rooms.ticket(t.id), client.socket)).toBe(true);
  });
});
