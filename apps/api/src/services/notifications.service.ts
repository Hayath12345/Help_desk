import { z } from 'zod';
import type { Prisma, PrismaClient } from '@loons/db';
import {
  notificationDataSchema,
  type Actor,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
  type MarkNotificationsReadResponse,
  type NotificationDto,
  type NotificationList,
  type NotificationNewPayload,
} from '@loons/shared';
import { errors } from '../lib/errors.ts';
import { CURSOR_EPOCH_MS } from './ticket-query.ts';

// In-app notifications (decision D13): the caller's own only, newest first, keyset-paginated;
// marking read is idempotent. The worker creates them (with a dedupe key per event × recipient)
// and the API pushes `notification:new` through the worker-events bridge.

export interface NotificationsService {
  list(actor: Actor, query: ListNotificationsQuery): Promise<NotificationList>;
  markRead(actor: Actor, input: MarkNotificationsReadInput): Promise<MarkNotificationsReadResponse>;
  unreadCount(userId: string): Promise<number>;
  /** The `notification:new` payload for a stored notification (null when it is gone). */
  newPayload(
    notificationId: string,
  ): Promise<{ userId: string; payload: NotificationNewPayload } | null>;
}

const notificationSelect = {
  id: true,
  userId: true,
  type: true,
  ticketId: true,
  data: true,
  readAt: true,
  createdAt: true,
  ticket: { select: { number: true } },
} as const satisfies Prisma.NotificationSelect;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

export function toNotificationDto(row: NotificationRow): NotificationDto {
  const data = notificationDataSchema.safeParse(row.data ?? {});
  return {
    id: row.id,
    type: row.type,
    ticketId: row.ticketId,
    ticketNumber: row.ticket?.number ?? null,
    data: data.success ? data.data : {},
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const cursorSchema = z.object({
  t: z.number().int().min(CURSOR_EPOCH_MS.min).max(CURSOR_EPOCH_MS.max),
  id: z.uuid(),
});

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.getTime(), id: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { t: number; id: string } {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw errors.validation([
      { location: 'querystring', path: ['cursor'], message: 'validation.invalid', code: 'cursor' },
    ]);
  }
}

export function createNotificationsService(deps: { prisma: PrismaClient }): NotificationsService {
  const { prisma } = deps;

  const unreadCount = (userId: string) =>
    prisma.notification.count({ where: { userId, readAt: null } });

  return {
    unreadCount,

    async list(actor, query) {
      const where: Prisma.NotificationWhereInput = {
        userId: actor.id,
        ...(query.unreadOnly ? { readAt: null } : {}),
      };
      if (query.cursor) {
        const { t, id } = decodeCursor(query.cursor);
        const at = new Date(t);
        where.OR = [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }];
      }
      const [rows, unread] = await Promise.all([
        prisma.notification.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
          select: notificationSelect,
        }),
        unreadCount(actor.id),
      ]);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toNotificationDto),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
        unreadCount: unread,
      };
    },

    async markRead(actor, input) {
      const now = new Date();
      const result = await prisma.notification.updateMany({
        where: {
          userId: actor.id,
          readAt: null,
          ...('ids' in input ? { id: { in: [...new Set(input.ids)] } } : {}),
          ...('all' in input && input.upTo ? { createdAt: { lte: new Date(input.upTo) } } : {}),
        },
        data: { readAt: now },
      });
      return { updated: result.count, unreadCount: await unreadCount(actor.id) };
    },

    async newPayload(notificationId) {
      const row = await prisma.notification.findUnique({
        where: { id: notificationId },
        select: notificationSelect,
      });
      if (!row) return null;
      return {
        userId: row.userId,
        payload: {
          notification: toNotificationDto(row),
          unreadCount: await unreadCount(row.userId),
        },
      };
    },
  };
}
