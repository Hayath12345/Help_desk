import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isActive, type Actor } from '@loons/shared';
import { toActor, type Principal } from '../lib/actor.ts';
import { errors, type AppError } from '../lib/errors.ts';
import { bearerToken } from '../lib/tokens.ts';

export interface AuthenticatedToken {
  principal: Principal;
  /** When the token stops being accepted (epoch ms); sockets are closed at that moment. */
  expiresAt: number;
}

/**
 * Verifies an API access token and reloads the user (shared by HTTP and the Socket.IO
 * handshake). Missing / invalid / expired token, unknown user or a revoked session (the token's
 * `sv` differs from the user's current sessionVersion) → 401 UNAUTHENTICATED; disabled user →
 * 401 ACCOUNT_DISABLED.
 */
export async function authenticateToken(app: FastifyInstance, token: string | null): Promise<AuthenticatedToken> {
  if (!token) throw errors.unauthenticated('Missing bearer token');
  let claims: Awaited<ReturnType<FastifyInstance['tokens']['verify']>>;
  try {
    claims = await app.tokens.verify(token);
  } catch {
    throw errors.unauthenticated('Invalid or expired access token');
  }
  const { sub, sv } = claims;
  let principal = await app.principals.load(sub);
  if (principal && principal.sessionVersion < sv) {
    // A token newer than the cached principal: the cache predates a revocation (e.g. it could
    // not be cleared). Re-read the database before rejecting a session that may be valid.
    principal = await app.principals.load(sub, { fresh: true });
  }
  if (!principal) throw errors.unauthenticated('Unknown user');
  if (principal.status === 'DISABLED') throw errors.accountDisabled(401);
  if (principal.sessionVersion !== sv) throw errors.unauthenticated('Session revoked');
  return { principal, expiresAt: app.tokens.expiresAt(claims) };
}

/**
 * Why a signed-in (not disabled) user may not use the app yet, or null when they may:
 * a client who hasn't verified their email → 403 EMAIL_NOT_VERIFIED (checked first); an account
 * awaiting approval → 403 FORBIDDEN. Mirrors `isActive` from @loons/shared.
 */
export function accessRestriction(actor: Actor): AppError | null {
  if (isActive(actor)) return null;
  if (actor.role === 'CLIENT' && !actor.emailVerified) return errors.emailNotVerified();
  return errors.forbidden('Your account is awaiting approval.');
}

export interface RequireAuthOptions {
  /**
   * Let restricted users through: PENDING_APPROVAL accounts and clients who haven't verified
   * their email. Only GET/PATCH /me opt in.
   */
  allowRestricted?: boolean;
}

/** preHandler for Bearer-authenticated routes; sets `request.actor`. */
export function requireAuth(options: RequireAuthOptions = {}) {
  return async function requireAuthHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const { principal } = await authenticateToken(req.server, bearerToken(req.headers.authorization));
    const actor = toActor(principal);
    const restriction = options.allowRestricted ? null : accessRestriction(actor);
    if (restriction) throw restriction;
    req.actor = actor;
  };
}

/** The authenticated actor of a route guarded by `requireAuth`. */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw errors.unauthenticated();
  return req.actor;
}
