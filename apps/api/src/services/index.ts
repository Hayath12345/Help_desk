import type { PrismaClient } from '@loons/db';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppConfig } from '../config.ts';
import type { PrincipalStore } from '../lib/actor.ts';
import type { AppQueues } from '../lib/queues.ts';
import { createAuthService, type AuthService } from './auth.service.ts';
import { createMeService, type MeService } from './me.service.ts';
import { createPasswordResetService, type PasswordResetService } from './password-reset.service.ts';
import { createSessionsService, type SessionsService } from './sessions.service.ts';

export { REVOKE_SESSIONS_DATA, type SessionsService } from './sessions.service.ts';

export interface Services {
  auth: AuthService;
  passwordReset: PasswordResetService;
  me: MeService;
  /** Session revocation (`revokeUserSessions`) — for password reset now, admin actions later. */
  sessions: SessionsService;
}

export function createServices(deps: {
  prisma: PrismaClient;
  queues: AppQueues;
  principals: PrincipalStore;
  config: AppConfig;
  logger: Logger;
}): Services {
  return {
    auth: createAuthService({ prisma: deps.prisma, config: deps.config, logger: deps.logger.child({ svc: 'auth' }) }),
    passwordReset: createPasswordResetService({
      prisma: deps.prisma,
      queues: deps.queues,
      principals: deps.principals,
      config: deps.config,
      logger: deps.logger.child({ svc: 'password-reset' }),
    }),
    me: createMeService({ prisma: deps.prisma, principals: deps.principals }),
    sessions: createSessionsService({
      prisma: deps.prisma,
      principals: deps.principals,
      logger: deps.logger.child({ svc: 'sessions' }),
    }),
  };
}
