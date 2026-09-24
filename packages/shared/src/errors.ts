import { z } from 'zod';

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  /** A dependency the request needs (e.g. the auth rate-limit store) is unavailable: retry later. */
  'SERVICE_UNAVAILABLE',
  // auth
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'EMAIL_TAKEN',
  'STAFF_MUST_USE_SSO',
  'STAFF_DOMAIN_REQUIRED',
  'CLIENT_PORTAL_ONLY',
  /** The client has not verified their email address yet (403 on everything except /me). */
  'EMAIL_NOT_VERIFIED',
  'RESET_TOKEN_INVALID',
  'VERIFY_TOKEN_INVALID',
  /**
   * A valid email confirmation link opened outside its own account's session (signed out, or
   * signed in as someone else): sign in to that account to confirm it.
   */
  'VERIFY_WRONG_ACCOUNT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every non-2xx API response has this body. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
