import {
  ADMIN_SECTIONS,
  ROLES,
  canAccessAdminSection,
  type Actor,
  type Role,
} from '@loons/shared';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SECTION_ICONS,
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
});

describe('admin sections (UI mirror of the server rules)', () => {
  it('gives super admins every section in display order', () => {
    expect(allowedAdminSections('SUPER_ADMIN')).toEqual(ADMIN_SECTIONS);
  });

  it('limits team leads to teams and macros', () => {
    expect(allowedAdminSections('TEAM_LEAD')).toEqual(['teams', 'macros']);
  });

  it('gives agents and clients nothing', () => {
    expect(allowedAdminSections('AGENT')).toEqual([]);
    expect(allowedAdminSections('CLIENT')).toEqual([]);
  });

  it('agrees with canAccessAdminSection from @loons/shared for every role and section', () => {
    for (const role of ROLES) {
      for (const section of ADMIN_SECTIONS) {
        expect(canOpenAdminSection(role, section), `${role} → ${section}`).toBe(
          canAccessAdminSection(actor(role), section),
        );
      }
    }
  });

  it('validates section slugs', () => {
    expect(isAdminSection('sla')).toBe(true);
    expect(isAdminSection('custom-fields')).toBe(true);
    expect(isAdminSection('users')).toBe(false);
    expect(isAdminSection('')).toBe(false);
  });

  it('has an icon for every section', () => {
    for (const section of ADMIN_SECTIONS) expect(ADMIN_SECTION_ICONS[section]).toBeTruthy();
  });
});
