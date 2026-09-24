import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rooms } from '@loons/shared';
import { hashToken } from '../src/lib/tokens.ts';
import { createTestContext, mintToken, type TestContext } from './helpers.ts';

describe('Socket.IO handshake', () => {
  let ctx: TestContext;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await ctx.close();
  });

  function open(auth?: Record<string, unknown>, extra: { origin?: string } = {}): Socket {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout: 5000,
      ...(auth ? { auth } : {}),
      ...(extra.origin ? { extraHeaders: { origin: extra.origin } } : {}),
    });
    sockets.push(socket);
    return socket;
  }

  function outcome(socket: Socket): Promise<{ ok: true } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      socket.once('connect', () => resolve({ ok: true }));
      socket.once('connect_error', (err) => resolve({ ok: false, message: err.message }));
    });
  }

  it('rejects a connection without a token', async () => {
    expect(await outcome(open())).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
  });

  it('rejects a bad token', async () => {
    expect(await outcome(open({ token: 'not.a.jwt' }))).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
    const forged = await mintToken(ctx.config, { sub: crypto.randomUUID() }, { secret: 'y'.repeat(40) });
    expect(await outcome(open({ token: forged }))).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
  });

  it('rejects a disabled user', async () => {
    const { user } = await ctx.fixtures.client({ status: 'DISABLED' });
    const token = await mintToken(ctx.config, { sub: user.id });
    expect(await outcome(open({ token }))).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
  });

  it('rejects a token whose sv differs from the user’s sessionVersion (revoked session)', async () => {
    const { user } = await ctx.fixtures.client();
    const origin = ctx.config.corsOrigins[0] ?? 'http://localhost:3000';
    const oldToken = await mintToken(ctx.config, { sub: user.id, sv: 0 });
    const first = open({ token: oldToken }, { origin });
    expect(await outcome(first)).toEqual({ ok: true }); // also caches the principal
    first.disconnect();

    await ctx.app.services.sessions.revokeUserSessions(user.id);
    expect(await outcome(open({ token: oldToken }, { origin }))).toEqual({ ok: false, message: 'UNAUTHENTICATED' });
    const noSv = await mintToken(ctx.config, { sub: user.id, sv: null });
    expect(await outcome(open({ token: noSv }, { origin }))).toEqual({ ok: false, message: 'UNAUTHENTICATED' });

    const newToken = await mintToken(ctx.config, { sub: user.id, sv: 1 });
    expect(await outcome(open({ token: newToken }, { origin }))).toEqual({ ok: true });
  });

  it('rejects a pending-approval user', async () => {
    const user = await ctx.fixtures.user({ status: 'PENDING_APPROVAL' });
    const token = await mintToken(ctx.config, { sub: user.id });
    expect(await outcome(open({ token }))).toEqual({ ok: false, message: 'FORBIDDEN' });
  });

  it('rejects a client who has not verified their email', async () => {
    const { user } = await ctx.fixtures.client({ emailVerified: false });
    const token = await mintToken(ctx.config, { sub: user.id });
    expect(await outcome(open({ token }))).toEqual({ ok: false, message: 'FORBIDDEN' });
  });

  it('rejects a browser origin that is not allowed', async () => {
    const { user } = await ctx.fixtures.client();
    const token = await mintToken(ctx.config, { sub: user.id });
    const result = await outcome(open({ token }, { origin: 'https://evil.example' }));
    expect(result.ok).toBe(false);
  });

  it('accepts a valid token, joins user:{id} and receives emits for that user', async () => {
    const { user } = await ctx.fixtures.client();
    const token = await mintToken(ctx.config, { sub: user.id });
    const socket = open({ token }, { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' });
    expect(await outcome(socket)).toEqual({ ok: true });

    // Joined asynchronously right after the handshake.
    await expect
      .poll(async () => (await ctx.app.realtime.io.in(rooms.user(user.id)).fetchSockets()).length, { timeout: 3000 })
      .toBe(1);

    const received = new Promise<unknown>((resolve) => socket.once('test:ping', resolve));
    ctx.app.realtime.emitToUser(user.id, 'test:ping', { hello: 'world' });
    expect(await received).toEqual({ hello: 'world' });
  });

  describe('live sockets are closed when the session ends', () => {
    const origin = () => ctx.config.corsOrigins[0] ?? 'http://localhost:3000';

    /** A connected socket of a fresh client, already in its user room. */
    async function connected(options: { expiresIn?: number } = {}) {
      const { user } = await ctx.fixtures.client();
      const token = await mintToken(ctx.config, { sub: user.id }, options);
      const socket = open({ token }, { origin: origin() });
      expect(await outcome(socket)).toEqual({ ok: true });
      await expect
        .poll(async () => (await ctx.app.realtime.io.in(rooms.user(user.id)).fetchSockets()).length, { timeout: 3000 })
        .toBe(1);
      const received: unknown[] = [];
      socket.on('test:event', (payload: unknown) => received.push(payload));
      const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
      return { user, socket, received, disconnected };
    }

    it('revokeUserSessions disconnects the user’s sockets; later events never reach them', async () => {
      const { user, socket, received, disconnected } = await connected();
      await ctx.app.services.sessions.revokeUserSessions(user.id);
      expect(await disconnected).toBe('io server disconnect');
      expect(socket.connected).toBe(false);
      ctx.app.realtime.emitToUser(user.id, 'test:event', { secret: 'after revocation' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
    });

    it('a password reset disconnects the user’s sockets', async () => {
      const { user, disconnected } = await connected();
      const token = 'socket-reset-'.padEnd(43, 's');
      await ctx.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600_000) },
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/internal/auth/password/reset',
        headers: ctx.internalHeaders(),
        payload: { token, password: 'Brand-new-pass-77' },
      });
      expect(res.statusCode).toBe(204);
      expect(await disconnected).toBe('io server disconnect');
    });

    it('the socket is closed when its handshake token expires', async () => {
      const started = Date.now();
      // exp is in whole seconds: 2–3 s from now.
      const { disconnected } = await connected({ expiresIn: 3 });
      expect(await disconnected).toBe('io server disconnect');
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(6000);
    });

    it('other users’ sockets stay connected', async () => {
      const a = await connected();
      const b = await connected();
      await ctx.app.services.sessions.revokeUserSessions(a.user.id);
      await a.disconnected;
      expect(b.socket.connected).toBe(true);
      ctx.app.realtime.emitToUser(b.user.id, 'test:event', 'still here');
      await expect.poll(() => b.received, { timeout: 2000 }).toEqual(['still here']);
    });
  });

  it('closing the app with sockets connected finishes promptly', async () => {
    const other = await createTestContext();
    await other.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = other.app.server.address() as AddressInfo;
    const { user } = await other.fixtures.client();
    const socket = connect(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: await mintToken(other.config, { sub: user.id }) },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    const started = Date.now();
    await other.close();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await disconnected).toBeTruthy();
  });
});
