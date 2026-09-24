import { z } from 'zod';
import { LOCALES, ROLES, STAFF_ROLES, USER_STATUSES, type Role, type StaffRole } from './enums.ts';

/** Default staff email domain; the apps read the effective value from STAFF_EMAIL_DOMAIN. */
export const DEFAULT_STAFF_EMAIL_DOMAIN = 'loonsgroup.com';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : normalizeEmail(email.slice(at + 1));
}

export function isStaffEmail(email: string, staffDomain = DEFAULT_STAFF_EMAIL_DOMAIN): boolean {
  return emailDomain(email) === staffDomain.toLowerCase();
}

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly Role[]).includes(role);
}

/** The user shape the API returns to the web app after a successful sign-in / OAuth resolution. */
export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  orgId: z.uuid().nullable(),
  locale: z.enum(LOCALES),
  teamIds: z.array(z.uuid()),
  /**
   * The user's current session version. Web sessions and API tokens remember the value they
   * were issued with (`sv`); once the API increments it (password reset, later admin actions)
   * every older session and token stops working.
   */
  sessionVersion: z.number().int().nonnegative(),
  /**
   * Whether the user has proved ownership of their mailbox (email link, password reset, or a
   * verified Google / Entra identity). Unverified clients can sign in but see nothing until verified.
   */
  emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** Which sign-in page the credentials were submitted from. */
export const LOGIN_AUDIENCES = ['client', 'staff'] as const;
export type LoginAudience = (typeof LOGIN_AUDIENCES)[number];

/**
 * Claims of the short-lived API access token minted by the web app (HS256, API_JWT_SECRET).
 * The API treats `role` as a hint only — it reloads the user from the database on every request.
 * `sv` is the user's session version when the web session was established; the API rejects the
 * token once the user's current `sessionVersion` differs.
 */
export const apiTokenClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  sv: z.number().int().nonnegative(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
  jti: z.string().optional(),
});
export type ApiTokenClaims = z.infer<typeof apiTokenClaimsSchema>;

/** Header carrying the server-to-server key for /internal/* API routes. */
export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
