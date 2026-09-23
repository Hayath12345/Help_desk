// Short-lived API access tokens (HS256, jose). The API verifies them with the same secret,
// issuer and audience, then reloads the user from the database — `role` is only a hint, while
// `sv` (the session's sessionVersion) must still match the user's current one.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { apiTokenConfig } from '@/lib/auth/env';
import type { CurrentUser } from '@/lib/session';

export interface ApiToken {
  token: string;
  /** Expiry as epoch milliseconds (JWT `exp` × 1000). */
  expiresAt: number;
}

export async function mintApiToken(
  user: Pick<CurrentUser, 'id' | 'role' | 'sessionVersion'>,
): Promise<ApiToken> {
  const { secret, issuer, audience, ttlSeconds } = apiTokenConfig();
  const issuedAt = Math.floor(Date.now() / 1000);
  const exp = issuedAt + ttlSeconds;

  const token = await new SignJWT({ role: user.role, sv: user.sessionVersion })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(secret);

  return { token, expiresAt: exp * 1000 };
}
