import type { PrismaClient } from '@loons/db';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppConfig } from '../config.ts';
import type { PrincipalStore } from '../lib/actor.ts';
import type { AppQueues } from '../lib/queues.ts';
import { createAuthService, type AuthService } from './auth.service.ts';
import {
  createEmailVerificationService,
  type EmailVerificationService,
} from './email-verification.service.ts';
import { createMeService, type MeService } from './me.service.ts';
import { createPasswordResetService, type PasswordResetService } from './password-reset.service.ts';
import {
  createSessionsService,
  type SessionsService,
  type SocketDisconnector,
} from './sessions.service.ts';

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
}

export function createServices(deps: {
  prisma: PrismaClient;
  queues: AppQueues;
  principals: PrincipalStore;
  /** Closes a user's live sockets when their sessions are revoked. */
  sockets: SocketDisconnector;
  config: AppConfig;
  logger: Logger;
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
  };
}
