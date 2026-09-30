import { describe, expect, it } from 'vitest';
import {
  ADMIN_SECTIONS,
  ADMIN_SECTION_GROUP,
  ADMIN_SECTION_GROUPS,
  TEAM_LEAD_ADMIN_SECTIONS,
  adminTeamScope,
  canAccessAdminSection,
  canChangeTeamMember,
  canChangeTeamMemberRole,
  canEditTeamSettings,
  canManageStaff,
  canMoveMacro,
  canSetTeamOnCall,
  staffChangeProblem,
  staffChangeRevokesSessions,
  type Actor,
} from './permissions.ts';

const SOC = '00000000-0000-4000-8000-0000000000c1';
const NOC = '00000000-0000-4000-8000-0000000000c2';

const actor = (over: Partial<Actor>): Actor => ({
  id: 'u-' + (over.role ?? 'x'),
  role: 'CLIENT',
  status: 'ACTIVE',
  orgId: null,
  teamIds: [],
  leadTeamIds: [],
  emailVerified: true,
  ...over,
});

const superAdmin = actor({ id: 'sa', role: 'SUPER_ADMIN' });
const lead = actor({ id: 'tl', role: 'TEAM_LEAD', teamIds: [SOC, NOC], leadTeamIds: [SOC] });
/** LEAD membership without the TEAM_LEAD role grants nothing in admin. */
const agentLead = actor({ id: 'ag', role: 'AGENT', teamIds: [SOC], leadTeamIds: [SOC] });
const disabledLead = { ...lead, status: 'DISABLED' as const };

describe('admin navigation (E8)', () => {
  it('lists the thirteen sections in group order, each in exactly one group', () => {
    expect(ADMIN_SECTIONS).toHaveLength(13);
    expect(ADMIN_SECTION_GROUPS.flatMap((g) => g.sections)).toEqual([...ADMIN_SECTIONS]);
    expect(ADMIN_SECTION_GROUPS.map((g) => g.key)).toEqual([
      'ticket-setup',
      'sla-escalation',
      'people',
      'communication',
      'system',
    ]);
    for (const section of ADMIN_SECTIONS) {
      const group = ADMIN_SECTION_GROUPS.find((g) => g.key === ADMIN_SECTION_GROUP[section]);
      expect(group?.sections as readonly string[]).toContain(section);
    }
    expect(ADMIN_SECTION_GROUP.staff).toBe('people');
    expect(ADMIN_SECTION_GROUP.settings).toBe('system');
  });

  it('team leads open Teams and Macros only; staff and settings are super admin only', () => {
    expect(TEAM_LEAD_ADMIN_SECTIONS).toEqual(['teams', 'macros']);
    for (const section of ADMIN_SECTIONS) {
      expect(canAccessAdminSection(superAdmin, section)).toBe(true);
      expect(canAccessAdminSection(lead, section)).toBe(
        section === 'teams' || section === 'macros',
      );
      expect(canAccessAdminSection(agentLead, section)).toBe(false);
      expect(canAccessAdminSection(disabledLead, section)).toBe(false);
    }
  });
});

describe('Team Lead scope (E7)', () => {
  it('team scope: every team for super admins, lead teams for team leads, none otherwise', () => {
    expect(adminTeamScope(superAdmin)).toBe('all');
    expect(adminTeamScope(lead)).toEqual([SOC]);
    expect(adminTeamScope(agentLead)).toEqual([]);
    expect(adminTeamScope(disabledLead)).toEqual([]);
  });

  it('members: team leads add / remove MEMBER rows of the teams they lead only', () => {
    expect(canChangeTeamMember(lead, SOC, 'MEMBER')).toBe(true);
    expect(canChangeTeamMember(lead, SOC, 'LEAD')).toBe(false);
    expect(canChangeTeamMember(lead, NOC, 'MEMBER')).toBe(false); // member, not lead, of NOC
    expect(canChangeTeamMember(agentLead, SOC, 'MEMBER')).toBe(false);
    expect(canChangeTeamMember(superAdmin, NOC, 'LEAD')).toBe(true);
    expect(canChangeTeamMemberRole(lead)).toBe(false);
    expect(canChangeTeamMemberRole(superAdmin)).toBe(true);
  });

  it('on-call: team leads of that team; settings (list, webhook, archive): super admin only', () => {
    expect(canSetTeamOnCall(lead, SOC)).toBe(true);
    expect(canSetTeamOnCall(lead, NOC)).toBe(false);
    expect(canSetTeamOnCall(superAdmin, NOC)).toBe(true);
    expect(canEditTeamSettings(lead)).toBe(false);
    expect(canEditTeamSettings(superAdmin)).toBe(true);
  });

  it('macros: team leads never move a macro to another team or to global', () => {
    expect(canMoveMacro(lead, SOC, SOC)).toBe(true);
    expect(canMoveMacro(lead, SOC, NOC)).toBe(false);
    expect(canMoveMacro(lead, SOC, null)).toBe(false);
    expect(canMoveMacro(lead, null, null)).toBe(false); // global macros: super admin only
    expect(canMoveMacro(lead, NOC, NOC)).toBe(false);
    expect(canMoveMacro(superAdmin, null, SOC)).toBe(true);
  });
});

describe('staff rules (E9)', () => {
  const target = (over: Partial<{ id: string; role: Actor['role']; status: Actor['status'] }>) => ({
    id: 'other',
    role: 'SUPER_ADMIN' as Actor['role'],
    status: 'ACTIVE' as Actor['status'],
    ...over,
  });

  it('staff management is super admin only', () => {
    expect(canManageStaff(superAdmin)).toBe(true);
    expect(canManageStaff(lead)).toBe(false);
  });

  it('nobody changes their own role or disables themselves', () => {
    const me = target({ id: superAdmin.id });
    expect(staffChangeProblem(superAdmin, me, { role: 'AGENT' }, 5)).toBe('self_role');
    expect(staffChangeProblem(superAdmin, me, { status: 'DISABLED' }, 5)).toBe('self_disable');
    expect(staffChangeProblem(superAdmin, me, { role: 'SUPER_ADMIN', status: 'ACTIVE' }, 5)).toBe(
      null,
    );
  });

  it('the last active super admin can be neither demoted nor disabled', () => {
    expect(staffChangeProblem(superAdmin, target({}), { role: 'AGENT' }, 1)).toBe(
      'last_super_admin',
    );
    expect(staffChangeProblem(superAdmin, target({}), { status: 'DISABLED' }, 1)).toBe(
      'last_super_admin',
    );
    expect(staffChangeProblem(superAdmin, target({}), { role: 'AGENT' }, 2)).toBe(null);
    // A disabled super admin is not counted, so re-enabling or demoting them is fine.
    expect(
      staffChangeProblem(superAdmin, target({ status: 'DISABLED' }), { role: 'AGENT' }, 1),
    ).toBe(null);
    expect(
      staffChangeProblem(superAdmin, target({ role: 'AGENT' }), { status: 'DISABLED' }, 1),
    ).toBe(null);
  });

  it('a role or status change revokes sessions; other edits do not', () => {
    const before = { role: 'AGENT' as const, status: 'ACTIVE' as const };
    expect(staffChangeRevokesSessions(before, { ...before, role: 'TEAM_LEAD' })).toBe(true);
    expect(staffChangeRevokesSessions(before, { ...before, status: 'DISABLED' })).toBe(true);
    expect(staffChangeRevokesSessions(before, { ...before })).toBe(false);
  });
});
