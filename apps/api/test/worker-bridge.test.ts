import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { notificationNewPayloadSchema, rooms } from '@loons/shared';
import { createInApp } from '../src/jobs/context.ts';
import { createWorkerEventPublisher } from '../src/lib/worker-events.ts';
import { createLogger } from '../src/lib/logger.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import { sleep, testWorkerContext, waitFor } from './worker-helpers.ts';

// Worker → browsers (D14): the worker publishes ids on `<redisPrefix>worker-events`; the API
// re-reads and emits `notification:new` to the user's room and `ticket:updated` / `queue:updated`
// through the usual helpers. With the Socket.IO Redis adapter one instance handles each event
// (an emit reaches every instance anyway); without it every instance emits to its own sockets.
// Either way a browser gets each event once.

interface Received {
  event: string;
  payload: unknown;
}

async function listen(ctx: TestContext): Promise<string> {
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

describe.each([
  { adapter: true, name: 'with the Redis adapter' },
  { adapter: false, name: 'without the Redis adapter' },
])('worker events bridge ($name)', ({ adapter }) => {
  let one: TestContext;
  let two: TestContext;
  let w: World;
  const sockets: Socket[] = [];

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await two?.close();
    await one?.close();
  });

  async function connectAs(url: string, ctx: TestContext, persona: Persona) {
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
    await waitFor(
      async () =>
        (await ctx.app.realtime.io.local.in(rooms.user(persona.id)).fetchSockets()).length > 0,
    );
    return { socket, received };
  }

  it('delivers notification:new once to its user only, and ticket:updated to the ticket room', async () => {
    one = await createTestContext({ config: { socketRedisAdapter: adapter } });
    // A second API instance on the same Redis prefix (same channel, same adapter key).
    two = await createTestContext({
      config: { socketRedisAdapter: adapter, redisPrefix: one.config.redisPrefix },
    });
    w = await createWorld(one);
    const urlOne = await listen(one);
    const urlTwo = await listen(two);
    // Agent A on instance two, agent B on instance one.
    const a = await connectAs(urlTwo, two, w.agentA);
    const b = await connectAs(urlOne, one, w.agentB);

    const t = await createTicket(one, w.clientX, ticketBody(w));
    const worker = testWorkerContext(one);
    await createInApp(worker, [
      {
        userId: w.agentA.id,
        type: 'CLIENT_REPLY',
        ticketId: t.id,
        data: { subject: t.subject as string, priority: 'P3' },
        dedupeKey: `bridge-${t.id}`,
      },
    ]);
    const note = await waitFor(async () => a.received.find((r) => r.event === 'notification:new'));
    const payload = notificationNewPayloadSchema.parse(note.payload);
    expect(payload.notification).toMatchObject({
      type: 'CLIENT_REPLY',
      ticketId: t.id,
      ticketNumber: t.number,
      readAt: null,
    });
    expect(payload.unreadCount).toBe(1);
    await sleep(400);
    expect(a.received.filter((r) => r.event === 'notification:new')).toHaveLength(1);
    expect(b.received.filter((r) => r.event === 'notification:new')).toHaveLength(0);

    // A ticket change made by the worker: agent A watches the ticket (team A).
    const ack = await a.socket.timeout(5000).emitWithAck('ticket:join', { ticketId: t.id });
    expect(ack).toEqual({ ok: true });
    await one.prisma.ticket.update({ where: { id: t.id }, data: { p1EscalationStep: 2 } });
    await createWorkerEventPublisher({
      redis: one.redis,
      redisPrefix: one.config.redisPrefix,
      logger: createLogger(one.config, 'test'),
    })({ kind: 'ticket', ticketId: t.id });
    const updated = await waitFor(async () => a.received.find((r) => r.event === 'ticket:updated'));
    expect(
      (updated.payload as { ticket: { id: string; p1EscalationStep: number } }).ticket,
    ).toMatchObject({
      id: t.id,
      p1EscalationStep: 2,
    });
    await waitFor(async () => a.received.find((r) => r.event === 'queue:updated'));
    await sleep(400);
    expect(a.received.filter((r) => r.event === 'ticket:updated')).toHaveLength(1);
    // Agent B (team B) is not in the ticket room.
    expect(b.received.filter((r) => r.event === 'ticket:updated')).toHaveLength(0);

    // Acknowledging a P1 (API) updates everyone watching it at once.
    const p1 = await createTicket(
      one,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    expect(await a.socket.timeout(5000).emitWithAck('ticket:join', { ticketId: p1.id })).toEqual({
      ok: true,
    });
    const acked = await apiAs(two, w.leadA).post(`/tickets/${p1.id}/acknowledge`);
    expect(acked.statusCode).toBe(200);
    const live = await waitFor(async () =>
      a.received.find(
        (r) =>
          r.event === 'ticket:updated' &&
          (r.payload as { ticket: { id: string } }).ticket.id === p1.id,
      ),
    );
    expect((live.payload as { ticket: { p1AckedBy: unknown } }).ticket.p1AckedBy).toEqual({
      id: w.leadA.id,
      name: 'Lena Lead',
    });

    // Malformed or unknown events are ignored.
    await one.redis.publish(`${one.config.redisPrefix}worker-events`, 'not json');
    await one.redis.publish(
      `${one.config.redisPrefix}worker-events`,
      JSON.stringify({ id: 'x', kind: 'nope' }),
    );
    await sleep(200);
    expect(a.received.filter((r) => r.event === 'notification:new')).toHaveLength(1);
  });
});
