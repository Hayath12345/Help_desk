import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { SERVER_EVENTS } from '@loons/shared';
import { closeRedis, withTimeout } from '../lib/redis.ts';
import { workerEventSchema, workerEventsChannel, type WorkerEvent } from '../lib/worker-events.ts';

// Worker → browsers (decision D14). Every API instance subscribes to `<redisPrefix>worker-events`
// and turns each event into the usual emits, re-reading the ticket / notification first, so the
// eviction rules of `ticketUpdated` stay in one place and nothing the worker sent is trusted as
// content.
//
// With the Socket.IO Redis adapter an emit from one instance already reaches every instance, so
// exactly one instance handles each event (a SET NX claim on the event id); without the adapter
// each instance only reaches its own sockets, so every instance handles every event.

const CLAIM_TTL_MS = 60_000;
const SUBSCRIBE_TIMEOUT_MS = 5_000;

export interface WorkerBridge {
  /** Handles one event (exposed for tests). */
  handle(event: WorkerEvent): Promise<void>;
}

export function attachWorkerBridge(app: FastifyInstance): WorkerBridge {
  const { config } = app;
  const channel = workerEventsChannel(config.redisPrefix);
  let subscriber: Redis | null = null;

  async function claim(id: string): Promise<boolean> {
    if (!config.socketRedisAdapter) return true;
    const key = `${config.redisPrefix}worker-events:claim:${id}`;
    try {
      return (await app.redis.set(key, '1', 'PX', CLAIM_TTL_MS, 'NX')) === 'OK';
    } catch (err) {
      // Better a duplicate emit than a lost one.
      app.log.warn({ err }, 'could not claim a worker event; emitting anyway');
      return true;
    }
  }

  async function handle(event: WorkerEvent): Promise<void> {
    if (!(await claim(event.id))) return;
    if (event.kind === 'ticket') {
      let summary;
      try {
        summary = await app.services.tickets.summary(event.ticketId);
      } catch {
        return; // deleted since
      }
      await app.realtime.tickets.ticketUpdated(summary);
      app.realtime.tickets.queueUpdated([summary.team.id], summary.id, 'updated');
      return;
    }
    const found = await app.services.notifications.newPayload(event.notificationId);
    if (!found || found.userId !== event.userId) return;
    app.realtime.emitToUser(found.userId, SERVER_EVENTS.notificationNew, found.payload);
  }

  function onMessage(from: string, raw: string): void {
    if (from !== channel) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = workerEventSchema.safeParse(parsed);
    if (!event.success) {
      app.log.warn('ignored a malformed worker event');
      return;
    }
    handle(event.data).catch((err: unknown) => {
      app.log.error({ err, kind: event.data.kind }, 'could not forward a worker event');
    });
  }

  app.addHook('onReady', async () => {
    let sub: Redis;
    try {
      sub = app.redis.duplicate({ connectionName: 'loons-worker-events' });
    } catch (err) {
      app.log.warn(
        { err },
        'no worker-events subscription: worker changes arrive on the next refresh',
      );
      return;
    }
    sub.on('error', () => undefined); // the main client already logs connection problems
    sub.on('message', onMessage);
    subscriber = sub;
    try {
      // ioredis re-subscribes by itself after a reconnect.
      await withTimeout(sub.subscribe(channel), SUBSCRIBE_TIMEOUT_MS, 'worker events subscribe');
    } catch (err) {
      app.log.warn({ err }, 'could not subscribe to worker events yet; live updates may lag');
    }
  });
  app.addHook('onClose', async () => {
    if (subscriber) await closeRedis(subscriber);
  });

  return { handle };
}
