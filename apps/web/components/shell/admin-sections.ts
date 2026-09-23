import {
  ADMIN_SECTIONS,
  TEAM_LEAD_ADMIN_SECTIONS,
  type AdminSection,
  type Role,
} from '@loons/shared';
import {
  BookOpen,
  Building2,
  CalendarClock,
  FolderTree,
  Mail,
  MessageSquareText,
  ScrollText,
  Siren,
  TextCursorInput,
  Timer,
  Users,
  type LucideIcon,
} from 'lucide-react';

export const ADMIN_SECTION_ICONS: Record<AdminSection, LucideIcon> = {
  categories: FolderTree,
  'custom-fields': TextCursorInput,
  teams: Users,
  sla: Timer,
  'business-hours': CalendarClock,
  escalation: Siren,
  clients: Building2,
  macros: MessageSquareText,
  'email-templates': Mail,
  'help-center': BookOpen,
  'audit-log': ScrollText,
};

export function isAdminSection(value: string): value is AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(value);
}

/**
 * Sections this role may open, in display order. UI-only mirror of `canAccessAdminSection`
 * (the API enforces access; team leads are further scoped to their own teams there).
 */
export function allowedAdminSections(role: Role): readonly AdminSection[] {
  if (role === 'SUPER_ADMIN') return ADMIN_SECTIONS;
  if (role === 'TEAM_LEAD') return ADMIN_SECTIONS.filter((s) => TEAM_LEAD_ADMIN_SECTIONS.includes(s));
  return [];
}

export function canOpenAdminSection(role: Role, section: AdminSection): boolean {
  return allowedAdminSections(role).includes(section);
}
