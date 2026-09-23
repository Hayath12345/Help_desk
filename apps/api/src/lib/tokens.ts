import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { apiTokenClaimsSchema, type ApiTokenClaims } from '@loons/shared';
import type { AppConfig } from '../config.ts';

// ───────────── API access tokens (minted by the web server, HS256) ─────────────

export interface AccessTokenVerifier {
  verify(token: string): Promise<ApiTokenClaims>;
}

export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super('Invalid access token');
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies `Authorization: Bearer` / socket handshake tokens: HS256 only, issuer + audience
 * pinned, 5 s clock tolerance, and never older than the configured TTL (+ tolerance) even if
 * a token was minted with a longer `exp`. The key is the UTF-8 bytes of API_JWT_SECRET.
 */
export function createAccessTokenVerifier(jwt: AppConfig['jwt']): AccessTokenVerifier {
  const key = new TextEncoder().encode(jwt.secret);
  const maxTokenAge = jwt.ttlSeconds + 60;
  return {
    async verify(token) {
      if (token.length > 4096) throw new InvalidTokenError('too_long');
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: jwt.issuer,
          audience: jwt.audience,
          clockTolerance: 5,
          maxTokenAge,
          requiredClaims: ['sub', 'iat', 'exp'],
        }));
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        throw new InvalidTokenError(typeof code === 'string' ? code : 'invalid');
      }
      const claims = apiTokenClaimsSchema.safeParse(payload);
      if (!claims.success) throw new InvalidTokenError('claims');
      return claims.data;
    },
  };
}

/** `Authorization: Bearer <token>` → token, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

// ───────────── Password reset tokens ─────────────

export const RESET_TOKEN_TTL_MINUTES = 30;

/** SHA-256 (hex) of a raw token — only the hash is stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes, base64url (43 chars). */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}
