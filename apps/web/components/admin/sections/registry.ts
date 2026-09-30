import type { ComponentType } from 'react';
import type { AdminSlug } from '@/lib/admin/sections';
import CategoriesSection from './categories';
import CustomFieldsSection from './custom-fields';
import MacrosSection from './macros';
import SlaSection from './sla';
import BusinessHoursSection from './business-hours';
import EscalationSection from './escalation';
import TeamsSection from './teams';
import StaffSection from './staff';
import ClientsSection from './clients';
import EmailTemplatesSection from './email-templates';
import HelpCenterSection from './help-center';
import SettingsSection from './settings';
import AuditLogSection from './audit-log';
import type { AdminSectionProps } from './types';

/** The component `/admin/[section]` renders for each section (`sections/<slug>/index.tsx`). */
export const ADMIN_SECTION_COMPONENTS: Record<AdminSlug, ComponentType<AdminSectionProps>> = {
  categories: CategoriesSection,
  'custom-fields': CustomFieldsSection,
  macros: MacrosSection,
  sla: SlaSection,
  'business-hours': BusinessHoursSection,
  escalation: EscalationSection,
  teams: TeamsSection,
  staff: StaffSection,
  clients: ClientsSection,
  'email-templates': EmailTemplatesSection,
  'help-center': HelpCenterSection,
  settings: SettingsSection,
  'audit-log': AuditLogSection,
};
