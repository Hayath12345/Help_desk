import {
  ADMIN_SECTIONS,
  ADMIN_SECTION_GROUPS,
  TEAM_LEAD_ADMIN_SECTIONS,
  type AdminSection,
  type AdminSectionGroup,
  type Role,
} from '@loons/shared';

// The admin panel's sections (docs/PHASE4_CONTRACT.md E1, E7, E8): the shared ADMIN_SECTIONS (13,
// incl. Staff and General settings) in their navigation groups. Every place that lists or gates
// admin sections in the web app goes through this file (also the proxy's routing rules), so it
// stays free of UI imports.

/** A section slug (`/admin/<slug>`). Same as the shared `AdminSection`. */
export type AdminSlug = AdminSection;
export type AdminNavGroupId = AdminSectionGroup;

/** Navigation groups (E8), in display order, with their sections in display order. */
export const ADMIN_NAV_GROUPS: readonly { id: AdminNavGroupId; sections: readonly AdminSlug[] }[] =
  ADMIN_SECTION_GROUPS.map((group) => ({ id: group.key, sections: group.sections }));

/** All sections in navigation order. */
export const ADMIN_SLUGS: readonly AdminSlug[] = ADMIN_SECTIONS;

/**
 * Message namespace that holds a section's own strings (`messages/{en,ar}/admin-<group>.json`).
 * Shared kit strings live in `admin` (admin.json).
 */
export const ADMIN_SECTION_NAMESPACE = {
  categories: 'admin-setup',
  'custom-fields': 'admin-setup',
  macros: 'admin-setup',
  sla: 'admin-sla',
  'business-hours': 'admin-sla',
  escalation: 'admin-sla',
  settings: 'admin-sla',
  teams: 'admin-people',
  staff: 'admin-people',
  clients: 'admin-people',
  'email-templates': 'admin-comms',
  'help-center': 'admin-comms',
  'audit-log': 'admin-comms',
} as const satisfies Record<AdminSlug, string>;

export function isAdminSection(value: string): value is AdminSlug {
  return (ADMIN_SLUGS as readonly string[]).includes(value);
}

/**
 * Sections this role may open, in navigation order. UI-only mirror of `canAccessAdminSection`
 * (the API enforces access; team leads are further scoped to the teams they lead there).
 */
export function allowedAdminSections(role: Role): readonly AdminSlug[] {
  if (role === 'SUPER_ADMIN') return ADMIN_SLUGS;
  if (role === 'TEAM_LEAD') return ADMIN_SLUGS.filter((s) => TEAM_LEAD_ADMIN_SECTIONS.includes(s));
  return [];
}

export function canOpenAdminSection(role: Role, section: AdminSlug): boolean {
  return allowedAdminSections(role).includes(section);
}

/** The navigation groups with only the sections this role may open (empty groups dropped). */
export function allowedAdminGroups(
  role: Role,
): { id: AdminNavGroupId; sections: readonly AdminSlug[] }[] {
  const allowed = new Set(allowedAdminSections(role));
  return ADMIN_NAV_GROUPS.map((group) => ({
    id: group.id,
    sections: group.sections.filter((slug) => allowed.has(slug)),
  })).filter((group) => group.sections.length > 0);
}
