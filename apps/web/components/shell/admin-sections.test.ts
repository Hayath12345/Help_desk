import { ADMIN_SECTIONS, ROLES, canAccessAdminSection, type Actor, type Role } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_ICONS,
  ADMIN_SECTION_NAMESPACE,
  ADMIN_SLUGS,
  allowedAdminGroups,
  allowedAdminSections,
  canOpenAdminSection,
  isAdminSection,
} from './admin-sections';

const actor = (role: Role): Actor => ({
  id: 'u',
  role,
  status: 'ACTIVE',
  orgId: role === 'CLIENT' ? 'o' : null,
  teamIds: [],
  leadTeamIds: [],
  emailVerified: true,
});

describe('admin sections (UI mirror of the server rules)', () => {
  it('has the 13 Phase 4 sections in the E8 group order', () => {
    expect(ADMIN_NAV_GROUPS.map((g) => g.id)).toEqual([
      'ticket-setup',
      'sla-escalation',
      'people',
      'communication',
      'system',
    ]);
    expect(ADMIN_SLUGS).toEqual([
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
    ]);
    // Every shared section is listed exactly once.
    for (const section of ADMIN_SECTIONS)
      expect(ADMIN_SLUGS.filter((s) => s === section)).toHaveLength(1);
  });

  it('gives super admins every section in navigation order', () => {
    expect(allowedAdminSections('SUPER_ADMIN')).toEqual(ADMIN_SLUGS);
    expect(allowedAdminGroups('SUPER_ADMIN')).toHaveLength(5);
  });

  it('limits team leads to teams and macros (and their two groups)', () => {
    expect(allowedAdminSections('TEAM_LEAD')).toEqual(['macros', 'teams']);
    expect(allowedAdminGroups('TEAM_LEAD')).toEqual([
      { id: 'ticket-setup', sections: ['macros'] },
      { id: 'people', sections: ['teams'] },
    ]);
    expect(canOpenAdminSection('TEAM_LEAD', 'staff')).toBe(false);
    expect(canOpenAdminSection('TEAM_LEAD', 'settings')).toBe(false);
  });

  it('gives agents and clients nothing', () => {
    expect(allowedAdminSections('AGENT')).toEqual([]);
    expect(allowedAdminSections('CLIENT')).toEqual([]);
    expect(allowedAdminGroups('AGENT')).toEqual([]);
  });

  it('agrees with canAccessAdminSection from @loons/shared for every role and shared section', () => {
    for (const role of ROLES) {
      for (const section of ADMIN_SECTIONS) {
        expect(canOpenAdminSection(role, section), `${role} → ${section}`).toBe(
          canAccessAdminSection(actor(role), section),
        );
      }
    }
  });

  it('matches for staff whatever their email verification (staff are gated by SSO, not a link)', () => {
    for (const role of ['SUPER_ADMIN', 'TEAM_LEAD', 'AGENT'] as const) {
      for (const section of ADMIN_SECTIONS) {
        const unverified = { ...actor(role), emailVerified: false };
        expect(canAccessAdminSection(unverified, section), `${role} → ${section}`).toBe(
          canOpenAdminSection(role, section),
        );
      }
    }
  });

  it('validates section slugs', () => {
    expect(isAdminSection('sla')).toBe(true);
    expect(isAdminSection('custom-fields')).toBe(true);
    expect(isAdminSection('staff')).toBe(true);
    expect(isAdminSection('settings')).toBe(true);
    expect(isAdminSection('users')).toBe(false);
    expect(isAdminSection('')).toBe(false);
  });

  it('has an icon and a message namespace for every section', () => {
    for (const section of ADMIN_SLUGS) {
      expect(ADMIN_SECTION_ICONS[section]).toBeTruthy();
      expect(ADMIN_SECTION_NAMESPACE[section]).toMatch(/^admin-(setup|sla|people|comms)$/);
    }
  });
});
