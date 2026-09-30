import type { z } from 'zod';
import { apiErrorSchema, type ErrorCode } from '@loons/shared';

/** One entry of a 400 VALIDATION_FAILED `details` array (request schema or business rule). */
export interface ValidationIssue {
  /** Where the invalid value was: body, querystring, params or headers. */
  location: string;
  path: Array<string | number>;
  /** i18n key (e.g. "validation.required") or a zod default message. */
  message: string;
  /** Machine-readable reason (zod issue code, or a rule name such as "security_category"). */
  code: string;
}

/** An error with a contract error code; the error handler turns it into the API error body. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  badRequest: (message = 'Bad request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  /** 400 VALIDATION_FAILED for business-rule checks (same body as schema validation errors). */
  validation: (issues: ValidationIssue[]) =>
    new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', issues),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have access to this resource') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'Conflict') => new AppError(409, 'CONFLICT', message),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      429,
      'RATE_LIMITED',
      `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      {
        retryAfterSeconds,
      },
    ),
  internal: () => new AppError(500, 'INTERNAL', 'Something went wrong. Please try again.'),
  notImplemented: (message = 'This part of the admin is not available yet.') =>
    new AppError(501, 'NOT_IMPLEMENTED', message),
  serviceUnavailable: (retryAfterSeconds: number) =>
    new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      'This service is temporarily unavailable. Try again in a few minutes.',
      {
        retryAfterSeconds,
      },
    ),

  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'),
  accountDisabled: (status = 403) =>
    new AppError(status, 'ACCOUNT_DISABLED', 'This account has been disabled.'),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.'),
  staffMustUseSso: () =>
    new AppError(
      403,
      'STAFF_MUST_USE_SSO',
      'Loons staff sign in with Microsoft on the staff login page.',
    ),
  staffDomainRequired: () =>
    new AppError(403, 'STAFF_DOMAIN_REQUIRED', 'Staff sign-in requires a Loons Group account.'),
  clientPortalOnly: () =>
    new AppError(403, 'CLIENT_PORTAL_ONLY', 'Client accounts sign in on the client login page.'),
  emailNotVerified: () =>
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'This email address is not verified.'),
  resetTokenInvalid: () =>
    new AppError(
      400,
      'RESET_TOKEN_INVALID',
      'This reset link is invalid or has expired. Request a new one.',
    ),
  verifyTokenInvalid: () =>
    new AppError(
      400,
      'VERIFY_TOKEN_INVALID',
      'This verification link is invalid or has expired. Request a new one.',
    ),
  verifyWrongAccount: () =>
    new AppError(
      403,
      'VERIFY_WRONG_ACCOUNT',
      'This link confirms the address of another account. Sign in to that account to confirm it.',
    ),
};

/** Response schema for every non-2xx reply (documentation + serialization). */
export const errorResponseSchema = apiErrorSchema;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** `{ 401: errorResponseSchema, 403: … }` for a route's `response` schema. */
export function errorResponses<const S extends readonly number[]>(
  ...statuses: S
): { [K in S[number]]: typeof errorResponseSchema } {
  return Object.fromEntries(statuses.map((s) => [s, errorResponseSchema])) as {
    [K in S[number]]: typeof errorResponseSchema;
  };
}

/** Default code for a bare HTTP status (framework / plugin errors without our code). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'NOT_IMPLEMENTED';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}
