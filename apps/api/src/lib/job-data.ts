import { z } from 'zod';
import { SLA_SIGNAL_KINDS, SLA_TARGETS } from '@loons/shared';

// Payloads of the Phase 3 queues (contract "Shared contracts": job payload schemas; an invalid
// payload fails with UnrecoverableError, never a retry) and their deterministic job ids. BullMQ
// forbids ":" in custom ids, so ids join their parts with "-".
//
// Every job carries ids only: the processors re-read the ticket, the users and the team when
// they run (a retry sees the current state), and no personal data sits in Redis — except the
// distribution-list address of a team email, which is not a person's.

const isoDate = z.iso.datetime({ offset: true });

// ───────────── notifications queue ─────────────

export const NOTIFICATION_JOBS = {
  /** A ticket event: resolves the recipients and fans out one `deliver` job per channel × recipient. */
  event: 'event',
  /** One email / Teams post / SMS (a `NotificationDelivery` row). */
  deliver: 'deliver',
} as const;

export const notificationEventSchema = z.discriminatedUnion('event', [
  /** Client acknowledgement, team list email (not P4), P1 Teams card. */
  z.object({ event: z.literal('ticket-created'), ticketId: z.uuid() }),
  /** A later upgrade to P1: team list P1 alert + Teams card (D4). */
  z.object({ event: z.literal('p1-started'), ticketId: z.uuid(), p1Since: isoDate }),
  /** Staff PUBLIC reply → the requester (email). */
  z.object({ event: z.literal('agent-reply'), ticketId: z.uuid(), messageId: z.uuid() }),
  /** Client reply → the assignee, or the team's leads + list when unassigned (D6). */
  z.object({ event: z.literal('client-reply'), ticketId: z.uuid(), messageId: z.uuid() }),
  /** In-app P1_ACKNOWLEDGED to everyone already paged in this P1 period. */
  z.object({
    event: z.literal('p1-acknowledged'),
    ticketId: z.uuid(),
    p1Since: isoDate,
    actorId: z.uuid(),
  }),
  /** SLA at risk / breached (only fresh crossings, D10) → assignee + team leads (D6). */
  z.object({
    event: z.literal('sla'),
    ticketId: z.uuid(),
    target: z.enum(SLA_TARGETS),
    kind: z.enum(SLA_SIGNAL_KINDS),
    dueAt: isoDate,
  }),
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

const ms = (iso: string) => new Date(iso).getTime();

/** Deterministic job id of an event (a second enqueue of the same event is a no-op). */
export function notificationEventJobId(event: NotificationEvent): string {
  switch (event.event) {
    case 'ticket-created':
      return `ticket-created-${event.ticketId}`;
    case 'p1-started':
      return `p1-started-${event.ticketId}-${ms(event.p1Since)}`;
    case 'agent-reply':
    case 'client-reply':
      return `${event.event}-${event.messageId}`;
    case 'p1-acknowledged':
      return `p1-ack-${event.ticketId}-${ms(event.p1Since)}`;
    case 'sla':
      return `sla-${event.ticketId}-${event.target}-${event.kind}-${ms(event.dueAt)}`;
  }
}

/** Email template keys, plus the Teams / SMS message kinds, a delivery can carry. */
export const DELIVERY_TEMPLATES = [
  'TICKET_CREATED_CLIENT',
  'TICKET_CREATED_TEAM',
  'AGENT_REPLY_CLIENT',
  'CLIENT_REPLY_ASSIGNEE',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'P1_ALERT',
  'P1_ESCALATION',
  'P4_DAILY_DIGEST',
  /** Teams cards (D4). */
  'P1_CREATED',
  'P1_ESCALATED',
] as const;
export type DeliveryTemplate = (typeof DELIVERY_TEMPLATES)[number];

export const deliveryJobSchema = z.object({
  /** `NotificationDelivery.dedupeKey` (the row is created before the job). */
  dedupeKey: z.string().min(1).max(200),
  channel: z.enum(['EMAIL', 'TEAMS', 'SMS']),
  template: z.enum(DELIVERY_TEMPLATES),
  ticketId: z.uuid().optional(),
  /** A person (their current address / phone / locale are read when sending). */
  userId: z.uuid().optional(),
  /** Team-level: distribution list, Teams channel, digest. */
  teamId: z.uuid().optional(),
  /** A distribution-list address (team emails are English and greeting-less, D7). */
  address: z.email().optional(),
  context: z
    .object({
      messageId: z.uuid().optional(),
      target: z.enum(SLA_TARGETS).optional(),
      kind: z.enum(SLA_SIGNAL_KINDS).optional(),
      dueAt: isoDate.optional(),
      /** The P1 period the alert belongs to (skipped once it is acknowledged or ended). */
      p1Since: isoDate.optional(),
      step: z.number().int().positive().optional(),
      stepCount: z.number().int().positive().optional(),
      /** Minutes until the next escalation step (P1_ALERT). */
      escalationMins: z.number().int().nonnegative().optional(),
      /** Digest window [windowStart, windowEnd) and its local date. */
      windowStart: isoDate.optional(),
      windowEnd: isoDate.optional(),
      digestDate: z.iso.date().optional(),
    })
    .default({}),
});
export type DeliveryJob = z.infer<typeof deliveryJobSchema>;
export type DeliveryJobInput = z.input<typeof deliveryJobSchema>;

export function deliveryJobId(dedupeKey: string): string {
  return `dl-${dedupeKey}`;
}

// ───────────── escalation queue ─────────────

export const ESCALATION_JOB = 'step';

/** One step of the P1 chain (D3), delayed until `p1Since + afterMins`. */
export const escalationJobSchema = z.object({
  ticketId: z.uuid(),
  /** The P1 period it belongs to: a later period (re-upgrade) never runs this job's steps. */
  p1Since: isoDate,
  step: z.number().int().positive(),
});
export type EscalationJob = z.infer<typeof escalationJobSchema>;

/** `p1-esc-<ticketId>-<p1SinceMs>-<step>` (contract). */
export function escalationJobId(ticketId: string, p1Since: Date | string, step: number): string {
  return `p1-esc-${ticketId}-${new Date(p1Since).getTime()}-${step}`;
}

// ───────────── sla queue ─────────────

export const SLA_JOBS = {
  scan: 'sla-scan',
  autoClose: 'auto-close',
  digest: 'p4-digest',
  orphanSweep: 'orphan-sweep',
  retention: 'retention',
} as const;
export type SlaJobName = (typeof SLA_JOBS)[keyof typeof SLA_JOBS];

export const slaJobSchema = z
  .object({
    /**
     * Only these teams' tickets (tests scope the database-wide jobs to their own fixtures; the
     * schedulers never set it).
     */
    teamIds: z.array(z.uuid()).max(100).optional(),
  })
  .default({});
export type SlaJob = z.infer<typeof slaJobSchema>;
