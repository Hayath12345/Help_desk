// Shared Auth.js configuration: providers that need no network code of ours, pages, session
// strategy and the session callback. The Credentials provider and the callbacks that call the
// API (signIn / jwt) live in auth.ts.
import type { NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { WEB_ROUTES } from '@loons/shared';
import { entraConfig, isGoogleConfigured } from '@/lib/auth/env';
import { PROVIDER_IDS } from '@/lib/auth/provider-ids';
import { sessionUserFromToken } from '@/lib/auth/session-user';

export { PROVIDER_IDS };

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;
const ONE_HOUR_SECONDS = 60 * 60;

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

// Only with a tenant-specific issuer (validated in lib/auth/env.ts; `common`, `organizations` and
// `consumers` leave the provider disabled). The signIn callback also checks the token's `tid`.
const entra = entraConfig();
if (entra) {
  oauthProviders.push(
    MicrosoftEntraID({
      // Canonical form: must equal the `issuer` of the tenant's OpenID discovery document.
      issuer: entra.issuer,
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
  // Errors of the staff (Entra) flow are re-pointed at /staff/login by app/api/auth/[...nextauth].
  pages: { signIn: WEB_ROUTES.clientLogin, error: WEB_ROUTES.clientLogin },
  callbacks: {
    session({ session, token }) {
      const user = sessionUserFromToken(token);
      // Assigned in place: this parameter's type also includes Auth.js' AdapterUser, whose
      // `emailVerified` is a Date; ours (a boolean) is what Session['user'] declares.
      if (user) Object.assign(session.user, user, { image: null });
      return session;
    },
  },
} satisfies NextAuthConfig;
