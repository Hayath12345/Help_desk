'use server';
// Server actions behind the auth screens. Every action re-validates its input: the client-side
// checks are a convenience, not a guarantee.

import {
  WEB_ROUTES,
  homePathFor,
  isStaffRole,
  resetPasswordSchema,
  type ErrorCode,
  type LoginAudience,
} from '@loons/shared';
import type { Route } from 'next';
import { AuthError, CredentialsSignin } from 'next-auth';
import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { signIn, signOut, unstable_update } from '@/auth';
import { PROVIDER_IDS } from '@/auth.config';
import { ApiRequestError, validationIssues } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { isDevStaffLoginEnabled, isEntraConfigured, isGoogleConfigured } from '@/lib/auth/env';
import { resolveAuthErrorKey, type AuthErrorKey } from '@/lib/auth/errors';
import {
  fieldErrorsFrom,
  forgotPasswordFormSchema,
  formText,
  loginFormSchema,
  resetPasswordFormSchema,
  signupFormSchema,
  type AuthFormState,
} from '@/lib/auth/forms';
import { destinationAfterSignIn, postSignInRedirect } from '@/lib/auth/routing';
import { parseUserResponse, type SessionUser } from '@/lib/auth/session-user';
import { captureSignedInUser } from '@/lib/auth/sign-in-capture';
import { getCurrentUser } from '@/lib/session';

type LoginField = 'email' | 'password';
type SignupField = 'name' | 'company' | 'email' | 'password';
type ForgotField = 'email';
type ResetField = 'password' | 'confirmPassword';

function withError(page: string, key: AuthErrorKey): Route {
  return `${page}?${new URLSearchParams({ error: key }).toString()}` as Route;
}

function authErrorKey(error: AuthError): AuthErrorKey {
  const code = error instanceof CredentialsSignin ? error.code : undefined;
  return resolveAuthErrorKey(error.type, code) ?? 'SIGNIN_FAILED';
}

/** Maps an API failure of a form submission to form/field errors. */
function apiFormError<Field extends string>(
  error: ApiRequestError,
  allowed: readonly ErrorCode[],
): AuthFormState<Field> {
  if (error.code === 'VALIDATION_FAILED') {
    const fieldErrors = fieldErrorsFrom(validationIssues(error)) as Partial<Record<Field, string>>;
    return { status: 'error', error: 'VALIDATION_FAILED', fieldErrors };
  }
  return { status: 'error', error: allowed.includes(error.code) ? error.code : 'INTERNAL' };
}

// ── Password sign-in ────────────────────────────────────────────────────────

async function credentialsSignIn(
  audience: LoginAudience,
  formData: FormData,
): Promise<AuthFormState<LoginField>> {
  const parsed = loginFormSchema.safeParse({
    email: formText(formData, 'email'),
    password: formText(formData, 'password'),
  });
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  let user: SessionUser | null;
  try {
    ({ user } = await captureSignedInUser(() =>
      signIn(PROVIDER_IDS.credentials, {
        email: parsed.data.email,
        password: parsed.data.password,
        audience,
        redirect: false,
      }),
    ));
  } catch (error) {
    if (error instanceof AuthError) return { status: 'error', error: authErrorKey(error) };
    // Anything else (including Next's control-flow errors) must propagate untouched.
    throw error;
  }
  if (!user) return { status: 'error', error: 'SIGNIN_FAILED' };

  // Go straight to the final page (a redirect chain would leave the browser URL at "/").
  redirect(destinationAfterSignIn(user, formText(formData, 'callbackUrl')) as Route);
}

/** Client sign-in (/login). */
export async function clientLoginAction(
  _prev: AuthFormState<LoginField>,
  formData: FormData,
): Promise<AuthFormState<LoginField>> {
  return credentialsSignIn('client', formData);
}

/** Development-only staff password sign-in (/staff/login when Entra ID is not configured). */
export async function staffLoginAction(
  _prev: AuthFormState<LoginField>,
  formData: FormData,
): Promise<AuthFormState<LoginField>> {
  if (!isDevStaffLoginEnabled()) return { status: 'error', error: 'STAFF_MUST_USE_SSO' };
  return credentialsSignIn('staff', formData);
}

// ── OAuth ───────────────────────────────────────────────────────────────────

async function oauthSignIn(
  providerId: string,
  configured: boolean,
  errorPage: string,
  formData: FormData,
): Promise<void> {
  if (!configured) redirect(withError(errorPage, 'CONFIGURATION'));
  try {
    await signIn(providerId, { redirectTo: postSignInRedirect(formText(formData, 'callbackUrl')) });
  } catch (error) {
    if (error instanceof AuthError) redirect(withError(errorPage, authErrorKey(error)));
    throw error;
  }
}

export async function googleSignInAction(formData: FormData): Promise<void> {
  await oauthSignIn(PROVIDER_IDS.google, isGoogleConfigured(), WEB_ROUTES.clientLogin, formData);
}

export async function microsoftSignInAction(formData: FormData): Promise<void> {
  await oauthSignIn(
    PROVIDER_IDS.microsoftEntraId,
    isEntraConfigured(),
    WEB_ROUTES.staffLogin,
    formData,
  );
}

// ── Sign-up ─────────────────────────────────────────────────────────────────

export async function registerAction(
  _prev: AuthFormState<SignupField>,
  formData: FormData,
): Promise<AuthFormState<SignupField>> {
  const parsed = signupFormSchema.safeParse({
    name: formText(formData, 'name'),
    company: formText(formData, 'company'),
    email: formText(formData, 'email'),
    password: formText(formData, 'password'),
  });
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  try {
    const body = await internalApiFetch<unknown>('/internal/auth/register', {
      method: 'POST',
      json: { ...parsed.data, locale: await getLocale() },
    });
    if (!parseUserResponse(body)) return { status: 'error', error: 'INTERNAL' };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiFormError<SignupField>(error, [
        'EMAIL_TAKEN',
        'STAFF_MUST_USE_SSO',
        'RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
      ]);
    }
    throw error;
  }

  // The account exists now: sign straight in. Pending accounts land on the approval screen.
  let user: SessionUser | null;
  try {
    ({ user } = await captureSignedInUser(() =>
      signIn(PROVIDER_IDS.credentials, {
        email: parsed.data.email,
        password: parsed.data.password,
        audience: 'client',
        redirect: false,
      }),
    ));
  } catch (error) {
    if (error instanceof AuthError)
      redirect(withError(WEB_ROUTES.clientLogin, authErrorKey(error)));
    throw error;
  }
  if (!user) redirect(withError(WEB_ROUTES.clientLogin, 'SIGNIN_FAILED'));
  redirect(destinationAfterSignIn(user, null) as Route);
}

// ── Password reset ──────────────────────────────────────────────────────────

export async function forgotPasswordAction(
  _prev: AuthFormState<ForgotField>,
  formData: FormData,
): Promise<AuthFormState<ForgotField>> {
  const parsed = forgotPasswordFormSchema.safeParse({ email: formText(formData, 'email') });
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }
  try {
    // Always 202 — the API never reveals whether the address has an account.
    await internalApiFetch('/internal/auth/password/forgot', {
      method: 'POST',
      json: { email: parsed.data.email, locale: await getLocale() },
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiFormError<ForgotField>(error, ['RATE_LIMITED', 'SERVICE_UNAVAILABLE']);
    }
    throw error;
  }
  return { status: 'success', email: parsed.data.email };
}

export async function resetPasswordAction(
  _prev: AuthFormState<ResetField>,
  formData: FormData,
): Promise<AuthFormState<ResetField>> {
  const parsed = resetPasswordFormSchema.safeParse({
    password: formText(formData, 'password'),
    confirmPassword: formText(formData, 'confirmPassword'),
  });
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }
  const body = resetPasswordSchema.safeParse({
    token: formText(formData, 'token'),
    password: parsed.data.password,
  });
  if (!body.success) {
    const tokenIssue = body.error.issues.some((issue) => issue.path[0] === 'token');
    return tokenIssue
      ? { status: 'error', error: 'RESET_TOKEN_INVALID' }
      : { status: 'error', fieldErrors: fieldErrorsFrom(body.error.issues) };
  }

  try {
    await internalApiFetch('/internal/auth/password/reset', { method: 'POST', json: body.data });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.code === 'VALIDATION_FAILED') {
        const issues = validationIssues(error);
        if (issues.some((issue) => issue.path[0] === 'token')) {
          return { status: 'error', error: 'RESET_TOKEN_INVALID' };
        }
      }
      return apiFormError<ResetField>(error, [
        'RESET_TOKEN_INVALID',
        'RATE_LIMITED',
        'SERVICE_UNAVAILABLE',
      ]);
    }
    throw error;
  }
  redirect(`${WEB_ROUTES.clientLogin}?reset=1` as Route);
}

// ── Session ─────────────────────────────────────────────────────────────────

/** Signs out → `/login`, or `/staff/login` for staff. */
export async function signOutAction(): Promise<void> {
  const user = await getCurrentUser();
  const redirectTo =
    user && isStaffRole(user.role) ? WEB_ROUTES.staffLogin : WEB_ROUTES.clientLogin;
  await signOut({ redirectTo });
}

/** Re-reads the account from the API now (the pending screen's "Check again"). */
export async function refreshSessionAction(): Promise<void> {
  const session = await unstable_update({});
  const user = session?.user;
  if (!user?.role || !user.status || user.status === 'DISABLED') {
    redirect(WEB_ROUTES.clientLogin as Route);
  }
  if (user.status === 'ACTIVE') redirect(homePathFor(user.role) as Route);
  redirect(`${WEB_ROUTES.pendingApproval}?checked=1` as Route);
}
