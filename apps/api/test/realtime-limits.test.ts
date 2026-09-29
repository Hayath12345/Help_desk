import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAX_TICKET_ROOMS_PER_SOCKET, rooms, type SocketAck } from '@loons/shared';
import {
  ConnectionLimiter,
  DEFAULT_REALTIME_LIMITS,
  DropCounter,
  HandshakeGate,
  PACKETS_BEFORE_CONNECT,
  TOO_MANY_HANDSHAKES,
  TOO_MANY_PENDING,
  TokenBucket,
  isConnectPacket,
} from '../src/realtime/limits.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { createTicket, createWorld, ticketBody, type Persona, type World } from './ticket-world.ts';

// Socket limits (review SEC-RT-1, re-review RR-SEC-1 / RR-SEC-2): engine.io traffic never reaches
// the Fastify rate limits, so room joins (a Redis + Postgres read each) are throttled per socket
// and per user, every event spends a per-socket token, the number of concurrent sockets per user
// and per address is capped, and handshakes (a JWT verify + principal load each) are limited
// before any of that work happens.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TokenBucket', () => {
  it('allows a burst, then refills at the given rate', () => {
    const bucket = new TokenBucket({ burst: 3, perSecond: 2 }, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(bucket.take(400)).toBe(false); // 0.8 tokens
    expect(bucket.take(500)).toBe(true); // 1 token after 500 ms
    expect(bucket.isFull(10_000)).toBe(true);
  });
});

describe('DropCounter (refused events before a disconnect)', () => {
  it('allows `max` refusals at once, then refills at max per window', () => {
    const drops = new DropCounter(5, 10_000, 0);
    for (let i = 0; i < 5; i++) expect(drops.record(0)).toBe(false);
    expect(drops.record(0)).toBe(true); // the (max + 1)th
    expect(drops.record(1_000)).toBe(true); // half a token back (1 per 2 s)
    expect(drops.record(3_000)).toBe(false); // 1.5 tokens
    expect(drops.record(3_000)).toBe(true);
  });

  it('a window boundary does not double the allowance (re-review: fixed window)', () => {
    const drops = new DropCounter(500, 10_000, 0);
    // 500 refusals just before the old window would have rolled over…
    for (let i = 0; i < 500; i++) expect(drops.record(9_999)).toBe(false);
    // …and the next ones just after it: disconnected at once (2 ms refill 0.1 token).
    expect(drops.record(10_001)).toBe(true);
    // A full window later the allowance is back.
    expect(drops.record(20_001)).toBe(false);
  });
});

describe('ConnectionLimiter handshakes (review RR-SEC-1)', () => {
  it('budgets new connections per address and forgets refilled addresses', () => {
    const limiter = new ConnectionLimiter({
      ...DEFAULT_REALTIME_LIMITS,
      handshakesPerIp: { burst: 2, perSecond: 1 },
      socketsPerIp: 1,
    });
    expect([
      limiter.takeHandshake('a', 0),
      limiter.takeHandshake('a', 0),
      limiter.takeHandshake('a', 0),
      limiter.takeHandshake('b', 0),
    ]).toEqual([true, true, false, true]);
    expect(limiter.takeHandshake('a', 1000)).toBe(true);
    limiter.prune(1000);
    expect(limiter.count('address', 'a')).toBe(0);
    expect(limiter.atAddressCap('a')).toBe(false);
    limiter.admit('s1', 'u1', 'a');
    expect(limiter.atAddressCap('a')).toBe(true);
    expect(limiter.atAddressCap('b')).toBe(false);
  });
});

describe('HandshakeGate (review RR-SEC-1)', () => {
  it('one handshake at a time; closed after the allowed number of refusals', () => {
    const gate = new HandshakeGate(1);
    const conn = {};
    expect(gate.begin(conn)).toBe(true);
    expect(gate.begin(conn)).toBe(false); // already being checked
    expect(gate.end(conn, false)).toBe(true); // refused once: close
    expect(gate.begin(conn)).toBe(false);
    const lenient = new HandshakeGate(2);
    const other = {};
    expect(lenient.begin(other)).toBe(true);
    expect(lenient.end(other, false)).toBe(false);
    expect(lenient.begin(other)).toBe(true);
    expect(lenient.end(other, true)).toBe(false);
  });

  it('counts packets until the connection is connected', () => {
    const gate = new HandshakeGate(1);
    const conn = {};
    for (let i = 0; i < PACKETS_BEFORE_CONNECT; i++) expect(gate.packet(conn)).toBe(true);
    expect(gate.packet(conn)).toBe(false);
    const connected = {};
    gate.begin(connected);
    gate.end(connected, true);
    for (let i = 0; i < PACKETS_BEFORE_CONNECT + 5; i++) expect(gate.packet(connected)).toBe(true);
    // Any CONNECT once connected (re-review RR-SEC-2).
    expect(gate.packet(connected, true)).toBe(false);
    expect(gate.packet({}, true)).toBe(true); // the first CONNECT of a new connection
  });

  it('recognises Socket.IO CONNECT packets', () => {
    expect(isConnectPacket('0')).toBe(true);
    expect(isConnectPacket('0/x,')).toBe(true);
    expect(isConnectPacket('0{"token":"t"}')).toBe(true);
    expect(isConnectPacket('2["ticket:join",{}]')).toBe(false);
    expect(isConnectPacket('43[]')).toBe(false);
    expect(isConnectPacket(Buffer.from('0'))).toBe(false);
  });
});

describe('ConnectionLimiter pending connections (review RR-SEC-1)', () => {
  it('counts connections per address until they connect or close', () => {
    const limiter = new ConnectionLimiter({
      ...DEFAULT_REALTIME_LIMITS,
      pendingConnectionsPerIp: 2,
    });
    const [a, b, c] = [{}, {}, {}];
    limiter.addPending('1.2.3.4', a);
    expect(limiter.atPendingCap('1.2.3.4')).toBe(false);
    limiter.addPending('1.2.3.4', b);
    expect(limiter.atPendingCap('1.2.3.4')).toBe(true);
    expect(limiter.atPendingCap('5.6.7.8')).toBe(false);
    limiter.settlePending('1.2.3.4', a);
    limiter.settlePending('1.2.3.4', a); // idempotent
    expect(limiter.count('pending', '1.2.3.4')).toBe(1);
    limiter.addPending('1.2.3.4', c);
    expect(limiter.atPendingCap('1.2.3.4')).toBe(true);
    limiter.settlePending('1.2.3.4', b);
    limiter.settlePending('1.2.3.4', c);
    expect(limiter.count('pending', '1.2.3.4')).toBe(0);
  });
});

type Outcome = { ok: true } | { ok: false; message: string };

describe('socket limits', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
  let open: Socket[] = [];

  const LIMITS = {
    joinPerSocket: { burst: 5, perSecond: 0.001 },
    joinPerUser: { burst: 8, perSecond: 0.001 },
    leavePerSocket: { burst: 5, perSecond: 0.001 },
    eventsPerSocket: { burst: 30, perSecond: 0.001 },
    socketsPerUser: 3,
    socketsPerIp: 6,
    dropsBeforeDisconnect: 20,
    dropWindowMs: 60_000,
  };

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { realtimeLimits: LIMITS } });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    w = await createWorld(ctx);
  });
  afterEach(async () => {
    for (const s of open) s.disconnect();
    open = [];
    // Let the server see the disconnects before the next test counts sockets.
    await expect.poll(async () => (await ctx.app.realtime.io.fetchSockets()).length).toBe(0);
  });
  afterAll(async () => {
    await ctx.close();
  });

  function socketFor(persona: Pick<Persona, 'token'>): Socket {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: persona.token },
      extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
    });
    open.push(socket);
    return socket;
  }

  const outcome = (socket: Socket): Promise<Outcome> =>
    new Promise((resolve) => {
      socket.once('connect', () => resolve({ ok: true }));
      socket.once('connect_error', (err) => resolve({ ok: false, message: err.message }));
    });

  async function connected(persona: Pick<Persona, 'token'>): Promise<Socket> {
    const socket = socketFor(persona);
    expect(await outcome(socket)).toEqual({ ok: true });
    return socket;
  }

  const ack = (socket: Socket, event: string, payload: unknown): Promise<SocketAck> =>
    socket.timeout(5000).emitWithAck(event, payload);

  /** Fires `count` events at once and tallies the acks. */
  async function burst(socket: Socket, event: string, count: number, ticketId?: string) {
    const acks = await Promise.all(
      Array.from({ length: count }, () =>
        ack(socket, event, { ticketId: ticketId ?? randomUUID() }),
      ),
    );
    const tally: Record<string, number> = {};
    for (const a of acks) {
      const key = a.ok ? 'ok' : a.error;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }

  it('ticket:join is throttled per socket (RATE_LIMITED acks, no database work)', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const socket = await connected(w.clientX);
    expect(await burst(socket, 'ticket:join', 12)).toEqual({ NOT_FOUND: 5, RATE_LIMITED: 7 });
    // Even a legitimate join is refused until the budget refills…
    expect(await ack(socket, 'ticket:join', { ticketId: t.id })).toEqual({
      ok: false,
      error: 'RATE_LIMITED',
    });
    expect(
      (await ctx.app.realtime.io.in(rooms.ticket(t.id)).fetchSockets()).map((s) => s.id),
    ).not.toContain(socket.id);
    // …and the socket stays usable.
    expect(socket.connected).toBe(true);
  });

  it('the per-user budget is shared by all of the user’s sockets (and survives reconnecting)', async () => {
    const first = await connected(w.clientX2);
    expect(await burst(first, 'ticket:join', 5)).toEqual({ NOT_FOUND: 5 });
    const second = await connected(w.clientX2);
    // 8 per user: 3 left for the second socket, although its own budget is 5.
    expect(await burst(second, 'ticket:join', 5)).toEqual({ NOT_FOUND: 3, RATE_LIMITED: 2 });
    first.disconnect();
    second.disconnect();
    const third = await connected(w.clientX2);
    expect(await burst(third, 'ticket:join', 2)).toEqual({ RATE_LIMITED: 2 });
  });

  it('ticket:leave has its own per-socket budget', async () => {
    const socket = await connected(w.clientY);
    expect(await burst(socket, 'ticket:leave', 7)).toEqual({ ok: 5, RATE_LIMITED: 2 });
  });

  it('a socket that keeps flooding after being throttled is disconnected', async () => {
    const socket = await connected(w.clientX);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i < 40; i++)
      socket.emit('ticket:join', { ticketId: randomUUID() }, () => undefined);
    expect(await closed).toBe('io server disconnect');
  });

  it('caps concurrent sockets per user; a closed socket frees its slot', async () => {
    const sockets = [
      await connected(w.agentA),
      await connected(w.agentA),
      await connected(w.agentA),
    ];
    expect(await outcome(socketFor(w.agentA))).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
    // Other users are not affected.
    await connected(w.agentB);
    sockets[0]!.disconnect();
    await expect
      .poll(
        async () => (await ctx.app.realtime.io.in(rooms.user(w.agentA.id)).fetchSockets()).length,
      )
      .toBe(2);
    expect(await outcome(socketFor(w.agentA))).toEqual({ ok: true });
  });

  it('caps concurrent sockets per client address', async () => {
    const users = [w.agentA, w.agentA2, w.agentB, w.leadA, w.admin, w.clientX];
    for (const user of users) await connected(user); // 6 from 127.0.0.1
    expect(await outcome(socketFor(w.clientY))).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
  });

  // Re-review RR-SEC-2: refused typing events used to cost as much as valid ones and were never
  // counted, so one socket could send tens of thousands of them per second for as long as it liked.
  it('every refused typing event counts: a flood of invalid ones disconnects the socket', async () => {
    const socket = await connected(w.clientX);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    // One at a time, so each refusal comes from the typing handler (in a burst the event budget
    // runs out first, as the middleware sees every queued packet before a handler runs).
    const acks: SocketAck[] = [];
    for (let i = 0; i < 60 && socket.connected; i++) {
      try {
        acks.push(await socket.timeout(2000).emitWithAck('message:typing', { ticketId: 'nope' }));
      } catch {
        break; // disconnected before the ack
      }
    }
    expect(await Promise.race([closed, sleep(5000).then(() => 'still connected')])).toBe(
      'io server disconnect',
    );
    // Closed at the (dropsBeforeDisconnect + 1)th refusal, well within the event budget of 30.
    expect(acks).toHaveLength(LIMITS.dropsBeforeDisconnect + 1);
    expect(acks.every((a) => !a.ok && a.error === 'VALIDATION_FAILED')).toBe(true);
  });

  it('events without a handler are budgeted too: a flood of them disconnects the socket', async () => {
    const socket = await connected(w.clientY);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    const acks: SocketAck[] = [];
    for (let i = 0; i < 60; i++) socket.emit('no:such:event', {}, (a: SocketAck) => acks.push(a));
    expect(await Promise.race([closed, sleep(5000).then(() => 'still connected')])).toBe(
      'io server disconnect',
    );
    // The first `eventsPerSocket.burst` reach no handler (no ack); the rest are refused and counted.
    expect(acks).toHaveLength(LIMITS.dropsBeforeDisconnect + 1);
    expect(acks.every((a) => !a.ok && a.error === 'RATE_LIMITED')).toBe(true);
  });
});

describe('handshake limits (review RR-SEC-1)', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
  let origin: string;
  let open: Socket[] = [];
  let raw: WebSocket[] = [];
  /** Principal loads = handshakes that got as far as verifying a token. */
  let loads = 0;

  const LIMITS = { socketsPerIp: 3 };

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { realtimeLimits: LIMITS } });
    const load = ctx.app.principals.load;
    ctx.app.principals.load = (userId, options) => {
      loads += 1;
      return load(userId, options);
    };
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    origin = ctx.config.corsOrigins[0] ?? 'http://localhost:3000';
    w = await createWorld(ctx);
  });
  afterEach(async () => {
    for (const s of open) s.disconnect();
    for (const ws of raw) ws.close();
    open = [];
    raw = [];
    await expect.poll(async () => (await ctx.app.realtime.io.fetchSockets()).length).toBe(0);
  });
  afterAll(async () => {
    await ctx.close();
  });

  function socketFor(persona: Pick<Persona, 'token'>, options: { reconnection?: boolean } = {}) {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: options.reconnection ?? false,
      forceNew: true,
      auth: { token: persona.token },
      extraHeaders: { origin },
    });
    open.push(socket);
    return socket;
  }

  const outcome = (socket: Socket): Promise<Outcome> =>
    new Promise((resolve) => {
      socket.once('connect', () => resolve({ ok: true }));
      socket.once('connect_error', (err) => resolve({ ok: false, message: err.message }));
    });

  /**
   * A bare engine.io websocket, as an attacker would open it: Socket.IO packets are sent by hand
   * (`40{auth}` is a CONNECT to the default namespace; `44…` a CONNECT_ERROR back; `2` / `3` are
   * engine.io pings / pongs).
   */
  async function rawConnection() {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`, {
      headers: { origin },
    });
    raw.push(ws);
    const messages: string[] = [];
    let closed = false;
    ws.addEventListener('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
      ws.addEventListener('message', () => resolve(), { once: true }); // engine.io's open packet
    });
    ws.addEventListener('message', (event) => {
      const data = String(event.data);
      if (data === '2') ws.send('3');
      else messages.push(data);
    });
    return {
      ws,
      messages,
      send: (packet: string) => ws.send(packet),
      connect: (token: string) => ws.send(`40${JSON.stringify({ token })}`),
      closedWithin: async (ms: number) => {
        const until = Date.now() + ms;
        while (!closed && Date.now() < until) await sleep(20);
        return closed;
      },
    };
  }

  it('a refused handshake is answered, then the connection is closed (the client opens a new one)', async () => {
    const c = await rawConnection();
    loads = 0;
    c.connect(w.unverified.token); // a valid token of an unverified client: FORBIDDEN
    await expect.poll(() => c.messages.length).toBe(1);
    expect(c.messages[0]).toBe(`44${JSON.stringify({ message: 'FORBIDDEN' })}`);
    expect(await c.closedWithin(3000)).toBe(true);
    expect(loads).toBe(1);
  });

  it('a stream of CONNECT packets on one connection is cut off before the second is checked', async () => {
    const c = await rawConnection();
    loads = 0;
    for (let i = 0; i < 200; i++) c.connect(w.unverified.token);
    expect(await c.closedWithin(5000)).toBe(true);
    expect(loads).toBeLessThanOrEqual(1);
    expect(c.messages.filter((m) => m.startsWith('44')).length).toBeLessThanOrEqual(2);
  });

  it('a connection that talks before it is connected is closed (unknown namespaces, junk)', async () => {
    const c = await rawConnection();
    loads = 0;
    // CONNECTs for a namespace that doesn't exist: Socket.IO answers each without the handshake.
    for (let i = 0; i < 20; i++) c.send('40/nope,{}');
    expect(await c.closedWithin(5000)).toBe(true);
    expect(c.messages.length).toBeLessThanOrEqual(PACKETS_BEFORE_CONNECT);
    expect(loads).toBe(0);
  });

  it('an address at its socket cap is refused before any token is verified', async () => {
    for (const user of [w.clientX, w.clientX2, w.agentA]) {
      expect(await outcome(socketFor(user))).toEqual({ ok: true });
    }
    loads = 0;
    expect(await outcome(socketFor(w.agentB))).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
    expect(loads).toBe(0);
  });

  it('the web client’s flow still works: refused, then a fresh connection with a new token', async () => {
    // socket.io-client with reconnection on (as the web): a refused handshake stops it; the web
    // client then calls connect() again with a refreshed token, which opens a new connection.
    const socket = socketFor({ token: 'not.a.jwt' }, { reconnection: true });
    expect(await outcome(socket)).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
    await sleep(100);
    expect(socket.active).toBe(false);
    socket.auth = { token: w.clientX.token };
    socket.connect();
    expect(await outcome(socket)).toEqual({ ok: true });
    expect(socket.connected).toBe(true);
    // Both handshakes were checked: nothing about the first refusal lingers.
    expect(await ctx.app.realtime.io.fetchSockets()).toHaveLength(1);
  });
});

describe('handshake rate per address (review RR-SEC-1)', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
  let loads = 0;
  const sockets: Socket[] = [];
  const refusals: Array<{ code: number; message: string }> = [];

  beforeAll(async () => {
    ctx = await createTestContext({
      deps: { realtimeLimits: { handshakesPerIp: { burst: 2, perSecond: 0.001 } } },
    });
    const load = ctx.app.principals.load;
    ctx.app.principals.load = (userId, options) => {
      loads += 1;
      return load(userId, options);
    };
    ctx.app.realtime.io.engine.on(
      'connection_error',
      (err: { code: number; context?: { message?: string } }) => {
        refusals.push({ code: err.code, message: err.context?.message ?? '' });
      },
    );
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await ctx.close();
  });

  it('too many new connections from one address are refused at the upgrade, no token checked', async () => {
    const outcome = (persona: Pick<Persona, 'token'>) =>
      new Promise<Outcome>((resolve) => {
        const socket = connect(url, {
          path: '/socket.io',
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
          auth: { token: persona.token },
          extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
        });
        sockets.push(socket);
        socket.once('connect', () => resolve({ ok: true }));
        socket.once('connect_error', (err) => resolve({ ok: false, message: err.message }));
      });
    expect(await outcome(w.clientX)).toEqual({ ok: true });
    expect(await outcome(w.clientX2)).toEqual({ ok: true });
    loads = 0;
    // A transport error, not a handshake refusal: engine.io answered the upgrade with 403.
    expect(await outcome(w.agentA)).toEqual({ ok: false, message: 'websocket error' });
    expect(loads).toBe(0);
    expect(refusals).toEqual([{ code: 4, message: TOO_MANY_HANDSHAKES }]);
  });
});

describe('socket limits (defaults)', () => {
  let ctx: TestContext;
  let url: string;
  let w: World;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await ctx.close();
  });

  async function connected(persona: Pick<Persona, 'token'>): Promise<Socket> {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: persona.token },
      extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  it('what the web sends — typing bursts, a list refresh — never trips the event budget', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const socket = await connected(w.clientX2);
    const ack = (event: string, payload: unknown): Promise<SocketAck> =>
      socket.timeout(10_000).emitWithAck(event, payload);
    expect(await ack('ticket:join', { ticketId: t.id })).toEqual({ ok: true });
    // A burst of typing events well past the typing cap (30 per 10 s): throttled, still connected.
    const typing = await Promise.all(
      Array.from({ length: 40 }, () =>
        ack('message:typing', { ticketId: t.id, isTyping: true, scope: 'public' }),
      ),
    );
    expect(typing.filter((a) => a.ok)).toHaveLength(1);
    expect(typing.filter((a) => !a.ok && a.error === 'RATE_LIMITED')).toHaveLength(39);
    const refresh = [
      ...(await Promise.all(
        Array.from({ length: 50 }, () => ack('ticket:leave', { ticketId: randomUUID() })),
      )),
      ...(await Promise.all(
        Array.from({ length: 50 }, () => ack('ticket:join', { ticketId: randomUUID() })),
      )),
    ];
    expect(refresh.filter((a) => !a.ok && a.error === 'RATE_LIMITED')).toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it('a web list refresh (50 leaves + 50 joins, twice) passes; a flood is cut to the budget', async () => {
    const socket = await connected(w.clientX);
    const send = (event: string, n: number) =>
      Promise.all(
        Array.from({ length: n }, () =>
          socket.timeout(10_000).emitWithAck(event, { ticketId: randomUUID() }),
        ),
      );
    const legit = [
      ...(await send('ticket:join', 50)),
      ...(await send('ticket:leave', 50)),
      ...(await send('ticket:join', 50)),
      ...(await send('ticket:leave', 50)),
      ...(await send('ticket:join', 50)),
    ] as SocketAck[];
    expect(legit.filter((a) => !a.ok && a.error === 'RATE_LIMITED')).toEqual([]);

    // The reviewer's flood: 3000 joins with random ids from one verified client.
    const started = Date.now();
    const acks: SocketAck[] = [];
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i < 3000; i++) {
      socket.emit('ticket:join', { ticketId: randomUUID() }, (a: SocketAck) => acks.push(a));
    }
    // Refused events still cost CPU: after `dropsBeforeDisconnect` of them the socket is closed.
    expect(await closed).toBe('io server disconnect');
    const seconds = (Date.now() - started) / 1000;
    const processed = acks.filter((a) => a.ok || a.error !== 'RATE_LIMITED').length;
    const limited = acks.length - processed;
    const { joinPerSocket, dropsBeforeDisconnect } = DEFAULT_REALTIME_LIMITS;
    // What was left of the burst after the legitimate joins, plus the refill meanwhile.
    expect(processed).toBeLessThanOrEqual(
      joinPerSocket.burst + joinPerSocket.perSecond * seconds + 5,
    );
    expect(limited).toBe(dropsBeforeDisconnect + 1);
    expect(acks.length).toBeLessThan(3000);
  });
});

describe('packets below the event layer and idle connections (re-review RR-SEC-1 / RR-SEC-2)', () => {
  let ctx: TestContext;
  let w: World;
  let wsUrl: string;
  let pollUrl: string;
  let origin: string;
  let raw: WebSocket[] = [];
  /** Closes the polling sessions a test opened. */
  let sessions: Array<() => Promise<unknown>> = [];
  const refusals: string[] = [];

  // Default packet budget; a small pending cap and a short connect timeout.
  const LIMITS = { pendingConnectionsPerIp: 3, connectTimeoutMs: 1500 };

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { realtimeLimits: LIMITS } });
    ctx.app.realtime.io.engine.on('connection_error', (err: { context?: { message?: string } }) => {
      refusals.push(err.context?.message ?? '');
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;
    pollUrl = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
    origin = ctx.config.corsOrigins[0] ?? 'http://localhost:3000';
    w = await createWorld(ctx);
  });
  afterEach(async () => {
    for (const ws of raw) ws.close();
    raw = [];
    // engine.io's close packet ends a polling session that is still open.
    await Promise.all(sessions.map((close) => close()));
    sessions = [];
    refusals.length = 0;
    await expect.poll(() => ctx.app.realtime.io.engine.clientsCount, { timeout: 3000 }).toBe(0);
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A bare engine.io websocket (null when the upgrade was refused). */
  async function open() {
    const ws = new WebSocket(wsUrl, { headers: { origin } } as unknown as string[]);
    raw.push(ws);
    const messages: string[] = [];
    let closed = false;
    ws.addEventListener('close', () => {
      closed = true;
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener('error', () => resolve(false), { once: true });
      ws.addEventListener('message', () => resolve(true), { once: true }); // engine.io's open packet
    });
    if (!opened) return null;
    ws.addEventListener('message', (event) => {
      const data = String(event.data);
      if (data === '2') ws.send('3');
      else messages.push(data);
    });
    return {
      messages,
      send: (packet: string) => ws.send(packet),
      /** Sends a CONNECT with the persona's token and returns the answer. */
      connect: async (persona: Pick<Persona, 'token'>) => {
        ws.send(`40${JSON.stringify({ token: persona.token })}`);
        await expect.poll(() => messages.length).toBeGreaterThan(0);
        return messages.shift() ?? '';
      },
      closedWithin: async (ms: number) => {
        const until = Date.now() + ms;
        while (!closed && Date.now() < until) await sleep(20);
        return closed;
      },
    };
  }

  async function connectedRaw() {
    const c = await open();
    if (!c) throw new Error('the upgrade was refused');
    expect((await c.connect(w.clientX)).startsWith('40')).toBe(true);
    return c;
  }

  /**
   * A bare engine.io polling session driven with plain HTTP, as an attacker would (null when the
   * handshake was refused). No GET is left outstanding unless the test sends one.
   */
  async function polling() {
    const res = await fetch(pollUrl, { headers: { origin } });
    const text = await res.text();
    if (res.status !== 200) return null;
    const { sid } = JSON.parse(text.slice(1)) as { sid: string };
    const url = `${pollUrl}&sid=${sid}`;
    sessions.push(() =>
      fetch(url, { method: 'POST', headers: { origin }, body: '1' }).then((r) => r.text()),
    );
    return {
      /** POSTs engine.io packets (joined with the record separator); the status. */
      post: async (packets: readonly string[]) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { origin, 'content-type': 'text/plain;charset=UTF-8' },
          body: packets.join('\x1e'),
        });
        await r.text();
        return r.status;
      },
      get: async () => {
        const r = await fetch(url, { headers: { origin } });
        return { status: r.status, body: await r.text() };
      },
      /** A websocket upgrade of this session. */
      upgrade: () => {
        const ws = new WebSocket(`${wsUrl}&sid=${sid}`, {
          headers: { origin },
        } as unknown as string[]);
        raw.push(ws);
        return ws;
      },
    };
  }

  async function connectedPolling() {
    const s = await polling();
    if (!s) throw new Error('the handshake was refused');
    expect(await s.post([`40${JSON.stringify({ token: w.clientX.token })}`])).toBe(200);
    expect((await s.get()).body.startsWith('40')).toBe(true);
    return s;
  }

  /** Whether a websocket opens (false: the upgrade was refused). */
  const opened = (ws: WebSocket) =>
    new Promise<boolean>((resolve) => {
      ws.addEventListener('open', () => resolve(true), { once: true });
      ws.addEventListener('error', () => resolve(false), { once: true });
    });
  const closedSocket = (ws: WebSocket) =>
    new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.addEventListener('close', () => resolve(), { once: true });
    });

  it('a stream of acknowledgements closes the connection (they reach no event handler)', async () => {
    const c = await connectedRaw();
    for (let i = 0; i < 5000; i++) c.send(`43${i}[]`);
    expect(await c.closedWithin(5000)).toBe(true);
  });

  it('a stream of engine.io pongs closes the connection', async () => {
    const c = await connectedRaw();
    for (let i = 0; i < 5000; i++) c.send('3');
    expect(await c.closedWithin(5000)).toBe(true);
  });

  it('a CONNECT after the handshake closes the connection, unanswered (any namespace)', async () => {
    const c = await connectedRaw();
    c.send('40/x,');
    expect(await c.closedWithin(3000)).toBe(true);
    expect(c.messages.filter((m) => m.startsWith('44'))).toEqual([]);
  });

  it('a connection within its packet budget stays open', async () => {
    const c = await connectedRaw();
    for (let i = 0; i < 200; i++) c.send(`43${i}[]`);
    for (let i = 0; i < 200; i++) c.send('3');
    expect(await c.closedWithin(1000)).toBe(false);
  });

  it('probe pings on an upgrade websocket are budgeted: a second one closes the session (round-2 verify)', async () => {
    const s = await connectedPolling();
    const ws = s.upgrade();
    let replies = 0;
    ws.addEventListener('message', (event) => {
      if (String(event.data) === '3probe') replies += 1;
    });
    expect(await opened(ws)).toBe(true);
    // engine.io answers every probe itself: 20 000 of them used to get 20 000 answers.
    for (let i = 0; i < 5000; i++) ws.send('2probe');
    await closedSocket(ws);
    expect(replies).toBeLessThanOrEqual(2);
    // The whole session is gone, not only that websocket.
    expect(await s.post(['3'])).toBe(400);
  });

  it('websocket upgrades are limited per session: they skip allowRequest (round-2 verify)', async () => {
    const s = await connectedPolling();
    for (let i = 0; i < DEFAULT_REALTIME_LIMITS.upgradesPerConnection; i++) {
      const ws = s.upgrade();
      expect(await opened(ws)).toBe(true);
      ws.close();
      await closedSocket(ws);
    }
    // One more is refused (400) before the websocket opens, and the session is closed.
    expect(await opened(s.upgrade())).toBe(false);
    expect(await s.post(['3'])).toBe(400);
  });

  it('a polling payload over maxPayloadBytes is refused (413) before it is decoded', async () => {
    const s = await connectedPolling();
    const pongs = Array.from(
      { length: DEFAULT_REALTIME_LIMITS.maxPayloadBytes / 2 + 100 },
      () => '3',
    );
    expect(await s.post(pongs)).toBe(413);
  });

  it('a polling session closed by its packet budget is gone at once: later POSTs get 400', async () => {
    const s = await connectedPolling();
    const pongs = Array.from(
      { length: DEFAULT_REALTIME_LIMITS.packetsPerConnection.burst + 100 },
      () => '3',
    );
    expect(await s.post(pongs)).toBe(200);
    // It used to stay 'closing' for 30 s without a GET, reading and decoding every POST.
    expect(await s.post(['3'])).toBe(400);
  });

  it('a POST to a session that Socket.IO is closing is refused unread (400)', async () => {
    const s = await connectedPolling();
    // disconnect(true) closes the engine.io connection without discarding it: with no GET
    // outstanding it waits for the client to fetch the DISCONNECT (engine.io: up to 30 s).
    ctx.app.realtime.disconnectUser(w.clientX.id);
    await expect.poll(async () => (await ctx.app.realtime.io.fetchSockets()).length).toBe(0);
    expect(ctx.app.realtime.io.engine.clientsCount).toBe(1);
    expect(await s.post(['3'])).toBe(400);
    // The client fetches the DISCONNECT, then the close.
    expect((await s.get()).body).toContain('41');
    await s.get();
  });

  it('a refused handshake over polling is answered when the client polls, then the session is gone', async () => {
    const s = await polling();
    if (!s) throw new Error('the handshake was refused');
    expect(await s.post([`40${JSON.stringify({ token: 'not.a.jwt' })}`])).toBe(200);
    await sleep(300); // refused and written while no GET is outstanding
    const reply = await s.get();
    expect(reply.body).toBe(`44${JSON.stringify({ message: 'UNAUTHENTICATED' })}`);
    await expect.poll(() => ctx.app.realtime.io.engine.clientsCount).toBe(0);
    expect((await s.get()).status).toBe(400);
  });

  it('idle polling sessions: capped per address and gone after connectTimeoutMs (round-2 verify)', async () => {
    const idle = [await polling(), await polling(), await polling()];
    expect(idle.every((s) => s !== null)).toBe(true);
    expect(await polling()).toBeNull();
    expect(refusals).toEqual([TOO_MANY_PENDING]);
    // Closed and discarded at the connect timeout (1.5 s here), not 30 s later: their pending
    // slots are free again.
    const started = Date.now();
    await expect
      .poll(() => ctx.app.realtime.io.engine.clientsCount, { timeout: 4000, interval: 50 })
      .toBe(0);
    expect(Date.now() - started).toBeLessThan(2500);
    const next = await polling();
    expect(next).not.toBeNull();
    for (const s of idle) expect(await s!.post(['3'])).toBe(400);
  });

  it('connections without a handshake: capped per address, closed after connectTimeoutMs', async () => {
    const idle = [await open(), await open(), await open()];
    const [first, second, third] = idle;
    if (!first || !second || !third) throw new Error('the upgrade was refused');
    // A fourth is refused at the upgrade: no engine.io connection at all.
    expect(await open()).toBeNull();
    expect(refusals).toEqual([TOO_MANY_PENDING]);
    // A connection that completes its handshake no longer counts…
    expect((await first.connect(w.clientX)).startsWith('40')).toBe(true);
    const fourth = await open();
    if (!fourth) throw new Error('the upgrade was refused');
    // …and the idle ones are closed after the connect timeout (1.5 s here; 45 s by default).
    const started = Date.now();
    for (const c of [second, third, fourth]) expect(await c.closedWithin(4000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await first.closedWithin(200)).toBe(false);
    // Closed connections free their slots.
    expect(await open()).not.toBeNull();
  });
});

describe('ticket rooms per socket (MAX_TICKET_ROOMS_PER_SOCKET)', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
  let ticketIds: string[] = [];
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    w = await createWorld(ctx);
    // 130 tickets client X (and X2) may see: copies of one created through the API.
    const first = await createTicket(ctx, w.clientX, ticketBody(w));
    const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: first.id } });
    await ctx.prisma.ticket.createMany({
      data: Array.from({ length: 129 }, (_, i) => ({
        type: row.type,
        subject: `${row.subject} ${i}`,
        description: row.description,
        categoryId: row.categoryId,
        subtypeId: row.subtypeId,
        priority: row.priority,
        orgId: row.orgId,
        requesterId: row.requesterId,
        teamId: row.teamId,
      })),
    });
    ticketIds = (
      await ctx.prisma.ticket.findMany({
        where: { orgId: row.orgId },
        select: { id: true },
        orderBy: { number: 'asc' },
      })
    ).map((t) => t.id);
    expect(ticketIds.length).toBeGreaterThanOrEqual(130);
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await ctx.close();
  });

  async function connected(persona: Pick<Persona, 'token'>): Promise<Socket> {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: persona.token },
      extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  const ack = (socket: Socket, event: string, ticketId: string): Promise<SocketAck> =>
    socket.timeout(10_000).emitWithAck(event, { ticketId });

  /** The server side of a client socket. */
  const serverSocket = (socket: Socket) => {
    const found = ctx.app.realtime.io.of('/').sockets.get(socket.id ?? '');
    if (!found) throw new Error('no such socket');
    return found;
  };

  const ticketRooms = (socket: Socket) =>
    [...serverSocket(socket).rooms].filter((r) => /^ticket:[^:]+$/.test(r)).length;

  function tally(acks: SocketAck[]) {
    const out: Record<string, number> = {};
    for (const a of acks) {
      const key = a.ok ? 'ok' : a.error;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  const id = (index: number) => {
    const found = ticketIds[index];
    if (!found) throw new Error(`no ticket ${index}`);
    return found;
  };

  it('joins sent together are counted as they arrive: 120 at once give 50 rooms', async () => {
    const socket = await connected(w.clientX);
    const acks = await Promise.all(
      ticketIds.slice(0, 120).map((ticketId) => ack(socket, 'ticket:join', ticketId)),
    );
    expect(tally(acks)).toEqual({
      ok: MAX_TICKET_ROOMS_PER_SOCKET,
      TOO_MANY_ROOMS: 120 - MAX_TICKET_ROOMS_PER_SOCKET,
    });
    expect(ticketRooms(socket)).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
    expect(socket.connected).toBe(true);
  });

  it('at the cap: leave then join succeeds; join then leave is TOO_MANY_ROOMS (retryable)', async () => {
    const socket = await connected(w.clientX2);
    const held = ticketIds.slice(0, MAX_TICKET_ROOMS_PER_SOCKET);
    expect(
      tally(await Promise.all(held.map((ticketId) => ack(socket, 'ticket:join', ticketId)))),
    ).toEqual({ ok: MAX_TICKET_ROOMS_PER_SOCKET });
    // The list drops a row and shows a new one: leave first, then join (sent back to back).
    const [left, joined] = await Promise.all([
      ack(socket, 'ticket:leave', id(0)),
      ack(socket, 'ticket:join', id(60)),
    ]);
    expect([left, joined]).toEqual([{ ok: true }, { ok: true }]);
    expect(ticketRooms(socket)).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
    // The other order: the join arrives while all 50 slots are taken.
    const [joinFirst, leaveAfter] = await Promise.all([
      ack(socket, 'ticket:join', id(61)),
      ack(socket, 'ticket:leave', id(1)),
    ]);
    expect([joinFirst, leaveAfter]).toEqual([{ ok: false, error: 'TOO_MANY_ROOMS' }, { ok: true }]);
    expect(ticketRooms(socket)).toBe(MAX_TICKET_ROOMS_PER_SOCKET - 1);
    // Retried after the leave, it goes through.
    expect(await ack(socket, 'ticket:join', id(61))).toEqual({ ok: true });
    expect(await ack(socket, 'ticket:join', randomUUID())).toEqual({
      ok: false,
      error: 'TOO_MANY_ROOMS',
    });
    // A room left without a leave (an eviction) gives its slot back, and so does a refused join.
    await serverSocket(socket).leave(rooms.ticket(id(2)));
    expect(await ack(socket, 'ticket:join', randomUUID())).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });
    expect(await ack(socket, 'ticket:join', id(62))).toEqual({ ok: true });
    expect(ticketRooms(socket)).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
  });
});

describe('limits from the config (REALTIME_*) and per-address keys', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await createTestContext({
      config: {
        // One proxy in front: the client address is the last X-Forwarded-For entry.
        trustProxy: 1,
        realtime: {
          socketsPerUser: 1,
          socketsPerIp: 2,
          handshakesPerIp: { burst: 200, perSecond: 20 },
          pendingConnectionsPerIp: 50,
        },
      },
    });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    w = await createWorld(ctx);
  });
  afterEach(async () => {
    for (const s of sockets) s.disconnect();
    sockets.length = 0;
    await expect.poll(async () => (await ctx.app.realtime.io.fetchSockets()).length).toBe(0);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const outcome = (persona: Pick<Persona, 'token'>, forwardedFor: string) =>
    new Promise<Outcome>((resolve) => {
      const socket = connect(url, {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token: persona.token },
        extraHeaders: {
          origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000',
          'x-forwarded-for': forwardedFor,
        },
      });
      sockets.push(socket);
      socket.once('connect', () => resolve({ ok: true }));
      socket.once('connect_error', (err) => resolve({ ok: false, message: err.message }));
    });

  it('REALTIME_SOCKETS_PER_USER applies (1 here)', async () => {
    expect(await outcome(w.clientX, '203.0.113.10')).toEqual({ ok: true });
    expect(await outcome(w.clientX, '203.0.113.11')).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
  });

  it('IPv6 clients are counted by /64, IPv4-mapped ones as IPv4 (REALTIME_SOCKETS_PER_IP 2)', async () => {
    expect(await outcome(w.clientX, '2001:db8:1:2::1')).toEqual({ ok: true });
    expect(await outcome(w.clientX2, '2001:db8:1:2::2')).toEqual({ ok: true });
    // A third address of the same /64 shares their cap…
    expect(await outcome(w.agentA, '2001:db8:1:2:ffff::3')).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
    // …the next /64 doesn't.
    expect(await outcome(w.agentA, '2001:db8:1:3::1')).toEqual({ ok: true });
    // 198.51.100.7 in both notations is one address.
    expect(await outcome(w.agentB, '198.51.100.7')).toEqual({ ok: true });
    expect(await outcome(w.leadA, '::ffff:198.51.100.7')).toEqual({ ok: true });
    expect(await outcome(w.admin, '::ffff:c633:6407')).toEqual({
      ok: false,
      message: 'TOO_MANY_CONNECTIONS',
    });
  });
});
