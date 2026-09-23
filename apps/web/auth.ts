// Full Auth.js configuration: Credentials (validated server-to-server by the API) plus the
// callbacks that resolve OAuth users and keep the session in sync with the API.
import { WEB_ROUTES, loginSchema, type ErrorCode, type OAuthProvider } from '@loons/shared';
import NextAuth, {
  CredentialsSignin,
  type NextAuthConfig,
  type Profile,
  type User,
} from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import authConfig, { PROVIDER_IDS } from '@/auth.config';
import { ApiRequestError } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import { isDevStaffLoginEnabled, trustedProxyHops } from '@/lib/auth/env';
import { loginErrorCode, oauthErrorKey, type AuthErrorKey } from '@/lib/auth/errors';
import { readLocaleCookie, syncLocaleOnSignIn } from '@/lib/auth/locale-sync';
import { recordSignedInUser } from '@/lib/auth/sign-in-capture';
import {
  applyUserToToken,
  parseUserResponse,
  refreshSessionToken,
  sessionUserFromAuthJsUser,
  toSessionUser,
  type UserLookup,
} from '@/lib/auth/session-user';

/**
 * A rejected password sign-in. `code` (our API error code) is what the login form shows; it
 * is deliberately coarse — unknown email and wrong password are both INVALID_CREDENTIALS.
 */
class SignInRejected extends CredentialsSignin {
  constructor(code: ErrorCode) {
    super();
    this.code = code;
  }
}

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  [PROVIDER_IDS.google]: 'GOOGLE',
  [PROVIDER_IDS.microsoftEntraId]: 'MICROSOFT_ENTRA_ID',
};

const MAX_NAME_LENGTH = 200;

function oauthFailure(provider: OAuthProvider | undefined, key: AuthErrorKey): string {
  const page = provider === 'MICROSOFT_ENTRA_ID' ? WEB_ROUTES.staffLogin : WEB_ROUTES.clientLogin;
  return `${page}?${new URLSearchParams({ error: key }).toString()}`;
}

function oauthEmail(user: User, profile: Profile | undefined): string | null {
  const candidates = [user.email, profile?.email, profile?.preferred_username];
  for (const value of candidates) {
    if (typeof value === 'string' && value.includes('@')) return value.trim();
  }
  return null;
}

function oauthEmailVerified(provider: OAuthProvider, profile: Profile | undefined): boolean {
  // Google states verification explicitly. Entra ID accounts come from the tenant-restricted
  // issuer, so their address is managed by Loons IT.
  if (provider === 'GOOGLE') return profile?.email_verified === true;
  return true;
}

async function lookupUser(userId: string): Promise<UserLookup> {
  try {
    const body = await internalApiFetch<unknown>(
      `/internal/auth/users/${encodeURIComponent(userId)}`,
      { clientIp: null },
    );
    const user = parseUserResponse(body);
    return user ? { kind: 'found', user } : { kind: 'unavailable' };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { kind: 'gone' };
    return { kind: 'unavailable' };
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const cause = (error as { cause?: { err?: unknown } }).cause?.err;
  const inner = cause instanceof Error ? ` (${cause.name}: ${cause.message})` : '';
  return `${error.name}: ${error.message}${inner}`;
}

const config = {
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      id: PROVIDER_IDS.credentials,
      credentials: {
        email: { type: 'email', label: 'Email' },
        password: { type: 'password', label: 'Password' },
        audience: { type: 'text', label: 'Audience' },
      },
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse({
          email: credentials.email,
          password: credentials.password,
          audience: credentials.audience,
        });
        if (!parsed.success) throw new SignInRejected('INVALID_CREDENTIALS');
        if (parsed.data.audience === 'staff' && !isDevStaffLoginEnabled()) {
          throw new SignInRejected('STAFF_MUST_USE_SSO');
        }

        let body: unknown;
        try {
          body = await internalApiFetch<unknown>('/internal/auth/login', {
            method: 'POST',
            json: parsed.data,
            clientIp: clientIpFromHeaders(request.headers, trustedProxyHops()),
          });
        } catch (error) {
          if (error instanceof ApiRequestError) {
            if (error.status === 0 || error.status >= 500) {
              console.error(`[auth] Sign-in could not reach the API: ${describeError(error)}`);
            }
            throw new SignInRejected(loginErrorCode(error.code));
          }
          throw error;
        }

        const user = parseUserResponse(body);
        if (!user) throw new SignInRejected('INTERNAL');
        return toSessionUser(user);
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,

    /** OAuth users are resolved (found / linked / created / rejected) by the API. */
    async signIn({ user, account, profile }) {
      if (!account || account.type === 'credentials') return true;

      const provider = OAUTH_PROVIDERS[account.provider];
      if (!provider) return oauthFailure(provider, 'SIGNIN_FAILED');
      const email = oauthEmail(user, profile);
      if (!email) return oauthFailure(provider, 'SIGNIN_FAILED');

      try {
        const body = await internalApiFetch<unknown>('/internal/auth/oauth', {
          method: 'POST',
          json: {
            provider,
            providerAccountId: account.providerAccountId,
            email,
            emailVerified: oauthEmailVerified(provider, profile),
            name: (user.name ?? '').trim().slice(0, MAX_NAME_LENGTH),
            locale: (await readLocaleCookie()) ?? 'en',
          },
        });
        const resolved = parseUserResponse(body);
        if (!resolved) return oauthFailure(provider, 'INTERNAL');
        // Without an adapter this object is what the jwt callback receives as `user`.
        Object.assign(user, toSessionUser(resolved), { image: null });
        return true;
      } catch (error) {
        if (error instanceof ApiRequestError)
          return oauthFailure(provider, oauthErrorKey(error.code));
        console.error('[auth] OAuth sign-in could not be resolved:', describeError(error));
        return oauthFailure(provider, 'INTERNAL');
      }
    },

    async jwt({ token, user, trigger }) {
      // Sign-in: `user` comes from authorize() or the OAuth signIn callback above.
      if (user) {
        const signedIn = sessionUserFromAuthJsUser(user);
        if (!signedIn) return null;
        const sessionUser = { ...signedIn, locale: await syncLocaleOnSignIn(signedIn) };
        recordSignedInUser(sessionUser);
        return applyUserToToken(token, sessionUser);
      }
      // Later requests: reload from the API every 5 minutes (or on an explicit session update).
      return refreshSessionToken(token, { force: trigger === 'update', lookup: lookupUser });
    },
  },
  logger: {
    error(error) {
      // Rejected passwords are routine; they are rate-limited and audited by the API.
      if (error instanceof CredentialsSignin) return;
      console.error(`[auth] ${describeError(error)}`);
    },
    warn(code) {
      console.warn(`[auth] warning: ${code}`);
    },
    debug() {},
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth(config);
