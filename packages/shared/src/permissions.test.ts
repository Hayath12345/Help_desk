import { describe, expect, it } from 'vitest';
import {
  canAccessAdmin,
  canAccessAdminSection,
  canAddInternalNote,
  canCreateTicketForOrg,
  canJoinTeamRoom,
  canJoinTicketRoom,
  canJoinTicketStaffRoom,
  canJoinUserRoom,
  canManageMacros,
  canManageTeam,
  canSeeInternalNotes,
  canUpdateTicket,
  canViewTicket,
  type Actor,
  type TicketScope,
} from './permissions.ts';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const SOC = '00000000-0000-4000-8000-0000000000c1';
const NOC = '00000000-0000-4000-8000-0000000000c2';

const actor = (over: Partial<Actor>): Actor => ({
  id: 'u-' + (over.role ?? 'x'),
  role: 'CLIENT',
  status: 'ACTIVE',
  orgId: null,
  teamIds: [],
  leadTeamIds: [],
  ...over,
});

const client = actor({ id: 'client-a', role: 'CLIENT', orgId: ORG_A });
const pendingClient = actor({
  id: 'client-p',
  role: 'CLIENT',
  orgId: null,
  status: 'PENDING_APPROVAL',
});
const socAgent = actor({ id: 'agent-soc', role: 'AGENT', teamIds: [SOC] });
const nocLead = actor({ id: 'lead-noc', role: 'TEAM_LEAD', teamIds: [NOC], leadTeamIds: [NOC] });
const admin = actor({ id: 'admin', role: 'SUPER_ADMIN' });
const disabledAdmin = actor({ id: 'admin-x', role: 'SUPER_ADMIN', status: 'DISABLED' });

const socTicketOrgA: TicketScope = { orgId: ORG_A, teamId: SOC, assigneeId: null };
const nocTicketOrgB: TicketScope = { orgId: ORG_B, teamId: NOC, assigneeId: null };
const nocTicketAssignedToSocAgent: TicketScope = {
  orgId: ORG_B,
  teamId: NOC,
  assigneeId: socAgent.id,
};

describe('ticket visibility', () => {
  it('clients see only their own organisation', () => {
    expect(canViewTicket(client, socTicketOrgA)).toBe(true);
    expect(canViewTicket(client, nocTicketOrgB)).toBe(false);
  });

  it('pending clients without an organisation see nothing', () => {
    expect(canViewTicket(pendingClient, socTicketOrgA)).toBe(false);
    expect(canCreateTicketForOrg(pendingClient, ORG_A)).toBe(false);
  });

  it('agents see tickets of their teams and tickets assigned to them', () => {
    expect(canViewTicket(socAgent, socTicketOrgA)).toBe(true);
    expect(canViewTicket(socAgent, nocTicketOrgB)).toBe(false);
    expect(canViewTicket(socAgent, nocTicketAssignedToSocAgent)).toBe(true);
  });

  it('super admins see everything unless disabled', () => {
    expect(canViewTicket(admin, nocTicketOrgB)).toBe(true);
    expect(canViewTicket(disabledAdmin, nocTicketOrgB)).toBe(false);
  });
});

describe('internal notes', () => {
  it('are never visible to clients', () => {
    expect(canSeeInternalNotes(client)).toBe(false);
    expect(canAddInternalNote(client, socTicketOrgA)).toBe(false);
  });

  it('can be added by staff who can view the ticket', () => {
    expect(canSeeInternalNotes(socAgent)).toBe(true);
    expect(canAddInternalNote(socAgent, socTicketOrgA)).toBe(true);
    expect(canAddInternalNote(socAgent, nocTicketOrgB)).toBe(false);
  });
});

describe('ticket updates', () => {
  it('are staff-only and scoped to visible tickets', () => {
    expect(canUpdateTicket(client, socTicketOrgA)).toBe(false);
    expect(canUpdateTicket(socAgent, socTicketOrgA)).toBe(true);
    expect(canUpdateTicket(nocLead, socTicketOrgA)).toBe(false);
  });

  it('clients may create tickets only for their own organisation', () => {
    expect(canCreateTicketForOrg(client, ORG_A)).toBe(true);
    expect(canCreateTicketForOrg(client, ORG_B)).toBe(false);
    expect(canCreateTicketForOrg(socAgent, ORG_B)).toBe(true);
  });
});

describe('team management', () => {
  it('team leads manage only their own team', () => {
    expect(canManageTeam(nocLead, NOC)).toBe(true);
    expect(canManageTeam(nocLead, SOC)).toBe(false);
    expect(canManageTeam(socAgent, SOC)).toBe(false);
    expect(canManageTeam(admin, SOC)).toBe(true);
  });

  it('global macros are super-admin only', () => {
    expect(canManageMacros(nocLead, NOC)).toBe(true);
    expect(canManageMacros(nocLead, null)).toBe(false);
    expect(canManageMacros(admin, null)).toBe(true);
    expect(canManageMacros(socAgent, SOC)).toBe(false);
  });

  it('admin panel: super admin everything, team lead limited', () => {
    expect(canAccessAdmin(admin)).toBe(true);
    expect(canAccessAdmin(nocLead)).toBe(true);
    expect(canAccessAdmin(socAgent)).toBe(false);
    expect(canAccessAdmin(client)).toBe(false);
    expect(canAccessAdminSection(nocLead, 'macros')).toBe(true);
    expect(canAccessAdminSection(nocLead, 'sla')).toBe(false);
    expect(canAccessAdminSection(admin, 'audit-log')).toBe(true);
  });
});

describe('realtime rooms', () => {
  it('clients join their org ticket room but never the staff room', () => {
    expect(canJoinTicketRoom(client, socTicketOrgA)).toBe(true);
    expect(canJoinTicketStaffRoom(client, socTicketOrgA)).toBe(false);
    expect(canJoinTicketRoom(client, nocTicketOrgB)).toBe(false);
  });

  it('team rooms are for members and super admins', () => {
    expect(canJoinTeamRoom(socAgent, SOC)).toBe(true);
    expect(canJoinTeamRoom(socAgent, NOC)).toBe(false);
    expect(canJoinTeamRoom(client, SOC)).toBe(false);
    expect(canJoinTeamRoom(admin, NOC)).toBe(true);
  });

  it('user rooms are private', () => {
    expect(canJoinUserRoom(client, client.id)).toBe(true);
    expect(canJoinUserRoom(client, socAgent.id)).toBe(false);
  });
});
