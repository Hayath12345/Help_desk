import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppConfig } from '../config.ts';
import type { PrincipalStore } from '../lib/actor.ts';
import type { AppQueues } from '../lib/queues.ts';
import type { Storage } from '../lib/storage.ts';
import type { UploadQuotaOptions } from '../lib/upload-quota.ts';
import { createAdminServices, type AdminServices } from './admin/index.ts';
import type { Broadcast } from './admin/config-changes.ts';
import { createAttachmentsService, type AttachmentsService } from './attachments.service.ts';
import { createAuthService, type AuthService } from './auth.service.ts';
import { createDirectoryService, type DirectoryService } from './directory.service.ts';
import {
  createEmailVerificationService,
  type EmailVerificationService,
} from './email-verification.service.ts';
import { createMeService, type MeService } from './me.service.ts';
import { createMessagesService, type MessagesService } from './messages.service.ts';
import { createNotificationsService, type NotificationsService } from './notifications.service.ts';
import { createNotifier, type Notifier } from './notifier.ts';
import { createPasswordResetService, type PasswordResetService } from './password-reset.service.ts';
import {
  createSessionsService,
  type SessionsService,
  type SocketDisconnector,
} from './sessions.service.ts';
import type { SlaMath } from './sla.ts';
import type { TicketRealtime } from './ticket-access.ts';
import { createTicketConfigService, type TicketConfigService } from './ticket-config.service.ts';
import { createTicketsService, type TicketsService } from './tickets.service.ts';

export {
  REVOKE_SESSIONS_DATA,
  type SessionsService,
  type SocketDisconnector,
} from './sessions.service.ts';

export interface Services {
  auth: AuthService;
  passwordReset: PasswordResetService;
  /** Client email verification (sign-up link, resend, confirm). */
  emailVerification: EmailVerificationService;
  me: MeService;
  /** Session revocation (`revokeUserSessions`) — for password reset now, admin actions later. */
  sessions: SessionsService;
  /** Live ticket-form config + SLA calendar (Redis-cached; `invalidate()` after config edits). */
  ticketConfig: TicketConfigService;
  tickets: TicketsService;
  messages: MessagesService;
  attachments: AttachmentsService;
  /** Form context, requester picker, macros, teams. */
  directory: DirectoryService;
  /** In-app notifications of the caller (D13). */
  notifications: NotificationsService;
  /** Notification / escalation job producers (after commit, D15). */
  notifier: Notifier;
  /** Phase 4 admin: writer (transaction + audit + after-commit), config changes, sections. */
  admin: AdminServices;
}

export function createServices(deps: {
  prisma: PrismaClient;
  redis: Redis;
  queues: AppQueues;
  principals: PrincipalStore;
  /** Closes a user's live sockets when their sessions are revoked. */
  sockets: SocketDisconnector;
  /** Realtime side of ticket changes (Socket.IO rooms). */
  ticketRealtime: TicketRealtime;
  storage: Storage;
  sla: SlaMath;
  config: AppConfig;
  logger: Logger;
  /** Upload budget window / clock (tests). */
  uploadQuota?: Pick<UploadQuotaOptions, 'windowMs' | 'now'> | undefined;
  /** Length of an escalation "minute" (tests shrink it; default 60 000 ms). */
  escalationMinuteMs?: number | undefined;
  /** Emits to every socket (`config:updated`); the Socket.IO server is attached after this. */
  broadcast: Broadcast;
}): Services {
  const sessions = createSessionsService({
    prisma: deps.prisma,
    principals: deps.principals,
    sockets: deps.sockets,
    logger: deps.logger.child({ svc: 'sessions' }),
  });
  const emailVerification = createEmailVerificationService({
    prisma: deps.prisma,
    queues: deps.queues,
    principals: deps.principals,
    config: deps.config,
    logger: deps.logger.child({ svc: 'email-verification' }),
  });
  const ticketConfig = createTicketConfigService({
    prisma: deps.prisma,
    redis: deps.redis,
    prefix: deps.config.redisPrefix,
    logger: deps.logger.child({ svc: 'ticket-config' }),
  });
  const notifier = createNotifier({
    prisma: deps.prisma,
    queues: deps.queues,
    logger: deps.logger.child({ svc: 'notifier' }),
    ...(deps.escalationMinuteMs !== undefined ? { minuteMs: deps.escalationMinuteMs } : {}),
  });
  const tickets = createTicketsService({
    prisma: deps.prisma,
    ticketConfig,
    sla: deps.sla,
    realtime: deps.ticketRealtime,
    notifier,
    logger: deps.logger.child({ svc: 'tickets' }),
  });
  return {
    auth: createAuthService({
      prisma: deps.prisma,
      queues: deps.queues,
      config: deps.config,
      principals: deps.principals,
      sessions,
      verification: emailVerification,
      logger: deps.logger.child({ svc: 'auth' }),
    }),
    passwordReset: createPasswordResetService({
      prisma: deps.prisma,
      queues: deps.queues,
      sessions,
      config: deps.config,
      logger: deps.logger.child({ svc: 'password-reset' }),
    }),
    emailVerification,
    me: createMeService({ prisma: deps.prisma, principals: deps.principals }),
    sessions,
    ticketConfig,
    tickets,
    messages: createMessagesService({
      prisma: deps.prisma,
      tickets,
      ticketConfig,
      sla: deps.sla,
      realtime: deps.ticketRealtime,
      notifier,
      logger: deps.logger.child({ svc: 'messages' }),
    }),
    attachments: createAttachmentsService({
      prisma: deps.prisma,
      redis: deps.redis,
      storage: deps.storage,
      config: deps.config,
      logger: deps.logger.child({ svc: 'attachments' }),
      uploadQuota: deps.uploadQuota,
    }),
    directory: createDirectoryService({ prisma: deps.prisma }),
    notifications: createNotificationsService({ prisma: deps.prisma }),
    notifier,
    admin: createAdminServices({
      prisma: deps.prisma,
      redis: deps.redis,
      queues: deps.queues,
      config: deps.config,
      logger: deps.logger,
      ticketConfig,
      principals: deps.principals,
      sessions,
      notifier,
      broadcast: deps.broadcast,
    }),
  };
}
