// Maps Auth.js errors and API error codes to keys of the `errors` message namespace.
import { ERROR_CODES, type ErrorCode } from '@loons/shared';

/** Extra, web-only keys in the `errors` namespace. */
export const AUTH_ONLY_ERROR_KEYS = ['SIGNIN_FAILED', 'CONFIGURATION'] as const;
export type AuthErrorKey = ErrorCode | (typeof AUTH_ONLY_ERROR_KEYS)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isAuthErrorKey(value: unknown): value is AuthErrorKey {
  return (
    isErrorCode(value) ||
    (typeof value === 'string' && (AUTH_ONLY_ERROR_KEYS as readonly string[]).includes(value))
  );
}

/** Auth.js error types that mean the server is misconfigured (never the user's fault). */
const CONFIGURATION_TYPES = new Set([
  'Configuration',
  'MissingSecret',
  'MissingAdapter',
  'MissingAdapterMethods',
  'MissingAuthorize',
  'InvalidEndpoints',
  'UnsupportedStrategy',
  'InvalidCallbackUrl',
  'UntrustedHost',
  'ExperimentalFeatureNotEnabled',
  'DuplicateConditionalUI',
  'MissingWebAuthnAutocomplete',
  'ErrorPageLoop',
  'EventError',
  'JWTSessionError',
  'SessionTokenError',
  'AdapterError',
  'InvalidProvider',
  'UnknownAction',
]);

/**
 * Resolves the message key for a failed sign-in.
 *
 * @param error Auth.js error type (`AuthError.type` or the `?error=` query param), or one of our
 *              own codes when the `signIn` callback redirected with `?error=<CODE>`.
 * @param code  `CredentialsSignin.code` (`?code=`), which carries our API error code.
 */
export function resolveAuthErrorKey(
  error: string | null | undefined,
  code?: string | null,
): AuthErrorKey | null {
  if (!error) return null;
  if (isAuthErrorKey(error)) return error;
  switch (error) {
    case 'CredentialsSignin':
      // Our Credentials provider sets `code` to the API error code; anything else stays generic.
      return isErrorCode(code) ? code : 'INVALID_CREDENTIALS';
    case 'AccessDenied':
      return 'FORBIDDEN';
    case 'CallbackRouteError':
      return 'INTERNAL';
    default:
      return CONFIGURATION_TYPES.has(error) ? 'CONFIGURATION' : 'SIGNIN_FAILED';
  }
}

/** API codes a password sign-in may show as-is; everything else is generic. */
const LOGIN_CODES = new Set<ErrorCode>([
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'STAFF_MUST_USE_SSO',
  'CLIENT_PORTAL_ONLY',
  'RATE_LIMITED',
  // The API's sign-in throttling is unavailable (fails closed): "try again later".
  'SERVICE_UNAVAILABLE',
]);

export function loginErrorCode(apiCode: ErrorCode): ErrorCode {
  if (LOGIN_CODES.has(apiCode)) return apiCode;
  if (
    apiCode === 'VALIDATION_FAILED' ||
    apiCode === 'BAD_REQUEST' ||
    apiCode === 'UNAUTHENTICATED'
  ) {
    return 'INVALID_CREDENTIALS';
  }
  return 'INTERNAL';
}

/** API codes an OAuth (Google / Entra ID) sign-in may show as-is. */
const OAUTH_CODES = new Set<ErrorCode>([
  'STAFF_DOMAIN_REQUIRED',
  'STAFF_MUST_USE_SSO',
  'ACCOUNT_DISABLED',
  'EMAIL_NOT_VERIFIED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
]);

export function oauthErrorKey(apiCode: ErrorCode): AuthErrorKey {
  if (OAUTH_CODES.has(apiCode)) return apiCode;
  if (apiCode === 'VALIDATION_FAILED' || apiCode === 'BAD_REQUEST') return 'SIGNIN_FAILED';
  return 'INTERNAL';
}
