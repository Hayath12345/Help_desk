import {
  adminTeamScope,
  canChangeTeamMember,
  canChangeTeamMemberRole,
  canEditTeamSettings,
  canManageMacros,
  canManageTeam,
  canMoveMacro,
  canSetTeamOnCall,
  isSuperAdmin,
  type Actor,
  type TeamMemberRole,
} from '@loons/shared';
import { errors } from '../../lib/errors.ts';

// Authorisation inside admin services (spec §5, decision E7). The route plugin already refused
// callers who may not open the section (403); these check the row being changed. A team lead
// acting on a team they don't lead gets 403 (the team exists; admin pages list it to super admins).

/** Super admin only (staff, settings, team settings, global macros…). */
export function requireSuperAdmin(actor: Actor): void {
  if (!isSuperAdmin(actor)) throw errors.forbidden('Only super admins can do this.');
}

/** The team's admin page: super admins, and team leads of that team. */
export function requireTeamAccess(actor: Actor, teamId: string): void {
  if (!canManageTeam(actor, teamId)) throw errors.forbidden('You do not lead this team.');
}

/** Names, email list, Teams webhook, archive / restore, order, create: super admins only. */
export function requireTeamSettings(actor: Actor): void {
  if (!canEditTeamSettings(actor)) throw errors.forbidden('Only super admins can change this.');
}

export function requireOnCallChange(actor: Actor, teamId: string): void {
  if (!canSetTeamOnCall(actor, teamId)) throw errors.forbidden('You do not lead this team.');
}

/** Adding / removing a member row with this membership role. */
export function requireMemberChange(
  actor: Actor,
  teamId: string,
  memberRole: TeamMemberRole,
): void {
  if (!canChangeTeamMember(actor, teamId, memberRole)) {
    throw errors.forbidden(
      memberRole === 'LEAD'
        ? 'Only super admins can change team leads.'
        : 'You do not lead this team.',
    );
  }
}

export function requireMemberRoleChange(actor: Actor): void {
  if (!canChangeTeamMemberRole(actor)) {
    throw errors.forbidden('Only super admins can change team leads.');
  }
}

/** Macros of `teamId` (null = global, super admins only). */
export function requireMacroAccess(actor: Actor, teamId: string | null): void {
  if (!canManageMacros(actor, teamId)) {
    throw errors.forbidden(
      teamId === null ? 'Only super admins manage global macros.' : 'You do not lead this team.',
    );
  }
}

/** Moving a macro between teams / global: super admins only (team leads: same team). */
export function requireMacroMove(actor: Actor, from: string | null, to: string | null): void {
  requireMacroAccess(actor, from);
  if (!canMoveMacro(actor, from, to)) {
    throw errors.forbidden('Only super admins can move a macro to another team.');
  }
}

/**
 * Prisma filter for "teams this actor may manage" on a team id column: undefined for super admins
 * (no filter), `{ in: leadTeamIds }` for team leads (possibly empty).
 */
export function teamScopeFilter(actor: Actor): { in: string[] } | undefined {
  const scope = adminTeamScope(actor);
  return scope === 'all' ? undefined : { in: [...scope] };
}
