import type { Prisma, PrismaClient } from '@loons/db';
import { STAFF_ROLES, formatTicketNumber } from '@loons/shared';
import { EMPTY_VALUE, type TicketFacts } from '@loons/emails';
import type { EscalationRuleRow } from '../lib/escalation.ts';
import { normalizeE164 } from '../lib/phone.ts';
import { maskPhone } from '../lib/pii.ts';

// Who gets what (decision D6) and the ticket facts every message is rendered from. Always read
// when the job runs: a retry or a delayed step sees the current assignee, leads and on-call user.

export const recipientSelect = {
  id: true,
  name: true,
  email: true,
  locale: true,
  phone: true,
  role: true,
  status: true,
} as const satisfies Prisma.UserSelect;

export type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;

const ACTIVE_STAFF: Prisma.UserWhereInput = { status: 'ACTIVE', role: { in: [...STAFF_ROLES] } };

/** An active staff member by id (null when disabled, pending, a client or gone). */
export async function activeStaff(
  db: PrismaClient,
  userId: string | null,
): Promise<Recipient | null> {
  if (!userId) return null;
  return db.user.findFirst({ where: { id: userId, ...ACTIVE_STAFF }, select: recipientSelect });
}

/** "Team lead" = TeamMember.role LEAD of the team (D6), active staff only. */
export async function teamLeads(db: PrismaClient, teamId: string): Promise<Recipient[]> {
  const rows = await db.teamMember.findMany({
    where: { teamId, role: 'LEAD', user: ACTIVE_STAFF },
    orderBy: { createdAt: 'asc' },
    select: { user: { select: recipientSelect } },
  });
  return rows.map((r) => r.user);
}

/** Assignee (when active staff) + the team's leads, without duplicates; unassigned → leads (D6). */
export async function assigneeAndLeads(
  db: PrismaClient,
  ticket: { teamId: string; assigneeId: string | null },
): Promise<Recipient[]> {
  const [assignee, leads] = await Promise.all([
    activeStaff(db, ticket.assigneeId),
    teamLeads(db, ticket.teamId),
  ]);
  const out = assignee ? [assignee] : [];
  for (const lead of leads) if (!out.some((r) => r.id === lead.id)) out.push(lead);
  return out;
}

/**
 * The people an escalation rule pages: ON_CALL → the team's on-call user; ROLE → TEAM_LEAD means
 * the team's leads (D6), SUPER_ADMIN every active super admin, another role the team's members
 * with that role; USER → that user. Inactive users are never paged.
 */
export async function escalationTargets(
  db: PrismaClient,
  rule: EscalationRuleRow,
  team: { id: string; onCallUserId: string | null },
): Promise<Recipient[]> {
  switch (rule.targetType) {
    case 'ON_CALL': {
      const user = await activeStaff(db, team.onCallUserId);
      return user ? [user] : [];
    }
    case 'USER': {
      const user = await activeStaff(db, rule.targetUserId);
      return user ? [user] : [];
    }
    case 'ROLE': {
      if (rule.targetRole === 'TEAM_LEAD') return teamLeads(db, team.id);
      if (rule.targetRole === 'SUPER_ADMIN') {
        return db.user.findMany({
          where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: recipientSelect,
        });
      }
      if (!rule.targetRole || rule.targetRole === 'CLIENT') return [];
      const rows = await db.teamMember.findMany({
        where: { teamId: team.id, user: { status: 'ACTIVE', role: rule.targetRole } },
        select: { user: { select: recipientSelect } },
      });
      return rows.map((r) => r.user);
    }
  }
}

/** What a phone delivery records: the E.164 number masked (or "—" without a usable number). */
export function maskedPhoneOf(phone: string | null): string {
  const e164 = normalizeE164(phone);
  return e164 ? maskPhone(e164) : EMPTY_VALUE;
}

// ───────────── Ticket facts ─────────────

export const ticketFactsSelect = {
  id: true,
  number: true,
  subject: true,
  type: true,
  priority: true,
  status: true,
  description: true,
  assetId: true,
  createdAt: true,
  firstReplyDueAt: true,
  firstRepliedAt: true,
  resolveDueAt: true,
  p1Since: true,
  p1AckedAt: true,
  teamId: true,
  orgId: true,
  requesterId: true,
  assigneeId: true,
  team: {
    select: {
      id: true,
      nameEn: true,
      nameAr: true,
      emails: true,
      teamsWebhookUrl: true,
      onCallUserId: true,
    },
  },
  category: { select: { labelEn: true, labelAr: true } },
  subtype: { select: { labelEn: true, labelAr: true } },
  org: { select: { name: true, nameAr: true } },
  site: { select: { name: true, nameAr: true } },
  requester: { select: recipientSelect },
  assignee: { select: { id: true, name: true } },
} as const satisfies Prisma.TicketSelect;

export type TicketFactsRow = Prisma.TicketGetPayload<{ select: typeof ticketFactsSelect }>;

export function loadTicketFacts(
  db: PrismaClient,
  ticketId: string,
): Promise<TicketFactsRow | null> {
  return db.ticket.findUnique({ where: { id: ticketId }, select: ticketFactsSelect });
}

/** The row as `@loons/emails` ticket facts (names in both languages). */
export function factsOf(t: TicketFactsRow): TicketFacts {
  return {
    number: t.number,
    subject: t.subject,
    type: t.type,
    priority: t.priority,
    status: t.status,
    teamName: { en: t.team.nameEn, ar: t.team.nameAr },
    categoryName: { en: t.category.labelEn, ar: t.category.labelAr },
    subtypeName: t.subtype ? { en: t.subtype.labelEn, ar: t.subtype.labelAr } : null,
    orgName: { en: t.org.name, ar: t.org.nameAr },
    requesterName: t.requester.name,
    siteName: t.site ? { en: t.site.name, ar: t.site.nameAr } : null,
    assetId: t.assetId,
    assigneeName: t.assignee?.name ?? null,
    createdAt: t.createdAt,
    firstReplyDueAt: t.firstReplyDueAt,
    description: t.description,
  };
}

/**
 * Whether an SLA alert still describes the ticket: the target is still running (first reply not
 * sent; resolution not paused by PENDING, ticket not solved / closed) and its due date is the one
 * the alert was raised for. A queued or retried alert is dropped once the agent has answered or
 * the due date moved (the scan raises a new signal for a moved due date).
 */
export function slaAlertStillValid(
  t: Pick<TicketFactsRow, 'status' | 'firstRepliedAt' | 'firstReplyDueAt' | 'resolveDueAt'>,
  target: 'FIRST_REPLY' | 'RESOLUTION',
  dueAt: Date,
): boolean {
  if (t.status === 'SOLVED' || t.status === 'CLOSED') return false;
  if (target === 'FIRST_REPLY') {
    return !t.firstRepliedAt && t.firstReplyDueAt?.getTime() === dueAt.getTime();
  }
  return t.status !== 'PENDING' && t.resolveDueAt?.getTime() === dueAt.getTime();
}

/** Distinct, lower-cased distribution-list addresses of a team. */
export function listAddresses(emails: readonly string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];
}

/** "LG-4821" (for logs and dedupe keys never; for messages only). */
export const ticketRef = (t: { number: number }) => formatTicketNumber(t.number);
