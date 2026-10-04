// Socket.IO contract (spec §8). The server persists first, then broadcasts; clients reconcile
// optimistic messages by `clientTempId` and, after a reconnect, fetch messages after the last id
// they know.
//
// Rooms (see `rooms` in permissions.ts):
//   ticket:{id}        client + staff viewers of a ticket — PUBLIC/SYSTEM messages, ticket updates,
//                      typing by the CLIENT side
//   ticket:{id}:staff  staff viewers only — INTERNAL notes and typing by STAFF (clients never see
//                      staff typing, so a note being written is never revealed)
//   team:{id}          staff of the team — queue changes (staff auto-join their teams on connect;
//                      super admins join every active team)
//   user:{id}          one user — personal events (notification:new)

import { z } from 'zod';
import type { NotificationNewPayload } from './schemas/notifications.ts';
import type { MessageDto, TicketSummaryDto } from './schemas/tickets.ts';

/** Server → client event names. */
export const SERVER_EVENTS = {
  messageNew: 'message:new',
  messageTyping: 'message:typing',
  ticketUpdated: 'ticket:updated',
  queueUpdated: 'queue:updated',
  notificationNew: 'notification:new',
  configUpdated: 'config:updated',
} as const;

/** Client → server event names (all use an acknowledgement callback). */
export const CLIENT_EVENTS = {
  ticketJoin: 'ticket:join',
  ticketLeave: 'ticket:leave',
  typing: 'message:typing',
} as const;

export interface MessageNewPayload {
  ticketId: string;
  message: MessageDto;
}

export interface TypingPayload {
  ticketId: string;
  user: { id: string; name: string };
  isTyping: boolean;
  /** 'internal' only ever reaches ticket:{id}:staff. */
  scope: 'public' | 'internal';
}

export interface TicketUpdatedPayload {
  ticket: TicketSummaryDto;
}

export interface QueueUpdatedPayload {
  teamId: string;
  ticketId: string;
  reason: 'created' | 'updated' | 'message';
}

/**
 * What an admin change touched (Phase 4, decision E18). The web maps each scope to the queries it
 * must refetch:
 *   ticket-form     categories, sub-types, custom fields, SLA policies, security category → the
 *                   New Ticket form config (and ticket details, which embed labels)
 *   form-context    organisations and sites → form contexts, requester search, ticket details
 *   macros          macros → the console macro list
 *   teams           teams, members, on-call → teams list, form config (team names), ticket details
 *   escalation      escalation rules → ticket details (`p1Chain`)
 *   calendar        business hours, holidays, timezone → form config, ticket details
 *   staff           staff accounts → staff pickers, teams, ticket details (names), escalation
 *                   warnings, account managers on Clients
 *   skills          skills catalog, who has which skill, which category needs which → the Skills,
 *                   Staff and Categories admin lists
 *   email-templates, help-center, settings, audit → the matching admin lists only
 */
export const CONFIG_SCOPES = [
  'ticket-form',
  'form-context',
  'macros',
  'teams',
  'escalation',
  'calendar',
  'staff',
  'skills',
  'email-templates',
  'help-center',
  'settings',
  'audit',
] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/**
 * Broadcast to every socket after an admin change commits. `version` is the config generation
 * after the change: a client that refetches and still gets an older `version` from
 * `GET /config/ticket-form` (its `version` field) refetches again.
 */
export const configUpdatedPayloadSchema = z.object({
  scope: z.enum(CONFIG_SCOPES),
  version: z.number().int().nonnegative(),
});
export type ConfigUpdatedPayload = z.infer<typeof configUpdatedPayloadSchema>;

export interface ServerToClientEvents {
  'message:new': (payload: MessageNewPayload) => void;
  'message:typing': (payload: TypingPayload) => void;
  'ticket:updated': (payload: TicketUpdatedPayload) => void;
  'queue:updated': (payload: QueueUpdatedPayload) => void;
  /** To `user:{id}` only (validate with `notificationNewPayloadSchema`). */
  'notification:new': (payload: NotificationNewPayload) => void;
  /** To every socket (validate with `configUpdatedPayloadSchema`). */
  'config:updated': (payload: ConfigUpdatedPayload) => void;
}

/**
 * At most this many `ticket:{id}` rooms per socket (joins in flight count too). A join beyond it
 * is acked `TOO_MANY_ROOMS`: leave a room, then try again. Clients keep their live lists below it
 * (the portal list holds 40 live rows) and send leaves before joins when the set changes. The
 * server counts a join when it arrives and frees the slot when the leave arrives, so a leave sent
 * before a join always makes room for it. Like every refused event, a TOO_MANY_ROOMS refusal
 * counts against the socket's allowance (500 at once, then 50 per second) before it is
 * disconnected: retry after a leave, not in a loop.
 */
export const MAX_TICKET_ROOMS_PER_SOCKET = 50;

export const ticketRoomRequestSchema = z.object({ ticketId: z.uuid() });
export type TicketRoomRequest = z.infer<typeof ticketRoomRequestSchema>;

export const typingRequestSchema = z.object({
  ticketId: z.uuid(),
  isTyping: z.boolean(),
  scope: z.enum(['public', 'internal']),
});
export type TypingRequest = z.infer<typeof typingRequestSchema>;

/**
 * Every client → server event is acknowledged with this. RATE_LIMITED: the event was dropped —
 * a throttled typing event (best effort; nothing to retry), or a `ticket:join` / `ticket:leave`
 * beyond the socket's or the user's budget (retry later; the web's list refreshes stay well
 * within it) — or any event beyond the socket's overall event budget. A handshake refused with the
 * connect error `TOO_MANY_CONNECTIONS` means the user (or their address) already has the maximum
 * number of sockets open. After any refused handshake the server closes the connection; a client
 * that retries (the web does, with a fresh token) opens a new one. Too many new connections from
 * one address are refused at the HTTP upgrade (a transport error, no connect error).
 */
export type SocketAck =
  | { ok: true }
  | {
      ok: false;
      /**
       * Retryable: `RATE_LIMITED` (later, with backoff) and `TOO_MANY_ROOMS` (after leaving a
       * room — see MAX_TICKET_ROOMS_PER_SOCKET). Final for this holder: `NOT_FOUND` (unknown or
       * invisible ticket), `FORBIDDEN`, `VALIDATION_FAILED`, `INTERNAL`.
       */
      error:
        | 'VALIDATION_FAILED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'RATE_LIMITED'
        | 'TOO_MANY_ROOMS'
        | 'INTERNAL';
    };

export interface ClientToServerEvents {
  'ticket:join': (payload: TicketRoomRequest, ack: (res: SocketAck) => void) => void;
  'ticket:leave': (payload: TicketRoomRequest, ack: (res: SocketAck) => void) => void;
  'message:typing': (payload: TypingRequest, ack: (res: SocketAck) => void) => void;
}
