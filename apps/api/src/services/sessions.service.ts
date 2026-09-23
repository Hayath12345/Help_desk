import { Prisma, type PrismaClient } from '@loons/db';
import type { PrincipalStore } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';

/**
 * `data` fragment for `prisma.user.update` that revokes every existing session and API token of
 * the user. Use it inside a transaction that makes another change at the same time (password
 * reset, disabling the account, a role change…) and call `principals.invalidate(userId)` once
 * that transaction has committed.
 */
export const REVOKE_SESSIONS_DATA = { sessionVersion: { increment: 1 } } as const satisfies Prisma.UserUpdateInput;

export interface SessionsService {
  /**
   * Revokes every web session and API token of the user: increments `User.sessionVersion` and
   * clears the cached principal. Tokens minted for the old version get 401 from the next request
   * on; web sessions end at their next refresh. Returns the new version.
   * Throws 404 NOT_FOUND for an unknown user.
   */
  revokeUserSessions(userId: string): Promise<number>;
}

export function createSessionsService(deps: {
  prisma: PrismaClient;
  principals: PrincipalStore;
  logger: Logger;
}): SessionsService {
  const { prisma, principals, logger } = deps;

  return {
    async revokeUserSessions(userId) {
      let sessionVersion: number;
      try {
        ({ sessionVersion } = await prisma.user.update({
          where: { id: userId },
          data: REVOKE_SESSIONS_DATA,
          select: { sessionVersion: true },
        }));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
          throw errors.notFound('User not found');
        }
        throw err;
      }
      await principals.invalidate(userId);
      logger.info({ userId, sessionVersion }, 'user sessions revoked');
      return sessionVersion;
    },
  };
}
