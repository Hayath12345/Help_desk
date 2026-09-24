// Server-side access to the signed-in user (Server Components, Server Actions, Route Handlers).
import 'server-only';
import {
  STAFF_ROLES,
  WEB_ROUTES,
  homePathFor,
  type Locale,
  type Role,
  type UserStatus,
} from '@loons/shared';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/auth';
import { needsEmailVerification } from '@/lib/auth/routing';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  orgId: string | null;
  locale: Locale;
  /** Session version the session was established with; API tokens carry it as `sv`. */
  sessionVersion: number;
  /** Mailbox ownership proven. An unverified client may only use the /verify-email screens. */
  emailVerified: boolean;
}

// One session decode per request, however many layouts/pages ask for the user.
const loadCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.role || !user.status || user.status === 'DISABLED') return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    orgId: user.orgId ?? null,
    locale: user.locale,
    sessionVersion: user.sessionVersion,
    emailVerified: user.emailVerified === true,
  };
});

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return loadCurrentUser();
}

function isStaffOnly(roles: readonly Role[]): boolean {
  return roles.length > 0 && roles.every((role) => (STAFF_ROLES as readonly Role[]).includes(role));
}

/**
 * Returns the signed-in, active user or redirects:
 * - not signed in → `/login` (or `/staff/login` when every allowed role is a staff role)
 * - a client who has not verified their email address → `/verify-email` (checked first)
 * - awaiting approval → `/pending`
 * - role not in `roles` → the user's own home
 */
export async function requireUser(roles?: readonly Role[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(
      (roles && isStaffOnly(roles) ? WEB_ROUTES.staffLogin : WEB_ROUTES.clientLogin) as Route,
    );
  }
  if (needsEmailVerification(user)) redirect(WEB_ROUTES.verifyEmail as Route);
  if (user.status !== 'ACTIVE') redirect(WEB_ROUTES.pendingApproval as Route);
  if (roles && roles.length > 0 && !roles.includes(user.role)) {
    redirect(homePathFor(user.role) as Route);
  }
  return user;
}

export function initialsOf(name: string): string {
  return name
    .replace(/^(Dr\.|Capt\.|Eng\.)\s*/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
