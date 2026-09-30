import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import type { AppConfig } from '../../config.ts';
import type { PrincipalStore } from '../../lib/actor.ts';
import type { AppLogger as Logger } from '../../lib/logger.ts';
import type { AppQueues } from '../../lib/queues.ts';
import type { Notifier } from '../notifier.ts';
import type { SessionsService } from '../sessions.service.ts';
import type { TicketConfigService } from '../ticket-config.service.ts';
import { createAuditLogAdminService, type AuditLogAdminService } from './audit-log.ts';
import {
  createBusinessHoursAdminService,
  type BusinessHoursAdminService,
} from './business-hours.ts';
import { createCategoriesAdminService, type CategoriesAdminService } from './categories.ts';
import { createClientsAdminService, type ClientsAdminService } from './clients.ts';
import { createConfigChanges, type Broadcast, type ConfigChanges } from './config-changes.ts';
import { createCustomFieldsAdminService, type CustomFieldsAdminService } from './custom-fields.ts';
import type { AdminDeps } from './deps.ts';
import {
  createEmailTemplatesAdminService,
  type EmailTemplatesAdminService,
} from './email-templates.ts';
import { createEscalationAdminService, type EscalationAdminService } from './escalation.ts';
import { createHelpCenterAdminService, type HelpCenterAdminService } from './help-center.ts';
import { createMacrosAdminService, type MacrosAdminService } from './macros.ts';
import { createSettingsAdminService, type SettingsAdminService } from './settings.ts';
import { createSlaAdminService, type SlaAdminService } from './sla.ts';
import { createStaffAdminService, type StaffAdminService } from './staff.ts';
import { createStaffDirectoryService, type StaffDirectoryService } from './staff-directory.ts';
import { createTeamsAdminService, type TeamsAdminService } from './teams.ts';
import { createAdminWriter, type AdminWriter } from './write.ts';

export type { AdminDeps } from './deps.ts';
export type { AdminContext, AdminWriteTools, AdminWriter, AfterCommit } from './write.ts';
export type { ConfigChanges } from './config-changes.ts';

/** The admin API's services (`app.services.admin`). */
export interface AdminServices {
  writer: AdminWriter;
  configChanges: ConfigChanges;
  staffDirectory: StaffDirectoryService;
  categories: CategoriesAdminService;
  customFields: CustomFieldsAdminService;
  macros: MacrosAdminService;
  sla: SlaAdminService;
  businessHours: BusinessHoursAdminService;
  escalation: EscalationAdminService;
  teams: TeamsAdminService;
  staff: StaffAdminService;
  clients: ClientsAdminService;
  emailTemplates: EmailTemplatesAdminService;
  helpCenter: HelpCenterAdminService;
  settings: SettingsAdminService;
  auditLog: AuditLogAdminService;
}

export function createAdminServices(deps: {
  prisma: PrismaClient;
  redis: Redis;
  queues: AppQueues;
  config: AppConfig;
  logger: Logger;
  ticketConfig: TicketConfigService;
  principals: PrincipalStore;
  sessions: SessionsService;
  notifier: Notifier;
  /** Emits to every socket (`Realtime.broadcast`, attached after the services are built). */
  broadcast: Broadcast;
}): AdminServices {
  const logger = deps.logger.child({ svc: 'admin' });
  const configChanges = createConfigChanges({
    ticketConfig: deps.ticketConfig,
    broadcast: deps.broadcast,
    logger,
  });
  const writer = createAdminWriter({
    prisma: deps.prisma,
    principals: deps.principals,
    sessions: deps.sessions,
    configChanges,
    logger,
  });
  const admin: AdminDeps = {
    prisma: deps.prisma,
    redis: deps.redis,
    queues: deps.queues,
    config: deps.config,
    logger,
    ticketConfig: deps.ticketConfig,
    principals: deps.principals,
    sessions: deps.sessions,
    notifier: deps.notifier,
    writer,
    configChanges,
  };
  return {
    writer,
    configChanges,
    staffDirectory: createStaffDirectoryService({ prisma: deps.prisma }),
    categories: createCategoriesAdminService(admin),
    customFields: createCustomFieldsAdminService(admin),
    macros: createMacrosAdminService(admin),
    sla: createSlaAdminService(admin),
    businessHours: createBusinessHoursAdminService(admin),
    escalation: createEscalationAdminService(admin),
    teams: createTeamsAdminService(admin),
    staff: createStaffAdminService(admin),
    clients: createClientsAdminService(admin),
    emailTemplates: createEmailTemplatesAdminService(admin),
    helpCenter: createHelpCenterAdminService(admin),
    settings: createSettingsAdminService(admin),
    auditLog: createAuditLogAdminService(admin),
  };
}
