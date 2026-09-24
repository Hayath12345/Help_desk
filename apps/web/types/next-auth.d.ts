// Auth.js type augmentation: the session and JWT carry the Loons user fields.
// The `next-auth/jwt` import is REQUIRED — without it the JWT augmentation silently does nothing.
import type { Locale, Role, UserStatus } from '@loons/shared';
import type { DefaultSession } from 'next-auth';
import 'next-auth/jwt';

declare module 'next-auth' {
  /**
   * Returned by Credentials `authorize()` and filled in by the OAuth `signIn` callback.
   * (Our boolean `emailVerified` is not declared here: Auth.js' AdapterUser already uses that name
   * for a Date. sessionUserFromAuthJsUser() reads it defensively.)
   */
  interface User {
    role?: Role;
    status?: UserStatus;
    orgId?: string | null;
    locale?: Locale;
    /** The user's session version at sign-in (see `sv` in the JWT). */
    sessionVersion?: number;
  }

  interface Session {
    user: {
      id: string;
      name: string;
      email: string;
      role: Role;
      status: UserStatus;
      orgId: string | null;
      locale: Locale;
      sessionVersion: number;
      /** Mailbox ownership proven (API `emailVerified`). Unverified clients see /verify-email only. */
      emailVerified: boolean;
    } & Omit<DefaultSession['user'], 'name' | 'email'>;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Loons user id (UUID). */
    uid?: string;
    role?: Role;
    status?: UserStatus;
    orgId?: string | null;
    locale?: Locale;
    /**
     * The user's sessionVersion when this session was established. API tokens are minted with it
     * (`sv` claim); the session ends at the next refresh once the API reports another version
     * (password reset, and later admin disable / role change).
     */
    sv?: number;
    /** API `emailVerified`; missing on sessions from before verification existed (refreshed at once). */
    emailVerified?: boolean;
    /**
     * Epoch ms of the last reload from the API (GET /internal/auth/users/:id). After a failed
     * reload it is set so that the next attempt happens USER_REFRESH_RETRY_MS later.
     */
    refreshedAt?: number;
  }
}
