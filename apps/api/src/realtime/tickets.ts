import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@loons/db';
import {
  MAX_TICKET_ROOMS_PER_SOCKET,
  SERVER_EVENTS,
  canJoinTicketRoom,
  canJoinTicketStaffRoom,
  isActive,
  isStaff,
  rooms,
  ticketRoomRequestSchema,
  typingRequestSchema,
  type Actor,
  type MessageNewPayload,
  type QueueUpdatedPayload,
  type RoomName,
  type SocketAck,
  type TicketScope,
  type TicketSummaryDto,
  type TicketUpdatedPayload,
  type TypingPayload,
} from '@loons/shared';
import { toActor } from '../lib/actor.ts';
import { withTimeout } from '../lib/redis.ts';
import type { TicketRealtime } from '../services/ticket-access.ts';
import type { ConnectionLimiter } from './limits.ts';
import type { AppSocket, AppSocketServer } from './socket.ts';

// Ticket rooms (spec §8, contract "Realtime"):
//   ticket:{id}        every viewer — PUBLIC / SYSTEM messages, ticket updates, client typing
//   ticket:{id}:staff  staff viewers only — INTERNAL notes and staff typing
//   team:{id}          staff of the team — queue changes
// Every payload from a client is validated; every join is authorised against the database and
// rate limited (per socket and per user, review SEC-RT-1); every event, whatever its name, spends
// one of the socket's event tokens first, and a socket whose events keep being refused is
// disconnected (review RR-SEC-2). Room membership is re-checked with the user's current
// permissions when a ticket changes (re-route, unassignment) and when the user's access changes
// (`refreshUserSockets`), on every API instance.

/** Typing "start" events forwarded at most once per this interval per ticket and socket. */
export const TYPING_MIN_INTERVAL_MS = 1_000;
/** Hard cap on typing events per socket (anything above is dropped). */
export const TYPING_BURST = { max: 30, windowMs: 10_000 } as const;

type Ack = (res: SocketAck) => void;
type AckError = Extract<SocketAck, { ok: false }>['error'];

function ackOf(ack: unknown): Ack {
  return typeof ack === 'function' ? (ack as Ack) : () => undefined;
}

export interface TypingState {
  lastStartAt: Map<string, number>;
  windowStart: number;
  count: number;
}

export function newTypingState(): TypingState {
  return { lastStartAt: new Map(), windowStart: 0, count: 0 };
}

/** Whether a typing event may be forwarded now (per-socket throttle). */
export function allowTyping(
  state: TypingState,
  ticketId: string,
  isTyping: boolean,
  now = Date.now(),
): boolean {
  if (now - state.windowStart >= TYPING_BURST.windowMs) {
    state.windowStart = now;
    state.count = 0;
  }
  if (state.count >= TYPING_BURST.max) return false;
  if (isTyping) {
    const last = state.lastStartAt.get(ticketId);
    if (last !== undefined && now - last < TYPING_MIN_INTERVAL_MS) return false;
    state.lastStartAt.set(ticketId, now);
  } else {
    state.lastStartAt.delete(ticketId);
  }
  state.count += 1;
  return true;
}

const TICKET_ROOM = /^ticket:([0-9a-f-]{36})$/i;

/** Ids of the tickets whose `ticket:{id}` room the socket is in. */
function ticketIdsOf(roomNames: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const room of roomNames) {
    const match = TICKET_ROOM.exec(room);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

/** Team rooms the actor belongs in (super admins: every active team). */
async function allowedTeamIds(app: FastifyInstance, actor: Actor): Promise<string[]> {
  if (!isStaff(actor)) return [];
  if (actor.role !== 'SUPER_ADMIN') return [...actor.teamIds];
  const teams = await app.prisma.team.findMany({ where: { isActive: true }, select: { id: true } });
  return teams.map((t) => t.id);
}

/** Joins the staff member's team rooms (super admins: every active team). */
export async function joinTeamRooms(app: FastifyInstance, socket: AppSocket): Promise<void> {
  const teamIds = await allowedTeamIds(app, socket.data.actor);
  if (teamIds.length) await socket.join(teamIds.map((id) => rooms.team(id)));
}

/** The user's current permissions (null when they no longer exist or may not use the app). */
export async function loadActiveActor(
  app: FastifyInstance,
  userId: string,
  options: { fresh?: boolean } = {},
): Promise<Actor | null> {
  const principal = await app.principals.load(userId, options);
  if (!principal) return null;
  const actor = toActor(principal);
  return isActive(actor) ? actor : null;
}

export function registerTicketHandlers(
  app: FastifyInstance,
  socket: AppSocket,
  limiter: ConnectionLimiter,
): void {
  function fail(ack: Ack, err: unknown, event: string): void {
    app.log.error({ err, event }, 'socket event failed');
    ack({ ok: false, error: 'INTERNAL' });
  }

  /**
   * Refuses an event without touching the database (throttled, malformed, not permitted) and
   * counts it: a socket whose events keep being refused is disconnected, since refusing them
   * still costs CPU (reviews SEC-RT-1, RR-SEC-2).
   */
  function refuse(ack: Ack, error: AckError): void {
    ack({ ok: false, error });
    if (socket.connected && socket.data.limits.drops.record()) {
      app.log.warn({ userId: socket.data.actor.id }, 'socket disconnected: event flood');
      socket.disconnect(true);
    }
  }

  // Every event spends one of the socket's tokens before anything looks at it — including
  // events without a handler, whose sender would otherwise never be counted. The event's ack (if
  // any) is its last argument. Not calling `next` drops the event.
  socket.use((event, next) => {
    if (socket.data.limits.events.take()) return next();
    refuse(ackOf(event.at(-1)), 'RATE_LIMITED');
  });

  // Joins and leaves of one ticket run one after another, in the order the socket sent them: a
  // join awaits the database, so a leave sent right after it would otherwise be handled first and
  // the socket would stay in the room it just left (review F5).
  const roomOps = new Map<string, Promise<void>>();
  /** Operations queued or running per ticket. */
  const pendingOps = new Map<string, number>();
  function inOrder(ticketId: string, op: () => Promise<void>): Promise<void> {
    pendingOps.set(ticketId, (pendingOps.get(ticketId) ?? 0) + 1);
    const run = (roomOps.get(ticketId) ?? Promise.resolve()).then(op).finally(() => {
      const left = (pendingOps.get(ticketId) ?? 1) - 1;
      if (left > 0) pendingOps.set(ticketId, left);
      else pendingOps.delete(ticketId);
    });
    const tail = run.catch(() => undefined); // a failed operation never blocks the next one
    roomOps.set(ticketId, tail);
    void tail.then(() => {
      if (roomOps.get(ticketId) === tail) roomOps.delete(ticketId);
    });
    return run;
  }

  // The ticket rooms this socket is in or is joining, counted against MAX_TICKET_ROOMS_PER_SOCKET
  // when the join ARRIVES — synchronously, before its database reads — so joins sent together
  // can't all pass the check (sweep: 120 concurrent joins used to leave a socket in 120 rooms).
  // A leave frees its ticket's slot as soon as it arrives, so "leave the dropped row, then join
  // the new one" works at the cap even though both run later. Slots whose ticket has no operation
  // left and whose room the socket isn't in — a refused join, a room left without a leave
  // (evictions, refreshUserSockets) — are given back when the cap is reached.
  const slots = new Set<string>();
  /** Drops the ticket's slot unless the socket is in its room or still has operations queued. */
  function settleSlot(ticketId: string): void {
    if (!pendingOps.has(ticketId) && !socket.rooms.has(rooms.ticket(ticketId))) {
      slots.delete(ticketId);
    }
  }
  /** Reserves a slot for joining the ticket (true when it already has one); false at the cap. */
  function reserveSlot(ticketId: string): boolean {
    if (slots.has(ticketId)) return true;
    if (slots.size >= MAX_TICKET_ROOMS_PER_SOCKET) for (const id of slots) settleSlot(id);
    if (slots.size >= MAX_TICKET_ROOMS_PER_SOCKET) return false;
    slots.add(ticketId);
    return true;
  }

  socket.on('ticket:join', (payload, rawAck) => {
    const ack = ackOf(rawAck);
    // Every join reads the user and the ticket: throttled before anything else (SEC-RT-1).
    if (!socket.data.limits.join.take() || !limiter.takeJoin(socket.data.actor.id)) {
      return refuse(ack, 'RATE_LIMITED');
    }
    const parsed = ticketRoomRequestSchema.safeParse(payload);
    if (!parsed.success) return refuse(ack, 'VALIDATION_FAILED');
    const { ticketId } = parsed.data;
    const room = rooms.ticket(ticketId);
    // Retryable: the client leaves a room, then joins again (contract: SocketAck).
    if (!reserveSlot(ticketId)) return refuse(ack, 'TOO_MANY_ROOMS');
    void inOrder(ticketId, async () => {
      const actor = await loadActiveActor(app, socket.data.actor.id);
      if (!actor) return ack({ ok: false, error: 'FORBIDDEN' });
      // Later checks on this socket (typing, evictions) use the fresher teams / role.
      socket.data.actor = actor;
      const ticket = await app.prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { orgId: true, teamId: true, assigneeId: true },
      });
      if (!ticket || !canJoinTicketRoom(actor, ticket)) {
        return ack({ ok: false, error: 'NOT_FOUND' });
      }
      await socket.join(room);
      if (canJoinTicketStaffRoom(actor, ticket)) await socket.join(rooms.ticketStaff(ticketId));
      else await socket.leave(rooms.ticketStaff(ticketId));
      ack({ ok: true });
    }).catch((err: unknown) => fail(ack, err, 'ticket:join'));
  });

  socket.on('ticket:leave', (payload, rawAck) => {
    const ack = ackOf(rawAck);
    if (!socket.data.limits.leave.take()) return refuse(ack, 'RATE_LIMITED');
    const parsed = ticketRoomRequestSchema.safeParse(payload);
    if (!parsed.success) return refuse(ack, 'VALIDATION_FAILED');
    const { ticketId } = parsed.data;
    slots.delete(ticketId);
    void inOrder(ticketId, async () => {
      await Promise.all([
        socket.leave(rooms.ticket(ticketId)),
        socket.leave(rooms.ticketStaff(ticketId)),
      ]);
      socket.data.typing.lastStartAt.delete(ticketId);
      ack({ ok: true });
    }).catch((err: unknown) => fail(ack, err, 'ticket:leave'));
  });

  socket.on('message:typing', (payload, rawAck) => {
    const ack = ackOf(rawAck);
    // Every refusal below is decided in memory and counted (RR-SEC-2: a flood of invalid typing
    // events used to cost as much as valid ones without ever disconnecting the sender).
    const parsed = typingRequestSchema.safeParse(payload);
    if (!parsed.success) return refuse(ack, 'VALIDATION_FAILED');
    const { ticketId, isTyping, scope } = parsed.data;
    if (!socket.rooms.has(rooms.ticket(ticketId))) return refuse(ack, 'NOT_FOUND');

    const staff = isStaff(socket.data.actor);
    // Staff typing (public reply or note alike) only ever reaches other staff; clients may only
    // signal public typing.
    const room = staff ? rooms.ticketStaff(ticketId) : rooms.ticket(ticketId);
    if (staff && !socket.rooms.has(room)) return refuse(ack, 'NOT_FOUND');
    if (!staff && scope !== 'public') return refuse(ack, 'FORBIDDEN');
    if (!allowTyping(socket.data.typing, ticketId, isTyping)) return refuse(ack, 'RATE_LIMITED');

    void (async () => {
      if (socket.data.name === undefined) {
        const user = await app.prisma.user.findUnique({
          where: { id: socket.data.actor.id },
          select: { name: true },
        });
        socket.data.name = user?.name ?? '';
      }
      const out: TypingPayload = {
        ticketId,
        user: { id: socket.data.actor.id, name: socket.data.name },
        isTyping,
        scope: staff ? scope : 'public',
      };
      socket.to(room).emit(SERVER_EVENTS.messageTyping, out);
      ack({ ok: true });
    })().catch((err: unknown) => fail(ack, err, 'message:typing'));
  });
}

/**
 * Re-checks a user's local sockets after their access changed (team membership, role, status —
 * Phase 4 member edits; see `Realtime.refreshUser`): a user who may no longer use the app is
 * disconnected; otherwise every socket gets the fresh permissions, joins / leaves team rooms to
 * match, and leaves the rooms of tickets it can no longer see (review SEC-RT-2).
 */
export async function refreshUserSockets(
  app: FastifyInstance,
  sockets: readonly AppSocket[],
  userId: string,
): Promise<void> {
  if (sockets.length === 0) return;
  const actor = await loadActiveActor(app, userId, { fresh: true });
  if (!actor) {
    for (const socket of sockets) socket.disconnect(true);
    return;
  }
  const teamRooms = new Set<string>((await allowedTeamIds(app, actor)).map((id) => rooms.team(id)));
  const ticketIds = [...new Set(sockets.flatMap((s) => ticketIdsOf(s.rooms)))];
  const scopes = ticketIds.length
    ? await app.prisma.ticket.findMany({
        where: { id: { in: ticketIds } },
        select: { id: true, orgId: true, teamId: true, assigneeId: true },
      })
    : [];
  const scopeOf = new Map(scopes.map((t) => [t.id, t]));

  for (const socket of sockets) {
    socket.data.actor = actor;
    const current = [...socket.rooms];
    const leave = current.filter((room) => room.startsWith('team:') && !teamRooms.has(room));
    const join = [...teamRooms].filter((room) => !socket.rooms.has(room));
    for (const ticketId of ticketIdsOf(current)) {
      const scope = scopeOf.get(ticketId);
      if (!scope || !canJoinTicketRoom(actor, scope)) {
        leave.push(rooms.ticket(ticketId), rooms.ticketStaff(ticketId));
      } else if (!canJoinTicketStaffRoom(actor, scope)) {
        leave.push(rooms.ticketStaff(ticketId));
      }
    }
    for (const room of leave) await socket.leave(room);
    if (join.length) await socket.join(join);
  }
}

interface RoomMember {
  id: string;
  data: Partial<Pick<AppSocket['data'], 'actor'>>;
  rooms: Set<string>;
}

/**
 * The users who may have lost sight of a ticket through a change from `previous` to `next`,
 * decided from the database alone: members of the old team (on a re-route) and the old assignee
 * (on a re-assignment) who aren't — now — an active super admin, a staff member of the new team
 * or the new assignee. Errs towards listing a user: being left out of a room only costs live
 * updates until the next join, which checks the ticket again. Clients never lose a ticket this
 * way (they see their organisation's tickets).
 */
export async function usersWhoLostAccess(
  prisma: PrismaClient,
  previous: TicketScope,
  next: TicketScope,
): Promise<string[]> {
  const teamChanged = previous.teamId !== next.teamId;
  const oldAssignee = previous.assigneeId !== next.assigneeId ? previous.assigneeId : null;
  if (!teamChanged && !oldAssignee) return [];
  const users = await prisma.user.findMany({
    where: {
      OR: [
        ...(teamChanged ? [{ teamMemberships: { some: { teamId: previous.teamId } } }] : []),
        ...(oldAssignee ? [{ id: oldAssignee }] : []),
      ],
    },
    select: {
      id: true,
      role: true,
      status: true,
      teamMemberships: { where: { teamId: next.teamId }, select: { teamId: true } },
    },
  });
  const keeps = (u: (typeof users)[number]) =>
    u.status === 'ACTIVE' &&
    (u.role === 'SUPER_ADMIN' ||
      u.id === next.assigneeId ||
      (u.role !== 'CLIENT' && u.teamMemberships.length > 0));
  return users.filter((u) => !keeps(u)).map((u) => u.id);
}

export interface TicketRealtimeOptions {
  crossNode: boolean;
  onError: (err: unknown) => void;
  /** The user's current permissions (principal cache / database), null when inactive. */
  loadActor: (userId: string) => Promise<Actor | null>;
  /** See `usersWhoLostAccess`. */
  usersWhoLostAccess: (previous: TicketScope, next: TicketScope) => Promise<string[]>;
  /**
   * Longest wait for the other instances (their room members, the flush below) before a ticket
   * update goes on without them (the Redis adapter itself waits 5 s for a silent peer).
   */
  clusterTimeoutMs: number;
  /**
   * Resolves once Redis has handed every request and broadcast this instance published so far to
   * the subscribers (a PING on the adapter's publishing connection). Only with the adapter.
   */
  flush?: () => Promise<unknown>;
}

/** `promise`, or a rejection after `ms`; a late rejection of `promise` is not left unhandled. */
function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  promise.catch(() => undefined);
  return withTimeout(promise, ms, label);
}

/** Emits ticket changes to their rooms (called by the services after each commit). */
export function createTicketRealtime(
  io: AppSocketServer,
  options: TicketRealtimeOptions,
): TicketRealtime {
  /**
   * Removes the sockets — on every instance — whose user can no longer see the ticket, and
   * returns what the update's emit must skip (socket ids and `user:{id}` rooms). Never waits for
   * other instances longer than `clusterTimeoutMs`, and fails closed when they don't answer
   * (sweep: a silent peer held every update for 5 s and let evicted sockets keep the room):
   *
   * 1. This instance's sockets, synchronously, with the permissions they carry: nothing emitted
   *    after this call starts reaches a local socket a re-route / unassignment just locked out.
   * 2. With the Redis adapter: the users this change itself locked out (`usersWhoLostAccess`, from
   *    the database: old-team members not on the new team, the old assignee) leave on every
   *    instance, by user room, without waiting for anyone — before step 3 asks the other
   *    instances anything.
   * 3. Every instance's members, judged with each user's CURRENT permissions (a user removed from
   *    the team since their socket joined no longer passes, review SEC-RT-2), fetched with a
   *    `clusterTimeoutMs` bound. If the other instances don't answer in time, this instance's
   *    members are still judged with fresh permissions; remote users whose access changed
   *    elsewhere are covered by `refreshUser`, which every principal invalidation runs on every
   *    instance.
   *
   * Ordering (why nothing published after the update reaches an evicted socket elsewhere): the
   * leaves of steps 2 and 3, the update's emit and every later emit of this instance go out on
   * the adapter's one publishing connection, so Redis hands them to each instance in that order,
   * and the adapter applies a leave synchronously when it arrives. `ticketUpdated` then waits
   * (at most `clusterTimeoutMs`) for a PING on that connection: once it answers, Redis has
   * delivered the leaves, so whatever any instance publishes after the update's request was
   * answered — a note posted next, on any instance — arrives everywhere after them. What stays
   * open: a message published by another instance DURING this call (after the ticket's commit,
   * before step 2's leaves reach Redis — one database round trip), and, when this instance's
   * Redis connection is down, the time until it reconnects (ioredis queues the leaves; the PING
   * then times out and is logged).
   */
  async function evictUnauthorised(
    ticket: TicketSummaryDto,
    previous: TicketScope | undefined,
  ): Promise<Set<string>> {
    const room = rooms.ticket(ticket.id);
    const staffRoom = rooms.ticketStaff(ticket.id);
    const nsp = io.of('/');
    const scope: TicketScope = {
      orgId: ticket.org.id,
      teamId: ticket.team.id,
      assigneeId: ticket.assignee?.id ?? null,
    };
    const skip = new Set<string>();
    /** Which rooms `member` must leave given `actor` (null: the user may not use the app). */
    const verdict = (member: RoomMember, actor: Actor | null): 'all' | 'staff' | null => {
      if (!actor || !canJoinTicketRoom(actor, scope)) return 'all';
      if (!canJoinTicketStaffRoom(actor, scope) && member.rooms.has(staffRoom)) return 'staff';
      return null;
    };
    const localMembers = () =>
      [...(nsp.adapter.rooms.get(room) ?? [])]
        .map((id) => nsp.sockets.get(id))
        .filter((s): s is AppSocket => s !== undefined);

    // 1.
    for (const socket of localMembers()) {
      const out = verdict(socket, socket.data.actor);
      if (out === 'all') {
        skip.add(socket.id);
        void socket.leave(room);
        void socket.leave(staffRoom);
      } else if (out === 'staff') {
        void socket.leave(staffRoom);
      }
    }

    // 2. Only with other instances (alone, step 3 sees every member). The Redis adapter applies a
    //    leave only when it comes back from Redis, hence the local one first. Should the database
    //    not answer, the old team's staff rooms stand in for its members — except the new team's
    //    (super admins are in every team room) — and the old assignee is named: over-inclusive,
    //    never open.
    if (
      options.crossNode &&
      previous &&
      (previous.teamId !== scope.teamId || previous.assigneeId !== scope.assigneeId)
    ) {
      let lost: RoomName[];
      let except: RoomName[] = [];
      try {
        lost = (await options.usersWhoLostAccess(previous, scope)).map((id) => rooms.user(id));
      } catch (err) {
        options.onError(err);
        lost = [];
        if (previous.teamId !== scope.teamId) {
          lost.push(rooms.team(previous.teamId));
          except = [
            rooms.team(scope.teamId),
            ...(scope.assigneeId ? [rooms.user(scope.assigneeId)] : []),
          ];
        }
        if (previous.assigneeId && previous.assigneeId !== scope.assigneeId) {
          lost.push(rooms.user(previous.assigneeId));
        }
      }
      if (lost.length) {
        io.local.in(lost).except(except).socketsLeave([room, staffRoom]);
        io.in(lost).except(except).socketsLeave([room, staffRoom]);
        // Skipped by the emit too, wherever the leave is still in flight (a room also names
        // sockets that joined it since; `except` can't be expressed as a skip, so the rooms of
        // the fallback are skipped whole).
        for (const name of lost) skip.add(name);
      }
    }

    // 3.
    let members: RoomMember[] = localMembers();
    let remote = false;
    if (options.crossNode) {
      try {
        members = await bounded(
          io.in(room).fetchSockets(),
          options.clusterTimeoutMs,
          'fetching the ticket room members of the other instances',
        );
        remote = true;
      } catch (err) {
        options.onError(err);
        members = localMembers();
      }
    }
    if (members.length === 0) return skip;
    const userIds = [...new Set(members.flatMap((m) => (m.data.actor ? [m.data.actor.id] : [])))];
    const actors = new Map(
      await Promise.all(userIds.map(async (id) => [id, await options.loadActor(id)] as const)),
    );
    const leaveAll: string[] = [];
    const leaveStaff: string[] = [];
    for (const member of members) {
      const actor = member.data.actor ? (actors.get(member.data.actor.id) ?? null) : null;
      const out = verdict(member, actor);
      if (out === 'all') leaveAll.push(member.id);
      else if (out === 'staff') leaveStaff.push(member.id);
      // Keep this instance's sockets on the fresh permissions (typing checks use them).
      const local = nsp.sockets.get(member.id);
      if (local && actor) local.data.actor = actor;
    }
    // This instance's sockets leave right away; the others get the request before any later
    // emit of this instance (one publishing connection, delivered in order).
    if (leaveAll.length) {
      io.local.in(leaveAll).socketsLeave([room, staffRoom]);
      if (remote) io.in(leaveAll).socketsLeave([room, staffRoom]);
    }
    if (leaveStaff.length) {
      io.local.in(leaveStaff).socketsLeave(staffRoom);
      if (remote) io.in(leaveStaff).socketsLeave(staffRoom);
    }
    for (const id of leaveAll) skip.add(id);
    return skip;
  }

  return {
    messageNew(message) {
      const payload: MessageNewPayload = { ticketId: message.ticketId, message };
      // Internal notes go to the staff room ONLY — never to ticket:{id}, where clients are.
      const room =
        message.type === 'INTERNAL'
          ? rooms.ticketStaff(message.ticketId)
          : rooms.ticket(message.ticketId);
      io.to(room).emit(SERVER_EVENTS.messageNew, payload);
    },
    async ticketUpdated(ticket, previous) {
      let skip = new Set<string>();
      try {
        skip = await evictUnauthorised(ticket, previous);
      } catch (err) {
        options.onError(err);
      }
      const payload: TicketUpdatedPayload = { ticket };
      // Evicted sockets (and users) are excluded explicitly too, wherever a leave is in flight.
      io.to(rooms.ticket(ticket.id))
        .except([...skip])
        .emit(SERVER_EVENTS.ticketUpdated, payload);
      // Resolve only once Redis has handed our leaves and this emit to every instance: whatever
      // is published after this update's request has been answered — a note posted next, on any
      // instance — reaches each instance after them.
      if (options.crossNode && options.flush) {
        await bounded(options.flush(), options.clusterTimeoutMs, 'flushing the room leaves').catch(
          options.onError,
        );
      }
    },
    queueUpdated(teamIds, ticketId, reason) {
      for (const teamId of new Set(teamIds)) {
        const payload: QueueUpdatedPayload = { teamId, ticketId, reason };
        io.to(rooms.team(teamId)).emit(SERVER_EVENTS.queueUpdated, payload);
      }
    },
  };
}
