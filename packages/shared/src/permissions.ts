// Authorisation rules (§5 of the build spec). The API and the socket server enforce these;
// the web app uses them only to hide controls the user could not use anyway.

import { isStaffRole } from './auth.ts';
import type { Role, TeamMemberRole, UserStatus } from './enums.ts';

/** The authenticated principal, as loaded from the database by the API on every request. */
export interface Actor {
  id: string;
  role: Role;
  status: UserStatus;
  /** Set for CLIENT users only. */
  orgId: string | null;
  /** Teams the user belongs to (any membership role). */
  teamIds: readonly string[];
  /** Teams where the user is a LEAD member. Only meaningful for TEAM_LEAD. */
  leadTeamIds: readonly string[];
  /** Mailbox ownership proven. Unverified clients are treated like pending ones (no data access). */
  emailVerified: boolean;
}

/** The subset of a ticket needed to decide access. */
export interface TicketScope {
  orgId: string;
  teamId: string;
  assigneeId: string | null;
}

/**
 * Admin sections (`/admin/<section>`), in navigation order (decision E8): each group of
 * ADMIN_SECTION_GROUPS in turn. The API serves each under `/admin/<section>`.
 */
export const ADMIN_SECTIONS = [
  'categories',
  'custom-fields',
  'macros',
  'sla',
  'business-hours',
  'escalation',
  'teams',
  'staff',
  'clients',
  'email-templates',
  'help-center',
  'settings',
  'audit-log',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * The admin navigation (E8): small group headings, each with its sections in order. Every section
 * is in exactly one group, and the groups list them in ADMIN_SECTIONS order.
 */
export const ADMIN_SECTION_GROUPS = [
  { key: 'ticket-setup', sections: ['categories', 'custom-fields', 'macros'] },
  { key: 'sla-escalation', sections: ['sla', 'business-hours', 'escalation'] },
  { key: 'people', sections: ['teams', 'staff', 'clients'] },
  { key: 'communication', sections: ['email-templates', 'help-center'] },
  { key: 'system', sections: ['settings', 'audit-log'] },
] as const satisfies ReadonlyArray<{ key: string; sections: readonly AdminSection[] }>;
export type AdminSectionGroup = (typeof ADMIN_SECTION_GROUPS)[number]['key'];

/** The navigation group of each section. */
export const ADMIN_SECTION_GROUP = Object.fromEntries(
  ADMIN_SECTION_GROUPS.flatMap((g) => g.sections.map((s) => [s, g.key])),
) as Record<AdminSection, AdminSectionGroup>;

/**
 * Sections a TEAM_LEAD may open (decision E7), scoped to the teams they lead inside each section:
 * members and on-call of their teams, and their teams' macros.
 */
export const TEAM_LEAD_ADMIN_SECTIONS: readonly AdminSection[] = ['teams', 'macros'];

/**
 * The account may use the app: status ACTIVE and, for clients, a verified email address. A client
 * who signed up with an address on an organisation's domain must prove they own it before they can
 * see that organisation's data (tenant isolation, spec §5).
 */
export function isActive(actor: Actor): boolean {
  if (actor.status !== 'ACTIVE') return false;
  return actor.role !== 'CLIENT' || actor.emailVerified;
}

export function isStaff(actor: Actor): boolean {
  return isActive(actor) && isStaffRole(actor.role);
}

export function isSuperAdmin(actor: Actor): boolean {
  return isActive(actor) && actor.role === 'SUPER_ADMIN';
}

export function isClient(actor: Actor): boolean {
  return isActive(actor) && actor.role === 'CLIENT' && actor.orgId !== null;
}

// ───────────── Tickets ─────────────

/**
 * Clients: tickets of their own organisation.
 * Agents / team leads: tickets of their teams, plus tickets assigned to them.
 * Super admins: everything.
 */
export function canViewTicket(actor: Actor, ticket: TicketScope): boolean {
  if (!isActive(actor)) return false;
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return true;
    case 'AGENT':
    case 'TEAM_LEAD':
      return actor.teamIds.includes(ticket.teamId) || ticket.assigneeId === actor.id;
    case 'CLIENT':
      return actor.orgId !== null && actor.orgId === ticket.orgId;
  }
}

/** Clients raise tickets for their own organisation; staff may raise them on a client's behalf. */
export function canCreateTicketForOrg(actor: Actor, orgId: string): boolean {
  if (isStaff(actor)) return true;
  return isClient(actor) && actor.orgId === orgId;
}

export function canReplyPublic(actor: Actor, ticket: TicketScope): boolean {
  return canViewTicket(actor, ticket);
}

export function canSeeInternalNotes(actor: Actor): boolean {
  return isStaff(actor);
}

export function canAddInternalNote(actor: Actor, ticket: TicketScope): boolean {
  return isStaff(actor) && canViewTicket(actor, ticket);
}

/** Status / priority / assignee / category changes. */
export function canUpdateTicket(actor: Actor, ticket: TicketScope): boolean {
  return isStaff(actor) && canViewTicket(actor, ticket);
}

/** Clients may mark their own organisation's tickets solved. */
export function canMarkSolved(actor: Actor, ticket: TicketScope): boolean {
  return canViewTicket(actor, ticket);
}

export function canAttachFiles(actor: Actor, ticket: TicketScope): boolean {
  return canViewTicket(actor, ticket);
}

export function canAcknowledgeP1(actor: Actor, ticket: TicketScope): boolean {
  return isStaff(actor) && canViewTicket(actor, ticket);
}

// ───────────── Teams & admin ─────────────

export function leadsTeam(actor: Actor, teamId: string): boolean {
  return isActive(actor) && actor.role === 'TEAM_LEAD' && actor.leadTeamIds.includes(teamId);
}

/**
 * A team's admin page: super admins, and team leads for the teams they lead (who only manage its
 * MEMBER rows and on-call user there, see canChangeTeamMember / canSetTeamOnCall /
 * canEditTeamSettings).
 */
export function canManageTeam(actor: Actor, teamId: string): boolean {
  return isSuperAdmin(actor) || leadsTeam(actor, teamId);
}

/** `teamId === null` means a global macro, which only super admins manage. */
export function canManageMacros(actor: Actor, teamId: string | null): boolean {
  if (isSuperAdmin(actor)) return true;
  return teamId !== null && leadsTeam(actor, teamId);
}

/**
 * Moving a macro between teams, or between a team and global (E7): super admins only. A team lead
 * may edit their team's macros but never move one elsewhere, so `from` must equal `to`.
 */
export function canMoveMacro(actor: Actor, from: string | null, to: string | null): boolean {
  if (isSuperAdmin(actor)) return true;
  return from === to && canManageMacros(actor, from);
}

/**
 * Teams whose admin data the actor may manage: every team for a super admin, the teams they lead
 * for a team lead (E7), none for anyone else. List endpoints filter with it.
 */
export function adminTeamScope(actor: Actor): 'all' | readonly string[] {
  if (isSuperAdmin(actor)) return 'all';
  if (isActive(actor) && actor.role === 'TEAM_LEAD') return actor.leadTeamIds;
  return [];
}

/**
 * Team settings a team lead may not touch (E7): names, the email list, the Teams webhook, archive
 * / restore, order, creating teams and LEAD membership changes. Super admins only.
 */
export function canEditTeamSettings(actor: Actor): boolean {
  return isSuperAdmin(actor);
}

/** Choosing the team's on-call user (a member with a valid phone; the API checks that). */
export function canSetTeamOnCall(actor: Actor, teamId: string): boolean {
  return canManageTeam(actor, teamId);
}

/**
 * Adding a member to a team, or removing one (E7). Team leads manage MEMBER rows of the teams they
 * lead; anything involving a LEAD row (adding or removing a lead) is super admin only.
 */
export function canChangeTeamMember(
  actor: Actor,
  teamId: string,
  memberRole: TeamMemberRole,
): boolean {
  if (isSuperAdmin(actor)) return true;
  return memberRole === 'MEMBER' && leadsTeam(actor, teamId);
}

/** Promoting a member to LEAD or demoting a lead (E7): super admins only. */
export function canChangeTeamMemberRole(actor: Actor): boolean {
  return isSuperAdmin(actor);
}

export function canAccessAdmin(actor: Actor): boolean {
  return isSuperAdmin(actor) || (isActive(actor) && actor.role === 'TEAM_LEAD');
}

export function canAccessAdminSection(actor: Actor, section: AdminSection): boolean {
  if (isSuperAdmin(actor)) return true;
  return (
    isActive(actor) && actor.role === 'TEAM_LEAD' && TEAM_LEAD_ADMIN_SECTIONS.includes(section)
  );
}

// ───────────── Staff accounts (E9) ─────────────

/** Statuses an admin may give a staff account (PENDING_APPROVAL is for client sign-ups only). */
export const STAFF_ACCOUNT_STATUSES = [
  'ACTIVE',
  'DISABLED',
] as const satisfies readonly UserStatus[];
export type StaffAccountStatus = (typeof STAFF_ACCOUNT_STATUSES)[number];

/** Staff accounts and their roles are managed by super admins only. */
export function canManageStaff(actor: Actor): boolean {
  return isSuperAdmin(actor);
}

/** Why a staff role / status change is refused (API error details and web hints). */
export const STAFF_CHANGE_PROBLEMS = ['self_role', 'self_disable', 'last_super_admin'] as const;
export type StaffChangeProblem = (typeof STAFF_CHANGE_PROBLEMS)[number];

/**
 * Checks a role / status change of a staff account (E9): nobody changes their own role or disables
 * themselves, and the last active super admin can't be demoted or disabled.
 * `activeSuperAdmins` counts ACTIVE super admins right now (the target included); the API counts
 * them under a lock in the same transaction, so two admins demoting each other can't both pass.
 */
export function staffChangeProblem(
  actor: Pick<Actor, 'id'>,
  target: { id: string; role: Role; status: UserStatus },
  next: { role?: Role | undefined; status?: UserStatus | undefined },
  activeSuperAdmins: number,
): StaffChangeProblem | null {
  const role = next.role ?? target.role;
  const status = next.status ?? target.status;
  const self = actor.id === target.id;
  if (self && role !== target.role) return 'self_role';
  if (self && status !== target.status && status !== 'ACTIVE') return 'self_disable';
  const wasActiveSuperAdmin = target.role === 'SUPER_ADMIN' && target.status === 'ACTIVE';
  const staysActiveSuperAdmin = role === 'SUPER_ADMIN' && status === 'ACTIVE';
  if (wasActiveSuperAdmin && !staysActiveSuperAdmin && activeSuperAdmins <= 1) {
    return 'last_super_admin';
  }
  return null;
}

/**
 * A role or status change revokes the user's sessions (E9): the API bumps `sessionVersion` in the
 * same transaction and calls `sessions.sessionsRevoked(userId)` after commit.
 */
export function staffChangeRevokesSessions(
  before: { role: Role; status: UserStatus },
  after: { role: Role; status: UserStatus },
): boolean {
  return before.role !== after.role || before.status !== after.status;
}

// ───────────── Realtime rooms ─────────────

export type RoomName =
  `ticket:${string}` | `ticket:${string}:staff` | `team:${string}` | `user:${string}`;

export const rooms = {
  ticket: (ticketId: string) => `ticket:${ticketId}` as const,
  ticketStaff: (ticketId: string) => `ticket:${ticketId}:staff` as const,
  team: (teamId: string) => `team:${teamId}` as const,
  user: (userId: string) => `user:${userId}` as const,
};

/**
 * Room-join rules. Ticket rooms need the ticket's scope, so the caller loads it first.
 * - ticket:{id}        → anyone who can view the ticket
 * - ticket:{id}:staff  → staff who can view the ticket (internal notes, staff typing)
 * - team:{id}          → members of the team, and super admins
 * - user:{id}          → only that user
 */
export function canJoinTicketRoom(actor: Actor, ticket: TicketScope): boolean {
  return canViewTicket(actor, ticket);
}

export function canJoinTicketStaffRoom(actor: Actor, ticket: TicketScope): boolean {
  return isStaff(actor) && canViewTicket(actor, ticket);
}

export function canJoinTeamRoom(actor: Actor, teamId: string): boolean {
  return isSuperAdmin(actor) || (isStaff(actor) && actor.teamIds.includes(teamId));
}

export function canJoinUserRoom(actor: Actor, userId: string): boolean {
  return isActive(actor) && actor.id === userId;
}
