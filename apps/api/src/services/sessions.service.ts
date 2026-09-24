import { Prisma, type PrismaClient } from '@loons/db';
import type { PrincipalStore } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';

/**
 * `data` fragment for `prisma.user.update` that revokes every existing session and API token of
 * the user. Use it inside a transaction that makes another change at the same time (password
 * reset, disabling the account, a role change…) and call `sessions.sessionsRevoked(userId)` once
 * that transaction has committed.
 */
export const REVOKE_SESSIONS_DATA = { sessionVersion: { increment: 1 } } as const satisfies Prisma.UserUpdateInput;

/** The realtime side of a revocation (implemented by the Socket.IO server). */
export interface SocketDisconnector {
  /** Closes every live socket of the user (on every API instance). */
  disconnectUser(userId: string): void;
}

export interface SessionsService {
  /**
   * Revokes every web session and API token of the user: increments `User.sessionVersion`, clears
   * the cached principal and closes their live sockets. Tokens minted for the old version get 401
   * from the next request on; web sessions end at their next refresh. Returns the new version.
   * Throws 404 NOT_FOUND for an unknown user.
   */
  revokeUserSessions(userId: string): Promise<number>;
  /**
   * Call once a transaction that applied `REVOKE_SESSIONS_DATA` has committed: clears the cached
   * principal (so no request can re-cache the old version) and closes the user's live sockets.
   */
  sessionsRevoked(userId: string): Promise<void>;
}

export function createSessionsService(deps: {
  prisma: PrismaClient;
  principals: PrincipalStore;
  sockets: SocketDisconnector;
  logger: Logger;
}): SessionsService {
  const { prisma, principals, sockets, logger } = deps;

  async function sessionsRevoked(userId: string): Promise<void> {
    await principals.invalidate(userId);
    try {
      sockets.disconnectUser(userId);
    } catch (err) {
      // The revocation itself has committed; a socket that stays open is closed at token expiry.
      logger.warn({ err, userId }, 'could not disconnect the user’s sockets after revoking their sessions');
    }
  }

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
      await sessionsRevoked(userId);
      logger.info({ userId, sessionVersion }, 'user sessions revoked');
      return sessionVersion;
    },
    sessionsRevoked,
  };
}
