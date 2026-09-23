import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@loons/shared';
import { toActor, type Principal } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';
import { bearerToken } from '../lib/tokens.ts';

/**
 * Verifies an API access token and reloads the user (shared by HTTP and the Socket.IO
 * handshake). Missing / invalid / expired token, unknown user or a revoked session (the token's
 * `sv` differs from the user's current sessionVersion) → 401 UNAUTHENTICATED; disabled user →
 * 401 ACCOUNT_DISABLED.
 */
export async function authenticateToken(app: FastifyInstance, token: string | null): Promise<Principal> {
  if (!token) throw errors.unauthenticated('Missing bearer token');
  let sub: string;
  let sv: number;
  try {
    ({ sub, sv } = await app.tokens.verify(token));
  } catch {
    throw errors.unauthenticated('Invalid or expired access token');
  }
  let principal = await app.principals.load(sub);
  if (principal && principal.sessionVersion < sv) {
    // A token newer than the cached principal: the cache predates a revocation (e.g. it could
    // not be cleared). Re-read the database before rejecting a session that may be valid.
    principal = await app.principals.load(sub, { fresh: true });
  }
  if (!principal) throw errors.unauthenticated('Unknown user');
  if (principal.status === 'DISABLED') throw errors.accountDisabled(401);
  if (principal.sessionVersion !== sv) throw errors.unauthenticated('Session revoked');
  return principal;
}

export interface RequireAuthOptions {
  /** PENDING_APPROVAL users may only reach routes that opt in (GET/PATCH /me). */
  allowPending?: boolean;
}

/** preHandler for Bearer-authenticated routes; sets `request.actor`. */
export function requireAuth(options: RequireAuthOptions = {}) {
  return async function requireAuthHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const principal = await authenticateToken(req.server, bearerToken(req.headers.authorization));
    if (principal.status === 'PENDING_APPROVAL' && !options.allowPending) {
      throw errors.forbidden('Your account is awaiting approval.');
    }
    req.actor = toActor(principal);
  };
}

/** The authenticated actor of a route guarded by `requireAuth`. */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw errors.unauthenticated();
  return req.actor;
}
