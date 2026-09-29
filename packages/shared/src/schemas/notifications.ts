// Phase 3 in-app notifications (decision D13): stored as `type` + `data` and rendered in the
// viewer's language by the web. Staff only in Phase 3 (the console bell); clients keep email and
// the live thread. Endpoints: GET /me/notifications, POST /me/notifications/read; live updates
// arrive as `notification:new` on the user's own room (see realtime.ts).

import { z } from 'zod';
import { NOTIFICATION_TYPES, PRIORITIES, SLA_TARGETS, TICKET_STATUSES } from '../enums.ts';
import { userRefSchema } from './tickets.ts';

const isoDate = z.iso.datetime({ offset: true });

/** Page size limits of GET /me/notifications. */
export const NOTIFICATION_LIMITS = {
  pageDefault: 20,
  pageMax: 50,
  /** Ids per POST /me/notifications/read. */
  markReadMax: 100,
} as const;

/**
 * What the web needs to render a notification without another request. Every field is optional
 * (which ones are set depends on `type`); unknown keys are kept so producers can add fields
 * without breaking older clients.
 * - `subject`, `priority`: the ticket at the time of the event (all ticket types).
 * - `target`, `dueAt`: SLA_AT_RISK / SLA_BREACHED — which target and its due date.
 * - `step`: P1_ESCALATED — the escalation step that fired (1-based).
 * - `actor`: who caused it (CLIENT_REPLY / AGENT_REPLY author, P1_ACKNOWLEDGED acknowledger,
 *   TICKET_ASSIGNED assigner); absent for system events.
 * - `status`: STATUS_CHANGED — the new status.
 */
export const notificationDataSchema = z.looseObject({
  subject: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  target: z.enum(SLA_TARGETS).optional(),
  dueAt: isoDate.optional(),
  step: z.number().int().positive().optional(),
  actor: userRefSchema.optional(),
  status: z.enum(TICKET_STATUSES).optional(),
});
export type NotificationData = z.infer<typeof notificationDataSchema>;

export const notificationDtoSchema = z.object({
  id: z.uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  ticketId: z.uuid().nullable(),
  /** The ticket's number (rendered "LG-n" with formatTicketNumber); null without a ticket. */
  ticketNumber: z.number().int().nullable(),
  data: notificationDataSchema,
  readAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

/**
 * GET /me/notifications — the caller's own notifications, newest first (createdAt, id),
 * keyset-paginated with an opaque `cursor`. `unreadOnly=true` lists unread ones only.
 */
export const listNotificationsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  unreadOnly: z.stringbool().optional().default(false),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATION_LIMITS.pageMax)
    .optional()
    .default(NOTIFICATION_LIMITS.pageDefault),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationDtoSchema),
  nextCursor: z.string().nullable(),
  /** All of the caller's unread notifications (not only this page). */
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

/**
 * POST /me/notifications/read — mark some (`{ids}`, the caller's own; others are ignored) or all
 * (`{all: true}`) as read. Idempotent: already-read notifications keep their `readAt`.
 */
export const markNotificationsReadSchema = z.union([
  z.strictObject({
    ids: z.array(z.uuid()).min(1).max(NOTIFICATION_LIMITS.markReadMax),
  }),
  z.strictObject({
    all: z.literal(true),
    /**
     * Watermark: only notifications created at or before this instant (the newest one the client
     * has shown). Without it every unread notification is marked, including one that arrived a
     * moment ago and was never seen.
     */
    upTo: z.iso.datetime({ offset: true }).optional(),
  }),
]);
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const markNotificationsReadResponseSchema = z.object({
  /** Notifications that changed from unread to read. */
  updated: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});
export type MarkNotificationsReadResponse = z.infer<typeof markNotificationsReadResponseSchema>;

/** `notification:new` on `user:{id}`: the new notification and the recipient's unread count. */
export const notificationNewPayloadSchema = z.object({
  notification: notificationDtoSchema,
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationNewPayload = z.infer<typeof notificationNewPayloadSchema>;
