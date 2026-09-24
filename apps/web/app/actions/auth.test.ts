// Server actions of the email-verification and password-reset flows, with Auth.js, the session
// and the API mocked. Redirects surface as thrown RedirectSignal errors (like Next's redirect()).
import type { AuthUser } from '@loons/shared';
import type { Session } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn, signOut, unstable_update } from '@/auth';
import { ApiRequestError } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { initialAuthFormState } from '@/lib/auth/forms';
import { recordSignedInUser } from '@/lib/auth/sign-in-capture';
import { getCurrentUser, type CurrentUser } from '@/lib/session';
import {
  confirmEmailAction,
  recheckEmailVerificationAction,
  refreshSessionAction,
  registerAction,
  resendVerificationEmailAction,
  resetPasswordAction,
} from './auth';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'ar' }));
// next-auth itself does not load outside Next's bundler; the actions only need its error classes.
vi.mock('next-auth', () => {
  class AuthError extends Error {
    type = 'AuthError';
  }
  class CredentialsSignin extends AuthError {
    code = 'credentials';
  }
  return { AuthError, CredentialsSignin };
});
vi.mock('@/auth', () => ({ signIn: vi.fn(), signOut: vi.fn(), unstable_update: vi.fn() }));
vi.mock('@/lib/session', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/api/internal', () => ({ internalApiFetch: vi.fn() }));

const apiFetch = vi.mocked(internalApiFetch);
const currentUser = vi.mocked(getCurrentUser);
const update = vi.mocked(unstable_update);
const signOutMock = vi.mocked(signOut);
const signInMock = vi.mocked(signIn);

const USER_ID = '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'A'.repeat(43);

const apiUser: AuthUser = {
  id: USER_ID,
  email: 'new.client@hamad.qa',
  name: 'New Client',
  role: 'CLIENT',
  status: 'ACTIVE',
  orgId: '0b8f0a52-8c0e-4b7a-9d55-7c2f7e3c1a11',
  locale: 'en',
  teamIds: [],
  sessionVersion: 0,
  emailVerified: true,
};

function sessionUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: USER_ID,
    name: apiUser.name,
    email: apiUser.email,
    role: 'CLIENT',
    status: 'ACTIVE',
    orgId: apiUser.orgId,
    locale: 'en',
    sessionVersion: 0,
    emailVerified: false,
    ...overrides,
  };
}

function sessionOf(user: CurrentUser): Session {
  return { user, expires: '2099-01-01T00:00:00.000Z' } as Session;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Runs an action that must redirect and returns where to. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue(null);
});

describe('confirmEmailAction', () => {
  const confirm = (token = TOKEN) => confirmEmailAction(initialAuthFormState, form({ token }));

  it('rejects a malformed token without calling the API', async () => {
    await expect(confirm('short')).resolves.toEqual({
      status: 'error',
      error: 'VERIFY_TOKEN_INVALID',
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('POSTs the token and shows "invalid or expired" when the API refuses it', async () => {
    apiFetch.mockRejectedValueOnce(new ApiRequestError(400, 'VERIFY_TOKEN_INVALID', 'used'));
    await expect(confirm()).resolves.toEqual({ status: 'error', error: 'VERIFY_TOKEN_INVALID' });
    expect(apiFetch).toHaveBeenCalledWith('/internal/auth/email/verify', {
      method: 'POST',
      json: { token: TOKEN },
    });

    apiFetch.mockRejectedValueOnce(new ApiRequestError(429, 'RATE_LIMITED', 'slow down'));
    await expect(confirm()).resolves.toEqual({ status: 'error', error: 'RATE_LIMITED' });
  });

  it('signed out: continues at /login?verified=1', async () => {
    apiFetch.mockResolvedValueOnce({ user: apiUser });
    await expect(redirectOf(confirm)).resolves.toBe('/login?verified=1');
    expect(update).not.toHaveBeenCalled();
  });

  it('same user signed in: reloads the session and goes home', async () => {
    apiFetch.mockResolvedValueOnce({ user: apiUser });
    currentUser.mockResolvedValue(sessionUser());
    update.mockResolvedValueOnce(sessionOf(sessionUser({ emailVerified: true })));
    await expect(redirectOf(confirm)).resolves.toBe('/tickets');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('same user awaiting approval: goes to /pending after confirming', async () => {
    apiFetch.mockResolvedValueOnce({ user: { ...apiUser, status: 'PENDING_APPROVAL' } });
    currentUser.mockResolvedValue(sessionUser({ status: 'PENDING_APPROVAL' }));
    update.mockResolvedValueOnce(
      sessionOf(sessionUser({ status: 'PENDING_APPROVAL', emailVerified: true })),
    );
    await expect(redirectOf(confirm)).resolves.toBe('/pending');
  });

  it('another account signed in: confirms, then says so on the page', async () => {
    apiFetch.mockResolvedValueOnce({ user: apiUser });
    currentUser.mockResolvedValue(sessionUser({ id: OTHER_ID, email: 'someone@else.qa' }));
    await expect(confirm()).resolves.toEqual({ status: 'success', email: apiUser.email });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('resendVerificationEmailAction', () => {
  const resend = () => resendVerificationEmailAction(initialAuthFormState, form({}));

  it('asks the API to email the signed-in client, in the UI language', async () => {
    currentUser.mockResolvedValue(sessionUser());
    apiFetch.mockResolvedValueOnce({ ok: true });
    await expect(resend()).resolves.toEqual({ status: 'success', email: apiUser.email });
    expect(apiFetch).toHaveBeenCalledWith('/internal/auth/email/resend', {
      method: 'POST',
      json: { userId: USER_ID, locale: 'ar' },
    });
  });

  it('shows the rate limit', async () => {
    currentUser.mockResolvedValue(sessionUser());
    apiFetch.mockRejectedValueOnce(new ApiRequestError(429, 'RATE_LIMITED', 'slow down'));
    await expect(resend()).resolves.toEqual({ status: 'error', error: 'RATE_LIMITED' });
  });

  it('needs an unverified, signed-in client', async () => {
    await expect(redirectOf(resend)).resolves.toBe('/login');
    currentUser.mockResolvedValue(sessionUser({ emailVerified: true }));
    await expect(redirectOf(resend)).resolves.toBe('/tickets');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('recheck actions ("I\'ve verified — continue", "Check again")', () => {
  it('stays on /verify-email with a notice while still unverified', async () => {
    update.mockResolvedValueOnce(sessionOf(sessionUser()));
    await expect(redirectOf(recheckEmailVerificationAction)).resolves.toBe(
      '/verify-email?checked=1',
    );
  });

  it('continues to the landing page once verified', async () => {
    update.mockResolvedValueOnce(sessionOf(sessionUser({ emailVerified: true })));
    await expect(redirectOf(recheckEmailVerificationAction)).resolves.toBe('/tickets');
    update.mockResolvedValueOnce(
      sessionOf(sessionUser({ emailVerified: true, status: 'PENDING_APPROVAL' })),
    );
    await expect(redirectOf(recheckEmailVerificationAction)).resolves.toBe('/pending');
  });

  it('"Check again" on /pending sends an unverified client to /verify-email', async () => {
    update.mockResolvedValueOnce(sessionOf(sessionUser({ status: 'PENDING_APPROVAL' })));
    await expect(redirectOf(refreshSessionAction)).resolves.toBe('/verify-email');
    update.mockResolvedValueOnce(
      sessionOf(sessionUser({ status: 'PENDING_APPROVAL', emailVerified: true })),
    );
    await expect(redirectOf(refreshSessionAction)).resolves.toBe('/pending?checked=1');
  });

  it('goes to /login when the session ended', async () => {
    update.mockResolvedValueOnce(null);
    await expect(redirectOf(recheckEmailVerificationAction)).resolves.toBe('/login');
  });
});

describe('registerAction', () => {
  it('signs the new client in and lands on /verify-email', async () => {
    apiFetch.mockResolvedValueOnce({ user: { ...apiUser, emailVerified: false } });
    signInMock.mockImplementationOnce((async () => {
      recordSignedInUser(sessionUser());
      return undefined;
    }) as never);
    const target = await redirectOf(() =>
      registerAction(
        initialAuthFormState,
        form({
          name: 'New Client',
          company: 'Hamad',
          email: apiUser.email,
          password: 'LongEnough2026',
        }),
      ),
    );
    expect(target).toBe('/verify-email');
    expect(apiFetch).toHaveBeenCalledWith(
      '/internal/auth/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('resetPasswordAction (F4)', () => {
  const reset = () =>
    resetPasswordAction(
      initialAuthFormState,
      form({ token: TOKEN, password: 'NewPassword2026', confirmPassword: 'NewPassword2026' }),
    );

  it('signed out: goes to /login?reset=1', async () => {
    apiFetch.mockResolvedValueOnce(undefined);
    await expect(redirectOf(reset)).resolves.toBe('/login?reset=1');
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('signed in: signs this browser out, then /login?reset=1', async () => {
    apiFetch.mockResolvedValueOnce(undefined);
    currentUser.mockResolvedValue(sessionUser({ emailVerified: true }));
    signOutMock.mockImplementationOnce((async (options?: { redirectTo?: string }) => {
      throw new RedirectSignal(options?.redirectTo ?? '/');
    }) as never);
    await expect(redirectOf(reset)).resolves.toBe('/login?reset=1');
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: '/login?reset=1' });
  });

  it('does not sign out when the token is refused', async () => {
    currentUser.mockResolvedValue(sessionUser({ emailVerified: true }));
    apiFetch.mockRejectedValueOnce(new ApiRequestError(400, 'RESET_TOKEN_INVALID', 'expired'));
    await expect(reset()).resolves.toEqual({ status: 'error', error: 'RESET_TOKEN_INVALID' });
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
