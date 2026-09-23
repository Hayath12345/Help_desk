// Shared Auth.js configuration: providers that need no network code of ours, pages, session
// strategy and the session callback. The Credentials provider and the callbacks that call the
// API (signIn / jwt) live in auth.ts.
import type { NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { WEB_ROUTES } from '@loons/shared';
import { isEntraConfigured, isGoogleConfigured } from '@/lib/auth/env';
import { sessionUserFromToken } from '@/lib/auth/session-user';

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;
const ONE_HOUR_SECONDS = 60 * 60;

/** Provider ids as Auth.js knows them. */
export const PROVIDER_IDS = {
  credentials: 'credentials',
  google: 'google',
  microsoftEntraId: 'microsoft-entra-id',
} as const;

// Env is read when this module loads (Auth.js reads provider env at NextAuth() time too), and
// the auth pages are dynamic, so what they render always matches the configured providers.
export const oauthProviders: Provider[] = [];

if (isGoogleConfigured()) {
  oauthProviders.push(
    Google({
      // Show Google's account chooser every time (matches the design's chooser step).
      authorization: { params: { prompt: 'select_account' } },
    }),
  );
}

if (isEntraConfigured()) {
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.trim();
  oauthProviders.push(
    MicrosoftEntraID({
      // Tenant-restricted issuer (https://login.microsoftonline.com/<tenant-id>/v2.0/).
      ...(issuer ? { issuer } : {}),
      // Drop the Graph profile photo (it would bloat the JWT cookie). Entra may omit `email`
      // for users in the home tenant, so fall back to the UPN.
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email || profile.preferred_username || null,
          image: null,
        };
      },
    }),
  );
}

export default {
  providers: oauthProviders,
  session: { strategy: 'jwt', maxAge: TWELVE_HOURS_SECONDS, updateAge: ONE_HOUR_SECONDS },
  pages: { signIn: WEB_ROUTES.clientLogin, error: WEB_ROUTES.clientLogin },
  callbacks: {
    session({ session, token }) {
      const user = sessionUserFromToken(token);
      if (user) {
        session.user = { ...session.user, ...user, image: null };
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
