// Turns a declarative demo ticket into concrete timestamps, messages and TicketEvents.
// Pure (no database access) so the data-integrity test can check every derived value.

import { formatTicketNumber } from '@loons/shared';
import type { MessageType, TicketEventType } from '../../src/generated/prisma/enums.ts';
import type { DemoTicketSeed } from './demo.ts';
import type { SlaPolicySeed } from './sla.ts';
import { MINUTE_MS } from './util.ts';

export interface TimelineMessage {
  /** Deterministic idempotency key, e.g. "seed:LG-4817:1". */
  clientTempId: string;
  type: MessageType;
  authorEmail: string;
  body: string;
  createdAt: Date;
}

export interface TimelineEvent {
  type: TicketEventType;
  /** Null for system events (SLA worker). */
  actorEmail: string | null;
  fromValue: string | null;
  toValue: string | null;
  /** For ASSIGNEE_CHANGED: the new assignee (toValue becomes their user id). */
  toUserEmail?: string;
  /** For FIRST_REPLY: the reply message (meta.messageId is filled in once it exists). */
  messageClientTempId?: string;
  meta: Record<string, string | number | string[]> | null;
  createdAt: Date;
}

export interface TicketTimeline {
  createdAt: Date;
  updatedAt: Date;
  firstReplyDueAt: Date;
  resolveDueAt: Date;
  firstRepliedAt: Date | null;
  solvedAt: Date | null;
  slaPausedAt: Date | null;
  slaAtRiskAt: Date | null;
  slaBreached: boolean;
  slaBreachedAt: Date | null;
  p1AckedAt: Date | null;
  p1AckedByEmail: string | null;
  lastMessageAt: Date | null;
  messages: TimelineMessage[];
  events: TimelineEvent[];
}

export function seedClientTempId(ticketNumber: number, index: number): string {
  return `seed:${formatTicketNumber(ticketNumber)}:${index + 1}`;
}

const ago = (now: number, minutes: number, offsetMs = 0) =>
  new Date(now - minutes * MINUTE_MS + offsetMs);

export function buildTicketTimeline(
  ticket: DemoTicketSeed,
  now: number,
  policies: readonly SlaPolicySeed[],
): TicketTimeline {
  const policy = policies.find((p) => p.priority === ticket.priority);
  if (!policy) throw new Error(`No SLA policy for ${ticket.priority}`);

  const createdAt = ago(now, ticket.createdAgoMin);
  // Calendar-time approximation of the SLA targets; the SLA engine (phase 3) recomputes them
  // with business hours and holidays.
  const firstReplyDueAt =
    ticket.firstReplyDueInMin === null
      ? new Date(createdAt.getTime() + policy.firstReplyMins * MINUTE_MS)
      : new Date(now + ticket.firstReplyDueInMin * MINUTE_MS);
  const resolveDueAt = new Date(createdAt.getTime() + policy.resolveMins * MINUTE_MS);

  const messages: TimelineMessage[] = ticket.messages.map((m, i) => {
    const authorEmail = m.kind === 'customer' ? ticket.requesterEmail : m.authorEmail;
    if (!authorEmail)
      throw new Error(`${formatTicketNumber(ticket.number)}: message ${i + 1} has no author`);
    return {
      clientTempId: seedClientTempId(ticket.number, i),
      type: m.kind === 'note' ? 'INTERNAL' : 'PUBLIC',
      authorEmail,
      body: m.body,
      createdAt: ago(now, m.agoMin),
    };
  });

  const firstReply = messages.find(
    (m, i) => m.type === 'PUBLIC' && ticket.messages[i]?.kind === 'agent',
  );

  const events: TimelineEvent[] = [
    {
      type: 'CREATED',
      actorEmail: ticket.requesterEmail,
      fromValue: null,
      toValue: 'NEW',
      meta: {
        priority: ticket.priority,
        type: ticket.type,
        category: ticket.categoryKey,
        subtype: ticket.subtypeKey,
        channel: 'PORTAL',
      },
      createdAt,
    },
  ];

  let p1AckedAt: Date | null = null;
  let p1AckedByEmail: string | null = null;
  let solvedAt: Date | null = null;
  let slaPausedAt: Date | null = null;

  // Actions sharing a minute keep their listed order (1 s apart).
  for (const [i, a] of ticket.activity.entries()) {
    const at = ago(now, a.agoMin, i * 1000);
    switch (a.type) {
      case 'P1_ACKNOWLEDGED':
        p1AckedAt = at;
        p1AckedByEmail = a.byEmail;
        events.push({
          type: 'P1_ACKNOWLEDGED',
          actorEmail: a.byEmail,
          fromValue: null,
          toValue: null,
          meta: {
            minutesToAcknowledge: Math.round((at.getTime() - createdAt.getTime()) / MINUTE_MS),
          },
          createdAt: at,
        });
        break;
      case 'ASSIGNEE_CHANGED':
        events.push({
          type: 'ASSIGNEE_CHANGED',
          actorEmail: a.byEmail,
          fromValue: null,
          toValue: null,
          toUserEmail: a.toEmail,
          meta: null,
          createdAt: at,
        });
        break;
      case 'STATUS_CHANGED':
        if (a.to === 'SOLVED') solvedAt = at;
        slaPausedAt = a.to === 'PENDING' ? at : null;
        events.push({
          type: 'STATUS_CHANGED',
          actorEmail: a.byEmail,
          fromValue: a.from,
          toValue: a.to,
          meta: null,
          createdAt: at,
        });
        break;
      case 'TAGS_CHANGED':
        events.push({
          type: 'TAGS_CHANGED',
          actorEmail: a.byEmail,
          fromValue: null,
          toValue: ticket.tags.join(','),
          meta: { added: [...ticket.tags], removed: [] },
          createdAt: at,
        });
        break;
    }
  }

  if (firstReply) {
    events.push({
      type: 'FIRST_REPLY',
      actorEmail: firstReply.authorEmail,
      fromValue: null,
      toValue: null,
      messageClientTempId: firstReply.clientTempId,
      meta: {
        minutesToFirstReply: Math.round(
          (firstReply.createdAt.getTime() - createdAt.getTime()) / MINUTE_MS,
        ),
      },
      createdAt: firstReply.createdAt,
    });
  }

  // SLA events as the SLA worker would have raised them by now (at risk at atRiskPercent of the
  // window, breached at 100 %), for both the first-reply and the resolution targets. The events are
  // history; on the ticket, `slaAtRiskAt` only flags a target that is still open, while a breach
  // stays recorded (`slaBreached`) even after the target is met.
  let slaAtRiskAt: Date | null = null;
  let slaBreachedAt: Date | null = null;
  const targets = [
    { target: 'FIRST_REPLY', dueAt: firstReplyDueAt, metAt: firstReply?.createdAt ?? null },
    { target: 'RESOLUTION', dueAt: resolveDueAt, metAt: solvedAt },
  ];
  for (const { target, dueAt, metAt } of targets) {
    const stopAt = Math.min(metAt?.getTime() ?? now, now);
    const windowMs = dueAt.getTime() - createdAt.getTime();
    const atRiskAt = new Date(createdAt.getTime() + (windowMs * policy.atRiskPercent) / 100);
    if (atRiskAt.getTime() <= stopAt) {
      if (!metAt) slaAtRiskAt ??= atRiskAt;
      events.push({
        type: 'SLA_AT_RISK',
        actorEmail: null,
        fromValue: null,
        toValue: null,
        meta: { target, dueAt: dueAt.toISOString() },
        createdAt: atRiskAt,
      });
    }
    if (dueAt.getTime() <= stopAt) {
      slaBreachedAt ??= dueAt;
      events.push({
        type: 'SLA_BREACHED',
        actorEmail: null,
        fromValue: null,
        toValue: null,
        meta: { target, dueAt: dueAt.toISOString() },
        createdAt: dueAt,
      });
    }
  }

  events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const lastMessageAt = messages.reduce<Date | null>(
    (latest, m) => (!latest || m.createdAt > latest ? m.createdAt : latest),
    null,
  );
  const updatedAt = new Date(
    Math.max(
      createdAt.getTime(),
      ...messages.map((m) => m.createdAt.getTime()),
      ...events.map((e) => e.createdAt.getTime()),
    ),
  );

  return {
    createdAt,
    updatedAt,
    firstReplyDueAt,
    resolveDueAt,
    firstRepliedAt: firstReply?.createdAt ?? null,
    solvedAt,
    slaPausedAt: ticket.status === 'PENDING' ? slaPausedAt : null,
    slaAtRiskAt,
    slaBreached: slaBreachedAt !== null,
    slaBreachedAt,
    p1AckedAt,
    p1AckedByEmail,
    lastMessageAt,
    messages,
    events,
  };
}
