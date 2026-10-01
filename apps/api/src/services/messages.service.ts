import { Prisma, type PrismaClient } from '@loons/db';
import {
  canAddInternalNote,
  canReplyPublic,
  canSeeInternalNotes,
  isStaff,
  slaMinutesBetween,
  statusAfterMessage,
  type Actor,
  type BusinessCalendar,
  type CreateMessageInput,
  type MessageDto,
  type MessageType,
  type TicketSummaryDto,
} from '@loons/shared';
import { errors } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import { attachmentLinkIssues, linkAttachments } from './attachments.service.ts';
import type { SlaMath } from './sla.ts';
import {
  assertClientCanWrite,
  isClosed,
  loadVisibleTicket,
  lockTicket,
  type TicketRealtime,
} from './ticket-access.ts';
import type { TicketConfigService } from './ticket-config.service.ts';
import type { Notifier } from './notifier.ts';
import { messageSelect, toMessageDto } from './ticket-dto.ts';
import { statusChangeData } from './ticket-state.ts';
import type { TicketsService } from './tickets.service.ts';

// Ticket conversation (spec §7–8): persisted first, then broadcast. Posting is idempotent on
// (ticketId, clientTempId) so the web app can retry an optimistic message safely. Clients never
// read or receive INTERNAL notes.

export interface PostMessageResult {
  /** false when the request replayed an already stored message (HTTP 200 instead of 201). */
  created: boolean;
  message: MessageDto;
  ticket: TicketSummaryDto;
}

export interface MessagesService {
  list(
    actor: Actor,
    ticketId: string,
    query: { after?: string | undefined; limit: number },
  ): Promise<MessageDto[]>;
  post(actor: Actor, ticketId: string, input: CreateMessageInput): Promise<PostMessageResult>;
}

/** Message types the caller may read. */
export function readableMessageTypes(actor: Actor): MessageType[] {
  return canSeeInternalNotes(actor) ? ['PUBLIC', 'INTERNAL', 'SYSTEM'] : ['PUBLIC', 'SYSTEM'];
}

type EventInput = Omit<Prisma.TicketEventCreateManyInput, 'ticketId'>;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createMessagesService(deps: {
  prisma: PrismaClient;
  tickets: TicketsService;
  ticketConfig: TicketConfigService;
  sla: SlaMath;
  realtime: TicketRealtime;
  /** Notification producers, called after each commit (D15). */
  notifier: Notifier;
  logger: Logger;
}): MessagesService {
  const { prisma, tickets, ticketConfig, sla, realtime, notifier, logger } = deps;

  async function emit(what: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, event: what }, 'realtime emit failed');
    }
  }

  /** A retry of a message the caller already posted: the stored message, unchanged. */
  async function replay(
    actor: Actor,
    ticketId: string,
    clientTempId: string,
  ): Promise<PostMessageResult | null> {
    const existing = await prisma.message.findUnique({
      where: { ticketId_clientTempId: { ticketId, clientTempId } },
      select: messageSelect,
    });
    if (!existing) return null;
    // Someone else's message (a guessed id) is never returned.
    if (existing.authorId !== actor.id) throw errors.conflict('This message id is already used');
    return {
      created: false,
      message: toMessageDto(existing),
      ticket: await tickets.summary(ticketId),
    };
  }

  return {
    async list(actor, ticketId, { after, limit }) {
      const ticket = await loadVisibleTicket(prisma, actor, ticketId);
      const types = readableMessageTypes(actor);
      let cursor: Prisma.MessageWhereInput = {};
      if (after) {
        const from = await prisma.message.findFirst({
          where: { id: after, ticketId: ticket.id, type: { in: types } },
          select: { id: true, createdAt: true },
        });
        if (!from) throw errors.notFound('Message not found');
        cursor = {
          OR: [
            { createdAt: { gt: from.createdAt } },
            { createdAt: from.createdAt, id: { gt: from.id } },
          ],
        };
      }
      const rows = await prisma.message.findMany({
        where: { ticketId: ticket.id, type: { in: types }, ...cursor },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: messageSelect,
      });
      return rows.map(toMessageDto);
    },

    async post(actor, ticketId, input) {
      const scope = await loadVisibleTicket(prisma, actor, ticketId);
      const staff = isStaff(actor);
      if (input.type === 'INTERNAL' && !canAddInternalNote(actor, scope)) {
        throw errors.forbidden('Only Loons staff can add internal notes');
      }
      if (input.type === 'PUBLIC' && !canReplyPublic(actor, scope)) {
        throw errors.notFound('Ticket not found');
      }
      if (input.andSolve && !staff) throw errors.forbidden('Only Loons staff can send and solve');

      const replayed = await replay(actor, scope.id, input.clientTempId);
      if (replayed) return replayed;
      await assertClientCanWrite(prisma, actor);
      if (isClosed(scope.status)) throw errors.conflict('This ticket is closed');

      const issues = await attachmentLinkIssues(
        prisma,
        actor,
        input.attachmentIds,
        scope.id,
        input.type,
      );
      if (issues.length) throw errors.validation(issues);

      let calendar: BusinessCalendar | null = null;
      const getCalendar = async () => (calendar ??= await ticketConfig.getCalendar());

      let outcome: { messageId: string; teamId: string; ticketChanged: boolean };
      try {
        outcome = await prisma.$transaction(async (tx) => {
          await lockTicket(tx, scope.id);
          const t = await tx.ticket.findUniqueOrThrow({
            where: { id: scope.id },
            select: {
              id: true,
              status: true,
              priority: true,
              teamId: true,
              assigneeId: true,
              createdAt: true,
              firstRepliedAt: true,
              resolveDueAt: true,
              resolveAtRiskAt: true,
              slaPausedAt: true,
              slaPauses: true,
            },
          });
          if (isClosed(t.status)) throw errors.conflict('This ticket is closed');
          const now = new Date();
          const message = await tx.message.create({
            data: {
              ticketId: t.id,
              authorId: actor.id,
              type: input.type,
              body: input.body,
              clientTempId: input.clientTempId,
              createdAt: now,
            },
            select: { id: true },
          });
          await linkAttachments(tx, actor, input.attachmentIds, t.id, message.id, input.type);

          const data: Prisma.TicketUncheckedUpdateInput = {};
          const events: EventInput[] = [];
          const event = (
            type: EventInput['type'],
            from: string | null,
            to: string | null,
            meta?: Prisma.InputJsonObject,
          ) =>
            events.push({
              type,
              actorId: actor.id,
              fromValue: from,
              toValue: to,
              ...(meta ? { meta } : {}),
              createdAt: now,
            });

          // Internal notes don't move "last message" (clients must not notice them).
          if (input.type === 'PUBLIC') data.lastMessageAt = now;

          if (staff && input.type === 'PUBLIC') {
            if (!t.firstRepliedAt) {
              data.firstRepliedAt = now;
              // Also on the SLA clock of the priority and calendar in force now (24/7 or business
              // minutes): the Reports average (F11) uses it, so a later priority change or
              // calendar edit doesn't re-measure a reply that was already sent.
              const policy = (await ticketConfig.getFormConfig()).slaPolicies.find(
                (p) => p.priority === t.priority,
              );
              event('FIRST_REPLY', null, null, {
                minutesToFirstReply: Math.round((now.getTime() - t.createdAt.getTime()) / 60_000),
                slaMinutesToFirstReply: slaMinutesBetween(
                  t.createdAt,
                  now,
                  await getCalendar(),
                  policy?.businessHoursOnly ?? false,
                ),
                messageId: message.id,
              });
            }
            // The first agent of the team to reply publicly takes an unassigned ticket.
            if (!t.assigneeId && actor.teamIds.includes(t.teamId)) {
              data.assigneeId = actor.id;
              event('ASSIGNEE_CHANGED', null, actor.id);
            }
          }

          const next = statusAfterMessage({
            current: t.status,
            author: staff ? 'staff' : 'client',
            type: input.type,
            andSolve: input.andSolve,
          });
          if (next && next !== t.status) {
            const policy = (await ticketConfig.getFormConfig()).slaPolicies.find(
              (p) => p.priority === t.priority,
            );
            Object.assign(
              data,
              await statusChangeData({
                from: t.status,
                to: next,
                now,
                resolveDueAt: t.resolveDueAt,
                resolveAtRiskAt: t.resolveAtRiskAt,
                slaPausedAt: t.slaPausedAt,
                slaPauses: t.slaPauses,
                businessHoursOnly: policy?.businessHoursOnly ?? false,
                calendar: getCalendar,
                math: sla,
              }),
            );
            event('STATUS_CHANGED', t.status, next);
          }

          if (Object.keys(data).length) {
            await tx.ticket.update({ where: { id: t.id }, data });
          }
          if (events.length) {
            await tx.ticketEvent.createMany({
              data: events.map((e) => ({ ...e, ticketId: t.id })),
            });
          }
          return {
            messageId: message.id,
            teamId: t.teamId,
            ticketChanged: events.some(
              (e) => e.type === 'STATUS_CHANGED' || e.type === 'ASSIGNEE_CHANGED',
            ),
          };
        });
      } catch (err) {
        // A concurrent retry with the same clientTempId won the race: return its message.
        if (isUniqueViolation(err)) {
          const winner = await replay(actor, scope.id, input.clientTempId);
          if (winner) return winner;
        }
        throw err;
      }

      const [row, ticket] = await Promise.all([
        prisma.message.findUniqueOrThrow({
          where: { id: outcome.messageId },
          select: messageSelect,
        }),
        tickets.summary(scope.id),
      ]);
      const message = toMessageDto(row);
      await emit('message:new', () => realtime.messageNew(message));
      // A note changes nothing clients can see unless it moved the status / assignee.
      if (input.type === 'PUBLIC' || outcome.ticketChanged) {
        await emit('ticket:updated', () => realtime.ticketUpdated(ticket));
      }
      await emit('queue:updated', () =>
        realtime.queueUpdated([outcome.teamId], scope.id, 'message'),
      );
      // Email / in-app for PUBLIC messages only: an internal note never notifies anyone outside
      // the console (and never reaches a client).
      if (input.type === 'PUBLIC') {
        await notifier.publicReply(scope.id, outcome.messageId, staff ? 'staff' : 'client');
      }
      return { created: true, message, ticket };
    },
  };
}
