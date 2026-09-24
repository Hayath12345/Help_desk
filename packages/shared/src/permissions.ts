// Authorisation rules (§5 of the build spec). The API and the socket server enforce these;
// the web app uses them only to hide controls the user could not use anyway.

import { isStaffRole } from './auth.ts';
import type { Role, UserStatus } from './enums.ts';

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

export const ADMIN_SECTIONS = [
  'categories',
  'custom-fields',
  'teams',
  'sla',
  'business-hours',
  'escalation',
  'clients',
  'macros',
  'email-templates',
  'help-center',
  'audit-log',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** Sections a TEAM_LEAD may open (scoped to their own teams inside each section). */
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

/** Team members and team settings. */
export function canManageTeam(actor: Actor, teamId: string): boolean {
  return isSuperAdmin(actor) || leadsTeam(actor, teamId);
}

/** `teamId === null` means a global macro, which only super admins manage. */
export function canManageMacros(actor: Actor, teamId: string | null): boolean {
  if (isSuperAdmin(actor)) return true;
  return teamId !== null && leadsTeam(actor, teamId);
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
