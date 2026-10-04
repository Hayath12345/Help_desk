import type { AdminSlug } from '@/lib/admin/sections';
import {
  BookOpen,
  Building2,
  CalendarClock,
  FolderTree,
  GraduationCap,
  Mail,
  MessageSquareText,
  ScrollText,
  Settings2,
  Siren,
  TextCursorInput,
  Timer,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

// The section list, groups and role rules live in lib/admin/sections.ts (also used by the proxy's
// routing rules); this module adds the icons the navigation and overview show.
export {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_NAMESPACE,
  ADMIN_SLUGS,
  allowedAdminGroups,
  allowedAdminSections,
  canOpenAdminSection,
  isAdminSection,
  type AdminNavGroupId,
  type AdminSlug,
} from '@/lib/admin/sections';

export const ADMIN_SECTION_ICONS: Record<AdminSlug, LucideIcon> = {
  categories: FolderTree,
  'custom-fields': TextCursorInput,
  macros: MessageSquareText,
  sla: Timer,
  'business-hours': CalendarClock,
  escalation: Siren,
  teams: Users,
  staff: UserCog,
  skills: GraduationCap,
  clients: Building2,
  'email-templates': Mail,
  'help-center': BookOpen,
  settings: Settings2,
  'audit-log': ScrollText,
};
