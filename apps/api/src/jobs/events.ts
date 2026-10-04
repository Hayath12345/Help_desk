import type { NotificationData, Priority } from '@loons/shared';
import { loadP1Chain, nextRule } from '../lib/escalation.ts';
import type { NotificationEvent } from '../lib/job-data.ts';
import {
  createInApp,
  keyHash,
  queueDeliveries,
  type PlannedDelivery,
  type PlannedInApp,
  type WorkerContext,
} from './context.ts';
import {
  activeStaff,
  assigneeAndLeads,
  listAddresses,
  loadTicketFacts,
  slaAlertStillValid,
  teamLeads,
  type TicketFactsRow,
} from './recipients.ts';

// Fan-out of one ticket event (decision D15): resolves the recipients now, records one
// `NotificationDelivery` per channel × recipient, enqueues one `deliver` job for each and creates
// the in-app notifications. Every key is deterministic, so a retried event job never sends twice.
// Recipients per decision D6, languages per D7, the P1 fan-out per D4.

export type EventResult = { skipped: string } | { deliveries: number; inApp: number };

const ms = (value: Date | string) => new Date(value).getTime();

function baseData(t: { subject: string; priority: Priority }): NotificationData {
  return { subject: t.subject, priority: t.priority };
}

/** The ticket's P1 Teams card, once per P1 period (D4). */
function p1Card(ctx: WorkerContext, t: TicketFactsRow, p1Since: Date, stepCount: number) {
  return {
    job: {
      dedupeKey: `p1card-${t.id}-${ms(p1Since)}`,
      channel: 'TEAMS' as const,
      template: 'P1_CREATED' as const,
      ticketId: t.id,
      teamId: t.teamId,
      context: {
        p1Since: p1Since.toISOString(),
        step: 1,
        ...(stepCount > 0 ? { stepCount } : {}),
      },
    },
    recipientMasked: ctx.teams.describe(t.team.teamsWebhookUrl),
  } satisfies PlannedDelivery;
}

async function loadMessage(ctx: WorkerContext, messageId: string, ticketId: string) {
  const message = await ctx.prisma.message.findUnique({
    where: { id: messageId },
    select: {
      ticketId: true,
      type: true,
      author: { select: { id: true, name: true, role: true } },
    },
  });
  // Only PUBLIC messages of this ticket ever produce a notification (never an internal note).
  return message && message.ticketId === ticketId && message.type === 'PUBLIC' ? message : null;
}

export async function processNotificationEvent(
  ctx: WorkerContext,
  event: NotificationEvent,
): Promise<EventResult> {
  const t = await loadTicketFacts(ctx.prisma, event.ticketId);
  if (!t) return { skipped: 'ticket-gone' };
  const deliveries: PlannedDelivery[] = [];
  const inApp: PlannedInApp[] = [];

  switch (event.event) {
    case 'ticket-created': {
      // The client's acknowledgement (staff-created tickets too, D6), in their language.
      if (t.requester.status === 'ACTIVE') {
        deliveries.push({
          job: {
            dedupeKey: `tc-${t.id}-client-${t.requester.id}`,
            channel: 'EMAIL',
            template: 'TICKET_CREATED_CLIENT',
            ticketId: t.id,
            userId: t.requester.id,
          },
          recipientMasked: t.requester.email,
        });
      }
      // Handed out by skill (docs/AUTO_ASSIGN.md): tell the person who got it, in-app. Someone who
      // took the ticket themselves isn't told about it.
      if (t.assigneeId) {
        const handedOut = await ctx.prisma.ticketEvent.findFirst({
          where: {
            ticketId: t.id,
            type: 'ASSIGNEE_CHANGED',
            toValue: t.assigneeId,
            meta: { path: ['auto'], equals: true },
          },
          select: { id: true },
        });
        const assignee = handedOut ? await activeStaff(ctx.prisma, t.assigneeId) : null;
        if (assignee) {
          inApp.push({
            userId: assignee.id,
            type: 'TICKET_ASSIGNED',
            ticketId: t.id,
            data: baseData(t),
            dedupeKey: `tc-${t.id}-assigned-${assignee.id}`,
          });
        }
      }
      // The team's distribution list, except P4 (daily digest, D9).
      if (t.priority !== 'P4') {
        for (const address of listAddresses(t.team.emails)) {
          deliveries.push({
            job: {
              dedupeKey: `tc-${t.id}-list-${keyHash(address)}`,
              channel: 'EMAIL',
              template: 'TICKET_CREATED_TEAM',
              ticketId: t.id,
              teamId: t.teamId,
              address,
            },
            recipientMasked: address,
          });
        }
      }
      // A P1: one Teams card (escalation step 1 pages the on-call user, D4).
      if (t.priority === 'P1' && t.p1Since && !t.p1AckedAt) {
        const chain = await loadP1Chain(ctx.prisma, t.teamId);
        deliveries.push(p1Card(ctx, t, t.p1Since, chain.length));
      }
      break;
    }

    case 'p1-started': {
      // An upgrade to P1: the list gets the P1 alert (the ticket-created email went long ago).
      if (t.priority !== 'P1' || t.p1AckedAt || !t.p1Since || ms(t.p1Since) !== ms(event.p1Since)) {
        return { skipped: 'p1-period-over' };
      }
      const chain = await loadP1Chain(ctx.prisma, t.teamId);
      const first = chain[0];
      const next = first ? nextRule(chain, first.step) : null;
      for (const address of listAddresses(t.team.emails)) {
        deliveries.push({
          job: {
            dedupeKey: `p1list-${t.id}-${ms(t.p1Since)}-${keyHash(address)}`,
            channel: 'EMAIL',
            template: 'P1_ALERT',
            ticketId: t.id,
            teamId: t.teamId,
            address,
            context: {
              p1Since: t.p1Since.toISOString(),
              step: 1,
              // Never negative: a chain whose delays go down fires the next step at once.
              ...(first && next
                ? { escalationMins: Math.max(0, next.afterMins - first.afterMins) }
                : {}),
            },
          },
          recipientMasked: address,
        });
      }
      deliveries.push(p1Card(ctx, t, t.p1Since, chain.length));
      break;
    }

    case 'agent-reply': {
      const message = await loadMessage(ctx, event.messageId, t.id);
      if (!message || !message.author || message.author.role === 'CLIENT') {
        return { skipped: 'not-a-staff-public-reply' };
      }
      if (t.requester.status === 'ACTIVE' && t.requester.id !== message.author.id) {
        deliveries.push({
          job: {
            dedupeKey: `ar-${event.messageId}-${t.requester.id}`,
            channel: 'EMAIL',
            template: 'AGENT_REPLY_CLIENT',
            ticketId: t.id,
            userId: t.requester.id,
            context: { messageId: event.messageId },
          },
          recipientMasked: t.requester.email,
        });
      }
      break;
    }

    case 'client-reply': {
      const message = await loadMessage(ctx, event.messageId, t.id);
      if (!message || !message.author || message.author.role !== 'CLIENT') {
        return { skipped: 'not-a-client-reply' };
      }
      const data: NotificationData = {
        ...baseData(t),
        actor: { id: message.author.id, name: message.author.name },
      };
      const assignee = await activeStaff(ctx.prisma, t.assigneeId);
      // Assigned: the assignee (in-app + email). Unassigned: the team's leads in-app and the
      // team list by email (D6).
      const people = assignee ? [assignee] : await teamLeads(ctx.prisma, t.teamId);
      for (const user of people) {
        inApp.push({
          userId: user.id,
          type: 'CLIENT_REPLY',
          ticketId: t.id,
          data,
          dedupeKey: `cr-${event.messageId}-inapp-${user.id}`,
        });
      }
      if (assignee) {
        deliveries.push({
          job: {
            dedupeKey: `cr-${event.messageId}-email-${assignee.id}`,
            channel: 'EMAIL',
            template: 'CLIENT_REPLY_ASSIGNEE',
            ticketId: t.id,
            userId: assignee.id,
            context: { messageId: event.messageId },
          },
          recipientMasked: assignee.email,
        });
      } else {
        for (const address of listAddresses(t.team.emails)) {
          deliveries.push({
            job: {
              dedupeKey: `cr-${event.messageId}-list-${keyHash(address)}`,
              channel: 'EMAIL',
              template: 'CLIENT_REPLY_ASSIGNEE',
              ticketId: t.id,
              teamId: t.teamId,
              address,
              context: { messageId: event.messageId },
            },
            recipientMasked: address,
          });
        }
      }
      break;
    }

    case 'p1-acknowledged': {
      const since = new Date(event.p1Since);
      const [notified, delivered, actor] = await Promise.all([
        ctx.prisma.notification.findMany({
          where: {
            ticketId: t.id,
            type: { in: ['P1_CREATED', 'P1_ESCALATED'] },
            createdAt: { gte: since },
          },
          select: { userId: true },
        }),
        ctx.prisma.notificationDelivery.findMany({
          where: {
            ticketId: t.id,
            userId: { not: null },
            templateKey: { in: ['P1_ALERT', 'P1_ESCALATION'] },
            createdAt: { gte: since },
          },
          select: { userId: true },
        }),
        ctx.prisma.user.findUnique({
          where: { id: event.actorId },
          select: { id: true, name: true },
        }),
      ]);
      const paged = new Set(
        [...notified.map((n) => n.userId), ...delivered.map((d) => d.userId)].filter(
          (id): id is string => Boolean(id) && id !== event.actorId,
        ),
      );
      for (const userId of paged) {
        if (!(await activeStaff(ctx.prisma, userId))) continue;
        inApp.push({
          userId,
          type: 'P1_ACKNOWLEDGED',
          ticketId: t.id,
          data: { ...baseData(t), ...(actor ? { actor } : {}) },
          dedupeKey: `p1ack-${t.id}-${ms(since)}-${userId}`,
        });
      }
      break;
    }

    case 'sla': {
      if (t.status === 'SOLVED' || t.status === 'CLOSED') return { skipped: 'ticket-done' };
      // Answered, paused or re-targeted since the scan raised it: nothing to announce.
      if (!slaAlertStillValid(t, event.target, new Date(event.dueAt))) {
        return { skipped: 'sla-target-met-or-moved' };
      }
      const type = event.kind === 'AT_RISK' ? 'SLA_AT_RISK' : 'SLA_BREACHED';
      const template = event.kind === 'AT_RISK' ? 'SLA_AT_RISK' : 'SLA_BREACHED';
      const key = `sla-${t.id}-${event.target}-${event.kind}-${ms(event.dueAt)}`;
      // Assignee + team leads; unassigned → leads only (D6).
      for (const user of await assigneeAndLeads(ctx.prisma, t)) {
        inApp.push({
          userId: user.id,
          type,
          ticketId: t.id,
          data: { ...baseData(t), target: event.target, dueAt: event.dueAt },
          dedupeKey: `${key}-inapp-${user.id}`,
        });
        deliveries.push({
          job: {
            dedupeKey: `${key}-email-${user.id}`,
            channel: 'EMAIL',
            template,
            ticketId: t.id,
            userId: user.id,
            context: { target: event.target, kind: event.kind, dueAt: event.dueAt },
          },
          recipientMasked: user.email,
        });
      }
      break;
    }
  }

  await queueDeliveries(ctx, deliveries);
  const created = await createInApp(ctx, inApp);
  return { deliveries: deliveries.length, inApp: created };
}
