import { ERROR_CODES } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import arAuth from '@/messages/ar/auth.json';
import arErrors from '@/messages/ar/errors.json';
import arValidation from '@/messages/ar/validation.json';
import enAuth from '@/messages/en/auth.json';
import enErrors from '@/messages/en/errors.json';
import enValidation from '@/messages/en/validation.json';
import {
  AUTH_ONLY_ERROR_KEYS,
  isAuthErrorKey,
  loginErrorCode,
  oauthErrorKey,
  resolveAuthErrorKey,
  verifyEmailErrorCode,
} from './errors';
import {
  forgotPasswordFormSchema,
  loginFormSchema,
  resetPasswordFormSchema,
  signupFormSchema,
} from './forms';

describe('resolveAuthErrorKey', () => {
  it('returns null when there is no error', () => {
    expect(resolveAuthErrorKey(undefined)).toBeNull();
    expect(resolveAuthErrorKey(null)).toBeNull();
    expect(resolveAuthErrorKey('')).toBeNull();
  });

  it('passes through our own codes (redirects from the OAuth signIn callback)', () => {
    expect(resolveAuthErrorKey('STAFF_DOMAIN_REQUIRED')).toBe('STAFF_DOMAIN_REQUIRED');
    expect(resolveAuthErrorKey('STAFF_MUST_USE_SSO')).toBe('STAFF_MUST_USE_SSO');
    expect(resolveAuthErrorKey('EMAIL_NOT_VERIFIED')).toBe('EMAIL_NOT_VERIFIED');
    expect(resolveAuthErrorKey('SIGNIN_FAILED')).toBe('SIGNIN_FAILED');
  });

  it('uses the API code carried by CredentialsSignin, generic otherwise', () => {
    expect(resolveAuthErrorKey('CredentialsSignin', 'ACCOUNT_DISABLED')).toBe('ACCOUNT_DISABLED');
    expect(resolveAuthErrorKey('CredentialsSignin', 'RATE_LIMITED')).toBe('RATE_LIMITED');
    expect(resolveAuthErrorKey('CredentialsSignin', 'SERVICE_UNAVAILABLE')).toBe(
      'SERVICE_UNAVAILABLE',
    );
    expect(resolveAuthErrorKey('CredentialsSignin', 'credentials')).toBe('INVALID_CREDENTIALS');
    expect(resolveAuthErrorKey('CredentialsSignin')).toBe('INVALID_CREDENTIALS');
    expect(resolveAuthErrorKey('CredentialsSignin', '<script>')).toBe('INVALID_CREDENTIALS');
  });

  it('maps Auth.js error types', () => {
    expect(resolveAuthErrorKey('AccessDenied')).toBe('FORBIDDEN');
    expect(resolveAuthErrorKey('CallbackRouteError')).toBe('INTERNAL');
    expect(resolveAuthErrorKey('Configuration')).toBe('CONFIGURATION');
    expect(resolveAuthErrorKey('MissingSecret')).toBe('CONFIGURATION');
    expect(resolveAuthErrorKey('OAuthCallbackError')).toBe('SIGNIN_FAILED');
    expect(resolveAuthErrorKey('OAuthAccountNotLinked')).toBe('SIGNIN_FAILED');
    expect(resolveAuthErrorKey('Verification')).toBe('SIGNIN_FAILED');
  });

  it('never echoes arbitrary query-string values', () => {
    expect(resolveAuthErrorKey('<img src=x onerror=alert(1)>')).toBe('SIGNIN_FAILED');
    expect(resolveAuthErrorKey('toString')).toBe('SIGNIN_FAILED');
  });
});

describe('loginErrorCode', () => {
  it('keeps codes a password sign-in may show', () => {
    for (const code of [
      'INVALID_CREDENTIALS',
      'ACCOUNT_DISABLED',
      'STAFF_MUST_USE_SSO',
      'CLIENT_PORTAL_ONLY',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
    ] as const) {
      expect(loginErrorCode(code)).toBe(code);
    }
  });

  it('shows "try again later" when the API cannot throttle sign-ins (fails closed, 503)', () => {
    expect(loginErrorCode('SERVICE_UNAVAILABLE')).toBe('SERVICE_UNAVAILABLE');
    expect(oauthErrorKey('SERVICE_UNAVAILABLE')).toBe('SERVICE_UNAVAILABLE');
    expect(resolveAuthErrorKey('SERVICE_UNAVAILABLE')).toBe('SERVICE_UNAVAILABLE');
    expect(enErrors.SERVICE_UNAVAILABLE).toMatch(/try again/i);
    expect(arErrors.SERVICE_UNAVAILABLE).toMatch(/حاول مرة أخرى/);
  });

  it('keeps validation problems generic and hides everything else', () => {
    expect(loginErrorCode('VALIDATION_FAILED')).toBe('INVALID_CREDENTIALS');
    expect(loginErrorCode('UNAUTHENTICATED')).toBe('INVALID_CREDENTIALS');
    expect(loginErrorCode('NOT_FOUND')).toBe('INTERNAL');
    expect(loginErrorCode('INTERNAL')).toBe('INTERNAL');
  });
});

describe('oauthErrorKey', () => {
  it('keeps the rejections the API documents for OAuth', () => {
    for (const code of [
      'STAFF_DOMAIN_REQUIRED',
      'STAFF_MUST_USE_SSO',
      'ACCOUNT_DISABLED',
      'EMAIL_NOT_VERIFIED',
      'FORBIDDEN',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
    ] as const) {
      expect(oauthErrorKey(code)).toBe(code);
    }
    expect(oauthErrorKey('VALIDATION_FAILED')).toBe('SIGNIN_FAILED');
    expect(oauthErrorKey('INTERNAL')).toBe('INTERNAL');
    expect(oauthErrorKey('CONFLICT')).toBe('INTERNAL');
  });
});

describe('verifyEmailErrorCode', () => {
  it('shows an invalid / expired link for any token the API refuses', () => {
    expect(verifyEmailErrorCode('VERIFY_TOKEN_INVALID')).toBe('VERIFY_TOKEN_INVALID');
    expect(verifyEmailErrorCode('VALIDATION_FAILED')).toBe('VERIFY_TOKEN_INVALID');
    expect(verifyEmailErrorCode('BAD_REQUEST')).toBe('VERIFY_TOKEN_INVALID');
  });

  it('keeps throttling codes and hides everything else', () => {
    expect(verifyEmailErrorCode('RATE_LIMITED')).toBe('RATE_LIMITED');
    expect(verifyEmailErrorCode('SERVICE_UNAVAILABLE')).toBe('SERVICE_UNAVAILABLE');
    expect(verifyEmailErrorCode('NOT_FOUND')).toBe('INTERNAL');
    expect(verifyEmailErrorCode('INTERNAL')).toBe('INTERNAL');
  });
});

describe('error messages', () => {
  const keys = [...ERROR_CODES, ...AUTH_ONLY_ERROR_KEYS];

  it('has a friendly EN and AR sentence for every error code and web-only key', () => {
    for (const key of keys) {
      expect(isAuthErrorKey(key)).toBe(true);
      expect(enErrors[key], `en ${key}`).toMatch(/\S/);
      expect(arErrors[key], `ar ${key}`).toMatch(/\S/);
    }
  });

  it('has no stray keys', () => {
    expect(Object.keys(enErrors).sort()).toEqual([...keys].sort());
  });
});

function flatValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(flatValues);
}

function flatKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => flatKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe('EN/AR parity', () => {
  it.each([
    ['auth', enAuth, arAuth],
    ['validation', enValidation, arValidation],
    ['errors', enErrors, arErrors],
  ])('%s has the same keys in both languages', (_ns, en, ar) => {
    expect(flatKeys(ar).sort()).toEqual(flatKeys(en).sort());
  });

  it('isolates LTR emails and domains inside Arabic text (RTL-1)', () => {
    // LRI … PDI; without them "@loonsgroup.com" renders as "loonsgroup.com@".
    const LRI = String.fromCharCode(0x2066);
    const PDI = String.fromCharCode(0x2069);
    const isolated = new RegExp(`${LRI}[^\\s${PDI}]*@[^\\s${PDI}]*${PDI}`);
    const arabic = [arAuth, arErrors, arValidation].flatMap((ns) => flatValues(ns));
    const withAt = arabic.filter((value) => value.includes('@'));
    expect(withAt.length).toBeGreaterThan(0);
    for (const value of withAt) {
      expect(value, value).toMatch(isolated);
    }
    expect(arErrors.STAFF_DOMAIN_REQUIRED).toContain(`${LRI}@loonsgroup.com${PDI}`);
    // Emails interpolated at runtime sit in <strong>, which the pages render with dir="ltr".
    expect(arAuth.verifyEmail.body).toContain('<strong>{email}</strong>');
    expect(arAuth.verifyEmail.resent).toContain('<strong>{email}</strong>');
  });

  it('keeps the design arrows mirrored for RTL', () => {
    expect(enAuth.login.switchAction.endsWith('→')).toBe(true);
    expect(arAuth.login.switchAction.endsWith('←')).toBe(true);
    expect(enAuth.forgot.back.startsWith('←')).toBe(true);
    expect(arAuth.forgot.back.startsWith('→')).toBe(true);
    expect(enAuth.confirmEmail.back.startsWith('←')).toBe(true);
    expect(arAuth.confirmEmail.back.startsWith('→')).toBe(true);
  });
});

describe('validation keys produced by the form schemas', () => {
  const messages = new Set<string>();
  const collect = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
    result.error?.issues.forEach((issue) => messages.add(issue.message));

  collect(loginFormSchema.safeParse({ email: 'nope', password: '' }));
  collect(signupFormSchema.safeParse({ name: 'A', company: '', email: 'x', password: 'short' }));
  collect(
    signupFormSchema.safeParse({
      name: 'Ab',
      company: 'C',
      email: 'a@b.co',
      password: 'longenoughpassword',
    }),
  );
  collect(
    signupFormSchema.safeParse({
      name: 'Ab',
      company: 'C',
      email: 'a@b.co',
      password: `a1${'x'.repeat(200)}`,
    }),
  );
  collect(forgotPasswordFormSchema.safeParse({ email: '' }));
  collect(
    resetPasswordFormSchema.safeParse({ password: 'abcdefgh12', confirmPassword: 'different1' }),
  );
  collect(resetPasswordFormSchema.safeParse({ password: 'abcdefgh12', confirmPassword: '' }));

  it('emits only i18n keys that exist in the validation namespace', () => {
    expect([...messages].sort()).toEqual([
      'validation.companyRequired',
      'validation.email',
      'validation.nameMin',
      'validation.passwordComplexity',
      'validation.passwordMax',
      'validation.passwordMin',
      'validation.passwordMismatch',
      'validation.required',
    ]);
    for (const message of messages) {
      const key = message.replace(/^validation\./, '') as keyof typeof enValidation;
      expect(enValidation[key], message).toBeTruthy();
      expect(arValidation[key], message).toBeTruthy();
    }
  });
});
