// Pure helpers moving the Loons user between the API response, the Auth.js JWT and the session.
import {
  LOCALES,
  ROLES,
  USER_STATUSES,
  authUserSchema,
  type AuthUser,
  type Locale,
  type Role,
  type UserStatus,
} from '@loons/shared';
import type { JWT } from 'next-auth/jwt';
import { z } from 'zod';

/** The jwt callback reloads the user from the API at most this often. */
export const USER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Same shape as `CurrentUser` in lib/session.ts (kept here so this module stays pure). */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  orgId: string | null;
  locale: Locale;
  /** Session version the session was established with (revocation check, API token `sv`). */
  sessionVersion: number;
}

const userResponseSchema = z.object({ user: authUserSchema });

/** Validates an API `{ user }` response body. */
export function parseUserResponse(body: unknown): AuthUser | null {
  const parsed = userResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.user : null;
}

export function toSessionUser(user: AuthUser): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    orgId: user.orgId,
    locale: user.locale,
    sessionVersion: user.sessionVersion,
  };
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
function isStatus(value: unknown): value is UserStatus {
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value);
}
function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
function isSessionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reads the Auth.js `user` object produced by authorize() / the OAuth signIn callback. */
export function sessionUserFromAuthJsUser(user: {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  role?: unknown;
  status?: unknown;
  orgId?: string | null;
  locale?: unknown;
  sessionVersion?: unknown;
}): SessionUser | null {
  if (!user.id || !user.email || !isRole(user.role) || !isStatus(user.status)) return null;
  // Always present on users resolved by the API; without it no valid API token can be minted.
  if (!isSessionVersion(user.sessionVersion)) return null;
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email,
    role: user.role,
    status: user.status,
    orgId: user.orgId ?? null,
    locale: isLocale(user.locale) ? user.locale : 'en',
    sessionVersion: user.sessionVersion,
  };
}

export function applyUserToToken(token: JWT, user: SessionUser, now = Date.now()): JWT {
  token.uid = user.id;
  token.sub = user.id;
  token.name = user.name;
  token.email = user.email;
  token.role = user.role;
  token.status = user.status;
  token.orgId = user.orgId;
  token.locale = user.locale;
  token.sv = user.sessionVersion;
  token.refreshedAt = now;
  // OAuth providers may put a (large) profile photo here; the app never uses it.
  delete token.picture;
  return token;
}

/** The session user stored in the JWT, or null when the token is incomplete / foreign. */
export function sessionUserFromToken(token: JWT): SessionUser | null {
  if (!token.uid || !token.email || !isRole(token.role) || !isStatus(token.status)) return null;
  // Sessions issued before session versions existed have no `sv`: every user was at version 0
  // then, so 0 is exactly what they were issued with (and the next refresh checks it).
  if (token.sv !== undefined && !isSessionVersion(token.sv)) return null;
  return {
    id: token.uid,
    name: token.name ?? '',
    email: token.email,
    role: token.role,
    status: token.status,
    orgId: token.orgId ?? null,
    locale: isLocale(token.locale) ? token.locale : 'en',
    sessionVersion: token.sv ?? 0,
  };
}

export function isRefreshDue(refreshedAt: number | undefined, now = Date.now()): boolean {
  return typeof refreshedAt !== 'number' || now - refreshedAt >= USER_REFRESH_INTERVAL_MS;
}

/** Result of reloading a user from the API. */
export type UserLookup =
  | { kind: 'found'; user: AuthUser }
  /** 404: the user no longer exists. */
  | { kind: 'gone' }
  /** API unreachable or erroring: keep the current session and retry later. */
  | { kind: 'unavailable' };

/**
 * The periodic part of the jwt callback: returns the (possibly refreshed) token, or null to end
 * the session when the user is gone or disabled, or when the user's sessionVersion is no longer
 * the one this session was established with (sessions revoked, e.g. by a password reset).
 * `force` bypasses the 5-minute interval.
 */
export async function refreshSessionToken(
  token: JWT,
  options: { force?: boolean; now?: number; lookup: (userId: string) => Promise<UserLookup> },
): Promise<JWT | null> {
  const current = sessionUserFromToken(token);
  if (!current || current.status === 'DISABLED') return null;

  const now = options.now ?? Date.now();
  if (!options.force && !isRefreshDue(token.refreshedAt, now)) return token;

  const result = await options.lookup(current.id);
  if (result.kind === 'gone') return null;
  if (result.kind === 'unavailable') return token;
  if (result.user.id !== current.id || result.user.status === 'DISABLED') return null;
  if (result.user.sessionVersion !== current.sessionVersion) return null;
  return applyUserToToken(token, toSessionUser(result.user), now);
}
