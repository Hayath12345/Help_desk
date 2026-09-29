import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  listNotificationsQuerySchema,
  markNotificationsReadResponseSchema,
  markNotificationsReadSchema,
  notificationListSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { MINUTE, limitGuard, type LimitRule } from '../lib/rate-limit.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Per-user caps on the notification endpoints (the bell polls only on reconnect). */
export const NOTIFICATION_RATE_LIMITS = {
  list: { max: 120, windowMs: MINUTE },
  read: { max: 120, windowMs: MINUTE },
} as const;

const perUser: LimitRule['key'] = (req) => (req.actor ? `user:${req.actor.id}` : null);

/**
 * The caller's in-app notifications (decision D13). Only ever the caller's own rows: ids of
 * someone else's notifications are ignored, never revealed.
 */
export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];
  const listLimit = limitGuard(
    app,
    [{ name: 'notifications:list:user', ...NOTIFICATION_RATE_LIMITS.list, key: perUser }],
    { onStoreError: 'allow' },
  );
  const readLimit = limitGuard(
    app,
    [{ name: 'notifications:read:user', ...NOTIFICATION_RATE_LIMITS.read, key: perUser }],
    { onStoreError: 'allow' },
  );

  app.get(
    '/me/notifications',
    {
      preHandler: [auth, listLimit],
      schema: {
        tags: ['me'],
        summary: 'The caller’s notifications, newest first (cursor pagination)',
        description:
          '`unreadOnly=true` lists unread ones only. `unreadCount` counts all of the caller’s unread notifications. Pass `nextCursor` back as `cursor` for the next page.',
        security,
        querystring: listNotificationsQuerySchema,
        response: { 200: notificationListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.notifications.list(actorOf(req), req.query),
  );

  app.post(
    '/me/notifications/read',
    {
      preHandler: [auth, readLimit],
      schema: {
        tags: ['me'],
        summary: 'Mark some (`{ids}`) or all (`{all: true}`) of the caller’s notifications read',
        description:
          'Idempotent: already-read notifications keep their `readAt` and are not counted in `updated`. Ids of notifications that are not the caller’s are ignored.',
        security,
        body: markNotificationsReadSchema,
        response: {
          200: markNotificationsReadResponseSchema,
          ...errorResponses(400, 401, 403, 429),
        },
      },
    },
    async (req) => app.services.notifications.markRead(actorOf(req), req.body),
  );
};
