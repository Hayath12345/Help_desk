import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rooms, type SocketAck } from '@loons/shared';
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

// Socket.IO ticket rooms (spec §8): joins authorised on the server, typing routed by role, events
// emitted after the database commit, and the required INTERNAL-NOTE LEAK TEST.

interface Received {
  event: string;
  payload: unknown;
}

describe('realtime ticket rooms', () => {
  let ctx: TestContext;
  let w: World;
  let url: string;
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

  /** A connected socket for `persona` recording every event it receives. */
  async function connectAs(persona: Persona) {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: persona.token },
      extraHeaders: { origin: ctx.config.corsOrigins[0] ?? 'http://localhost:3000' },
    });
    sockets.push(socket);
    const received: Received[] = [];
    socket.onAny((event: string, payload: unknown) => received.push({ event, payload }));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    // The user room is joined right after the handshake (team rooms asynchronously too).
    await expect
      .poll(
        async () => (await ctx.app.realtime.io.in(rooms.user(persona.id)).fetchSockets()).length,
      )
      .toBeGreaterThan(0);
    return { socket, received };
  }

  const ack = (socket: Socket, event: string, payload: unknown): Promise<SocketAck> =>
    socket.timeout(5000).emitWithAck(event, payload);

  const inRoom = async (room: `ticket:${string}` | `team:${string}`, socket: Socket) =>
    (await ctx.app.realtime.io.in(room as never).fetchSockets()).some((s) => s.id === socket.id);

  const events = (received: Received[], name: string) =>
    received.filter((r) => r.event === name).map((r) => r.payload as Record<string, unknown>);

  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

  it('on connect: staff join their team rooms (super admins: every active team)', async () => {
    const agent = await connectAs(w.agentA);
    const admin = await connectAs(w.admin);
    const client = await connectAs(w.clientX);
    await expect.poll(() => inRoom(rooms.team(w.teamA.id), agent.socket)).toBe(true);
    expect(await inRoom(rooms.team(w.teamB.id), agent.socket)).toBe(false);
    await expect.poll(() => inRoom(rooms.team(w.teamB.id), admin.socket)).toBe(true);
    expect(await inRoom(rooms.team(w.teamA.id), admin.socket)).toBe(true);
    expect(await inRoom(rooms.team(w.inactiveTeam.id), admin.socket)).toBe(false);
    expect(
      [...(await ctx.app.realtime.io.in(rooms.team(w.teamA.id)).fetchSockets())].map((s) => s.id),
    ).not.toContain(client.socket.id);
  });

  describe('ticket:join / ticket:leave', () => {
    it('viewers join ticket:{id}; only staff also join ticket:{id}:staff; others NOT_FOUND', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX2); // same organisation
      const agent = await connectAs(w.agentA);
      const outsider = await connectAs(w.clientY);
      const otherTeam = await connectAs(w.agentB);

      expect(await ack(client.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      expect(await inRoom(rooms.ticket(t.id), client.socket)).toBe(true);
      expect(await inRoom(rooms.ticketStaff(t.id), client.socket)).toBe(false);

      expect(await ack(agent.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      expect(await inRoom(rooms.ticket(t.id), agent.socket)).toBe(true);
      expect(await inRoom(rooms.ticketStaff(t.id), agent.socket)).toBe(true);

      for (const s of [outsider, otherTeam]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({
          ok: false,
          error: 'NOT_FOUND',
        });
        expect(await inRoom(rooms.ticket(t.id), s.socket)).toBe(false);
      }
      expect(await ack(agent.socket, 'ticket:join', { ticketId: randomUUID() })).toEqual({
        ok: false,
        error: 'NOT_FOUND',
      });

      expect(await ack(agent.socket, 'ticket:leave', { ticketId: t.id })).toEqual({ ok: true });
      expect(await inRoom(rooms.ticket(t.id), agent.socket)).toBe(false);
      expect(await inRoom(rooms.ticketStaff(t.id), agent.socket)).toBe(false);
    });

    it('invalid payloads → VALIDATION_FAILED (and a missing ack never crashes the server)', async () => {
      const { socket } = await connectAs(w.agentA);
      for (const payload of [null, {}, { ticketId: 'LG-1' }, 'x', { ticketId: 42 }]) {
        expect(await ack(socket, 'ticket:join', payload)).toEqual({
          ok: false,
          error: 'VALIDATION_FAILED',
        });
      }
      socket.emit('ticket:join', { ticketId: randomUUID() }); // no ack callback
      socket.emit('message:typing', 'garbage');
      expect(await ack(socket, 'ticket:leave', { ticketId: 'nope' })).toEqual({
        ok: false,
        error: 'VALIDATION_FAILED',
      });
      expect(socket.connected).toBe(true);
    });

    it('joins use the current permissions (removed from the team → NOT_FOUND)', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      await ctx.fixtures.member(w.teamA.id, user.id);
      const { socket } = await connectAs(await persona(ctx, user));
      await ctx.prisma.teamMember.delete({
        where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
      });
      await ctx.app.principals.invalidate(user.id);
      expect(await ack(socket, 'ticket:join', { ticketId: t.id })).toEqual({
        ok: false,
        error: 'NOT_FOUND',
      });
    });

    it('join and leave of a ticket are applied in the order they were sent (review F5)', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX2);
      const agent = await connectAs(w.agentA);
      /** Emits both in the same tick; resolves with the acks in the order they arrived. */
      const both = async (socket: Socket, first: string, second: string) => {
        const order: string[] = [];
        const send = (event: string) =>
          ack(socket, event, { ticketId: t.id }).then((res) => {
            order.push(event);
            return res;
          });
        const acks = await Promise.all([send(first), send(second)]);
        return { acks, order };
      };

      for (const { socket } of [client, agent]) {
        // Join then leave (the join awaits the database; the leave must not overtake it).
        expect(await both(socket, 'ticket:join', 'ticket:leave')).toEqual({
          acks: [{ ok: true }, { ok: true }],
          order: ['ticket:join', 'ticket:leave'],
        });
        expect(await inRoom(rooms.ticket(t.id), socket)).toBe(false);
        expect(await inRoom(rooms.ticketStaff(t.id), socket)).toBe(false);
      }

      // Nothing reaches a socket that left, even though its join finished last on the server.
      const res = await postMessage(ctx, w.agentA, t.id, { body: 'Looking into it.' });
      expect(res.statusCode).toBe(201);
      await settle();
      for (const { received } of [client, agent]) {
        expect(events(received, 'message:new')).toEqual([]);
        expect(events(received, 'ticket:updated')).toEqual([]);
      }

      // Leave then join (a re-mount) ends in the room.
      expect(await both(client.socket, 'ticket:leave', 'ticket:join')).toEqual({
        acks: [{ ok: true }, { ok: true }],
        order: ['ticket:leave', 'ticket:join'],
      });
      expect(await inRoom(rooms.ticket(t.id), client.socket)).toBe(true);
    });
  });

  describe('access changes (review SEC-RT-2)', () => {
    async function teamAMember(name: string) {
      const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, name });
      await ctx.fixtures.member(w.teamA.id, user.id);
      return { user, persona: await persona(ctx, user) };
    }

    it('removed from the team: the principal invalidation evicts the socket at once', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const { user, persona: removedPersona } = await teamAMember('Remy Removed');
      const removed = await connectAs(removedPersona);
      const lead = await connectAs(w.leadA);
      for (const s of [removed, lead]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      }
      await expect.poll(() => inRoom(rooms.team(w.teamA.id), removed.socket)).toBe(true);

      // What a Phase 4 member edit does: change the membership, invalidate the principal.
      await ctx.prisma.teamMember.delete({
        where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
      });
      await ctx.app.principals.invalidate(user.id);
      expect(await inRoom(rooms.ticket(t.id), removed.socket)).toBe(false);
      expect(await inRoom(rooms.ticketStaff(t.id), removed.socket)).toBe(false);
      expect(await inRoom(rooms.team(w.teamA.id), removed.socket)).toBe(false);
      expect(removed.socket.connected).toBe(true); // still a valid user

      const secret = `AFTER-REMOVAL-${rand(6)}`;
      await postMessage(ctx, w.agentA, t.id, { type: 'INTERNAL', body: secret });
      const other = await createTicket(ctx, w.clientX, ticketBody(w));
      await expect.poll(() => JSON.stringify(lead.received)).toContain(secret);
      await expect
        .poll(() => events(lead.received, 'queue:updated').some((e) => e.ticketId === other.id))
        .toBe(true);
      expect(JSON.stringify(removed.received)).not.toContain(secret);
      expect(events(removed.received, 'queue:updated').some((e) => e.ticketId === other.id)).toBe(
        false,
      );
      expect(
        await ack(removed.socket, 'message:typing', {
          ticketId: t.id,
          isTyping: true,
          scope: 'internal',
        }),
      ).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('a ticket update re-checks members with their current permissions, not the socket’s', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const { user, persona: stalePersona } = await teamAMember('Stan Stale');
      const stale = await connectAs(stalePersona);
      expect(await ack(stale.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      // The membership goes away without a refresh (e.g. a direct database edit): only the
      // principal cache entry expires.
      await ctx.prisma.teamMember.delete({
        where: { teamId_userId: { teamId: w.teamA.id, userId: user.id } },
      });
      await ctx.redis.del(`${ctx.config.redisPrefix}principal:${user.id}`);
      const res = await apiAs(ctx, w.agentA).patch(`/tickets/${t.id}`, { priority: 'P2' });
      expect(res.statusCode).toBe(200);
      expect(await inRoom(rooms.ticket(t.id), stale.socket)).toBe(false);
      expect(await inRoom(rooms.ticketStaff(t.id), stale.socket)).toBe(false);
      const secret = `STALE-${rand(6)}`;
      await postMessage(ctx, w.agentA, t.id, { type: 'INTERNAL', body: secret });
      await settle();
      expect(JSON.stringify(stale.received)).not.toContain(secret);
      expect(events(stale.received, 'ticket:updated')).toEqual([]);
    });

    it('a disabled user’s sockets are closed; a user added to a team joins its room', async () => {
      const { user, persona: gone } = await teamAMember('Dana Disabled');
      const disabled = await connectAs(gone);
      await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
      await ctx.app.principals.invalidate(user.id);
      await expect.poll(() => disabled.socket.connected).toBe(false);

      const joiner = await ctx.fixtures.staff({
        staffDomain: ctx.config.staffEmailDomain,
        name: 'Nina New',
      });
      const added = await connectAs(await persona(ctx, joiner));
      expect(await inRoom(rooms.team(w.teamA.id), added.socket)).toBe(false);
      await ctx.fixtures.member(w.teamA.id, joiner.id);
      await ctx.app.realtime.refreshUser(joiner.id);
      expect(await inRoom(rooms.team(w.teamA.id), added.socket)).toBe(true);
    });
  });

  describe('message:typing', () => {
    it('client typing reaches the ticket room (not the sender); internal scope is refused', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX);
      const colleague = await connectAs(w.clientX2);
      const agent = await connectAs(w.agentA);
      for (const s of [client, colleague, agent]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      }
      expect(
        await ack(client.socket, 'message:typing', {
          ticketId: t.id,
          isTyping: true,
          scope: 'public',
        }),
      ).toEqual({ ok: true });
      const expected = {
        ticketId: t.id,
        user: { id: w.clientX.id, name: w.clientX.name },
        isTyping: true,
        scope: 'public',
      };
      await expect.poll(() => events(agent.received, 'message:typing')).toEqual([expected]);
      await expect.poll(() => events(colleague.received, 'message:typing')).toEqual([expected]);
      expect(events(client.received, 'message:typing')).toEqual([]);
      expect(
        await ack(client.socket, 'message:typing', {
          ticketId: t.id,
          isTyping: true,
          scope: 'internal',
        }),
      ).toEqual({ ok: false, error: 'FORBIDDEN' });
    });

    it('staff typing (either scope) reaches other staff only — never the client', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX);
      const agent = await connectAs(w.agentA);
      const lead = await connectAs(w.leadA);
      for (const s of [client, agent, lead]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      }
      for (const scope of ['public', 'internal'] as const) {
        expect(
          await ack(agent.socket, 'message:typing', { ticketId: t.id, isTyping: true, scope }),
        ).toEqual({ ok: true });
        await settle(1100); // past the per-ticket throttle
      }
      await expect
        .poll(() => events(lead.received, 'message:typing').map((e) => e.scope))
        .toEqual(['public', 'internal']);
      await settle();
      expect(events(client.received, 'message:typing')).toEqual([]);
      expect(events(agent.received, 'message:typing')).toEqual([]);
    });

    it('typing needs a joined room; bursts are throttled per socket', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX);
      const agent = await connectAs(w.agentA);
      expect(
        await ack(client.socket, 'message:typing', {
          ticketId: t.id,
          isTyping: true,
          scope: 'public',
        }),
      ).toEqual({ ok: false, error: 'NOT_FOUND' });
      await ack(client.socket, 'ticket:join', { ticketId: t.id });
      await ack(agent.socket, 'ticket:join', { ticketId: t.id });
      const acks: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        acks.push(
          await ack(client.socket, 'message:typing', {
            ticketId: t.id,
            isTyping: true,
            scope: 'public',
          }),
        );
      }
      // The first one goes out; the dropped ones say so.
      expect(acks[0]).toEqual({ ok: true });
      expect(acks.at(-1)).toEqual({ ok: false, error: 'RATE_LIMITED' });
      await ack(client.socket, 'message:typing', {
        ticketId: t.id,
        isTyping: false,
        scope: 'public',
      });
      await settle();
      expect(events(agent.received, 'message:typing').map((e) => e.isTyping)).toEqual([
        true,
        false,
      ]);
    });
  });

  describe('events after commit', () => {
    it('a reply: message:new + ticket:updated to the ticket room, queue:updated to the team', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX);
      const agent = await connectAs(w.agentA);
      const otherTeam = await connectAs(w.agentB);
      await ack(client.socket, 'ticket:join', { ticketId: t.id });
      await ack(agent.socket, 'ticket:join', { ticketId: t.id });

      // The message is already in the database when its event arrives.
      const seenInDb = new Promise<boolean>((resolve) => {
        agent.socket.once('message:new', (payload: { message: { id: string } }) => {
          void ctx.prisma.message
            .findUnique({ where: { id: payload.message.id } })
            .then((m) => resolve(m !== null));
        });
      });
      const clientTempId = randomUUID();
      const res = await postMessage(ctx, w.agentA, t.id, { body: 'On our way.', clientTempId });
      expect(res.statusCode).toBe(201);
      expect(await seenInDb).toBe(true);

      await expect.poll(() => events(client.received, 'message:new').length).toBe(1);
      const [msg] = events(client.received, 'message:new');
      expect(msg).toEqual({ ticketId: t.id, message: res.json().message });
      expect((msg?.message as { clientTempId: string }).clientTempId).toBe(clientTempId);
      await expect.poll(() => events(client.received, 'ticket:updated').length).toBe(1);
      expect(events(client.received, 'ticket:updated')[0]).toEqual({ ticket: res.json().ticket });
      await expect
        .poll(() => events(agent.received, 'queue:updated'))
        .toContainEqual({ teamId: w.teamA.id, ticketId: t.id, reason: 'message' });
      await settle();
      expect(events(client.received, 'queue:updated')).toEqual([]);
      expect(
        events(otherTeam.received, 'queue:updated').filter((e) => e.ticketId === t.id),
      ).toEqual([]);
    });

    it('a new ticket: queue:updated (created) to its team', async () => {
      const agent = await connectAs(w.agentA);
      await expect.poll(() => inRoom(rooms.team(w.teamA.id), agent.socket)).toBe(true);
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      await expect
        .poll(() => events(agent.received, 'queue:updated'))
        .toContainEqual({ teamId: w.teamA.id, ticketId: t.id, reason: 'created' });
    });

    it('a failed write emits nothing', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const agent = await connectAs(w.agentA);
      await ack(agent.socket, 'ticket:join', { ticketId: t.id });
      await ctx.prisma.ticket.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
      expect((await postMessage(ctx, w.clientX, t.id, { body: 'hello?' })).statusCode).toBe(409);
      expect(
        (await apiAs(ctx, w.agentA).patch(`/tickets/${t.id}`, { priority: 'P1' })).statusCode,
      ).toBe(409);
      await settle();
      expect(
        agent.received.filter(
          (r) =>
            r.event !== 'queue:updated' || (r.payload as { ticketId: string }).ticketId === t.id,
        ),
      ).toEqual([]);
    });

    it('re-routing evicts staff who can no longer see the ticket from its rooms', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const agent = await connectAs(w.agentA); // team A, not assigned
      const lead = await connectAs(w.admin);
      const client = await connectAs(w.clientX);
      for (const s of [agent, lead, client]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      }
      const res = await apiAs(ctx, w.admin).patch(`/tickets/${t.id}`, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      });
      expect(res.statusCode).toBe(200);
      expect(await inRoom(rooms.ticket(t.id), agent.socket)).toBe(false);
      expect(await inRoom(rooms.ticketStaff(t.id), agent.socket)).toBe(false);
      expect(await inRoom(rooms.ticketStaff(t.id), lead.socket)).toBe(true);
      expect(await inRoom(rooms.ticket(t.id), client.socket)).toBe(true);

      const secret = `REROUTED-${rand(6)}`;
      await postMessage(ctx, w.agentB, t.id, { type: 'INTERNAL', body: secret });
      await expect.poll(() => JSON.stringify(lead.received)).toContain(secret);
      expect(JSON.stringify(agent.received)).not.toContain(secret);
      expect(events(agent.received, 'ticket:updated')).toEqual([]);
      // Rejoining is refused now.
      expect(await ack(agent.socket, 'ticket:join', { ticketId: t.id })).toEqual({
        ok: false,
        error: 'NOT_FOUND',
      });
    });
  });

  describe('INTERNAL-NOTE LEAK TEST', () => {
    it('a client never receives an internal note, staff typing or any note content (sockets + HTTP)', async () => {
      const secret = `SECRET-NOTE-${rand(8)}`;
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const client = await connectAs(w.clientX);
      const colleague = await connectAs(w.clientX2);
      const agent = await connectAs(w.agentA);
      const lead = await connectAs(w.leadA);
      for (const s of [client, colleague, agent, lead]) {
        expect(await ack(s.socket, 'ticket:join', { ticketId: t.id })).toEqual({ ok: true });
      }
      expect(await inRoom(rooms.ticketStaff(t.id), client.socket)).toBe(false);

      // Staff type a note (and a reply), then add notes — one that moves NEW → OPEN — with a file.
      await ack(agent.socket, 'message:typing', {
        ticketId: t.id,
        isTyping: true,
        scope: 'internal',
      });
      await ack(lead.socket, 'message:typing', { ticketId: t.id, isTyping: true, scope: 'public' });
      const file = await ctx.prisma.attachment.create({
        data: {
          uploaderId: w.agentA.id,
          storageKey: `test/${randomUUID()}/${secret}.txt`,
          fileName: `${secret}.txt`,
          mimeType: 'text/plain',
          sizeBytes: 5,
          status: 'CLEAN',
        },
      });
      const note = await postMessage(ctx, w.agentA, t.id, {
        type: 'INTERNAL',
        body: `${secret} — client is on a legacy firmware`,
        attachmentIds: [file.id],
      });
      expect(note.statusCode).toBe(201);
      expect(note.json().ticket.status).toBe('OPEN');
      const note2 = await postMessage(ctx, w.leadA, t.id, {
        type: 'INTERNAL',
        body: `${secret} #2`,
      });
      expect(note2.statusCode).toBe(201);
      // Sentinel: a public reply after the notes (events reach each socket in order).
      const sentinel = await postMessage(ctx, w.agentA, t.id, { body: 'Public update for you.' });
      expect(sentinel.statusCode).toBe(201);

      for (const c of [client, colleague]) {
        await expect
          .poll(() =>
            events(c.received, 'message:new').some(
              (e) => (e.message as { id: string }).id === sentinel.json().message.id,
            ),
          )
          .toBe(true);
        const all = JSON.stringify(c.received);
        expect(all).not.toContain(secret);
        expect(all).not.toContain(note.json().message.id);
        expect(all).not.toContain(file.id);
        expect(
          events(c.received, 'message:new').map((e) => (e.message as { type: string }).type),
        ).toEqual(['PUBLIC']);
        expect(events(c.received, 'message:typing')).toEqual([]);
        // The status change the note caused is visible, its content is not.
        expect(events(c.received, 'ticket:updated').length).toBeGreaterThan(0);
      }
      // Staff did receive the notes (so the test would catch a routing mistake).
      await expect
        .poll(
          () =>
            events(lead.received, 'message:new').filter(
              (e) => (e.message as { type: string }).type === 'INTERNAL',
            ).length,
        )
        .toBe(2);
      expect(JSON.stringify(lead.received)).toContain(secret);
      expect(events(lead.received, 'message:typing').map((e) => e.scope)).toContain('internal');

      // HTTP: messages, detail (preview, attachments), list and a replay attempt.
      const http = apiAs(ctx, w.clientX);
      for (const res of [
        await http.get(`/tickets/${t.id}/messages`),
        await http.get(`/tickets/${t.id}`),
        await http.get(`/tickets/${t.ref}`),
        await http.get(`/tickets?limit=100`),
        await apiAs(ctx, w.clientX2).get(
          `/tickets?scope=org&limit=100&search=${encodeURIComponent(String(t.subject))}`,
        ),
        await http.get(`/attachments/${file.id}/download`),
      ]) {
        expect(res.body).not.toContain(secret);
      }
      const messages = (await http.get(`/tickets/${t.id}/messages`)).json().items;
      expect(messages.every((m: { type: string }) => m.type === 'PUBLIC')).toBe(true);
      const detail = (await http.get(`/tickets/${t.id}`)).json().ticket;
      expect(detail.preview).toBe('Public update for you.');
      expect(detail.attachments).toEqual([]);
      expect((await http.get(`/attachments/${file.id}/download`)).statusCode).toBe(404);
      // Staff still see everything.
      expect((await apiAs(ctx, w.agentA2).get(`/tickets/${t.id}/messages`)).body).toContain(secret);
    });
  });
});
