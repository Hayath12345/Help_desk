// Coarse, pure routing rules used by proxy.ts (and unit-tested). Layouts ALSO enforce access
// server-side with requireUser() — this is the first line, not the only one.
import {
  ADMIN_SECTIONS,
  TEAM_LEAD_ADMIN_SECTIONS,
  WEB_ROUTES,
  homePathFor,
  isStaffRole,
  type AdminSection,
  type Role,
  type UserStatus,
} from '@loons/shared';
import { safeCallbackUrl } from './callback-url';

export interface RoutingUser {
  role: Role;
  status: UserStatus;
}

/** Pages for signed-out visitors (a signed-in visitor is sent home). */
export const AUTH_PAGES = [
  WEB_ROUTES.clientLogin,
  WEB_ROUTES.signup,
  WEB_ROUTES.forgotPassword,
  WEB_ROUTES.resetPassword,
  WEB_ROUTES.staffLogin,
] as const;

/** Client portal areas (CLIENT only). */
const PORTAL_PREFIXES = [WEB_ROUTES.clientHome, WEB_ROUTES.help] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => matchesPrefix(pathname, page));
}

export function isStaffArea(pathname: string): boolean {
  return matchesPrefix(pathname, WEB_ROUTES.console) || matchesPrefix(pathname, WEB_ROUTES.admin);
}

export function isPortalArea(pathname: string): boolean {
  return PORTAL_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

function isApiRoute(pathname: string): boolean {
  return matchesPrefix(pathname, '/api');
}

function adminSectionOf(pathname: string): AdminSection | null {
  if (!matchesPrefix(pathname, WEB_ROUTES.admin)) return null;
  const segment = pathname.slice(WEB_ROUTES.admin.length + 1).split('/')[0] ?? '';
  return (ADMIN_SECTIONS as readonly string[]).includes(segment) ? (segment as AdminSection) : null;
}

/** Where a signed-in user belongs: their role home, or the approval page while pending. */
export function landingPathFor(user: RoutingUser): string {
  return user.status === 'PENDING_APPROVAL' ? WEB_ROUTES.pendingApproval : homePathFor(user.role);
}

/** `/login?callbackUrl=…` (or `/staff/login?…` for the console and admin areas). */
export function loginRedirectFor(pathname: string, search = ''): string {
  const loginPath = isStaffArea(pathname) ? WEB_ROUTES.staffLogin : WEB_ROUTES.clientLogin;
  const target = safeCallbackUrl(`${pathname}${search}`);
  if (!target || target === '/') return loginPath;
  return `${loginPath}?${new URLSearchParams({ callbackUrl: target }).toString()}`;
}

/** Whether `user` may open `pathname` (coarse, role-level check). */
export function canAccess(pathname: string, user: RoutingUser): boolean {
  if (user.status !== 'ACTIVE') return false;
  if (isPortalArea(pathname)) return user.role === 'CLIENT';
  if (matchesPrefix(pathname, WEB_ROUTES.console)) return isStaffRole(user.role);
  if (matchesPrefix(pathname, WEB_ROUTES.admin)) {
    if (user.role === 'SUPER_ADMIN') return true;
    if (user.role !== 'TEAM_LEAD') return false;
    const section = adminSectionOf(pathname);
    // The admin index and unknown paths (404s) are fine; known sections follow the allow-list.
    return section === null || TEAM_LEAD_ADMIN_SECTIONS.includes(section);
  }
  return true;
}

/**
 * Decides whether a page request must be redirected.
 * @returns the relative URL to redirect to, or `null` to let the request through.
 */
export function resolveRedirect(
  url: { pathname: string; search?: string },
  user: RoutingUser | null,
): string | null {
  const { pathname } = url;
  const search = url.search ?? '';

  // Route handlers answer for themselves (e.g. /api/token → 401 JSON).
  if (isApiRoute(pathname)) return null;

  // A disabled account is treated as signed out.
  const viewer = user && user.status !== 'DISABLED' ? user : null;

  if (!viewer) {
    if (isAuthPage(pathname)) return null;
    if (pathname === '/') return WEB_ROUTES.clientLogin;
    if (matchesPrefix(pathname, WEB_ROUTES.pendingApproval)) return WEB_ROUTES.clientLogin;
    return loginRedirectFor(pathname, search);
  }

  if (viewer.status === 'PENDING_APPROVAL') {
    return matchesPrefix(pathname, WEB_ROUTES.pendingApproval) ? null : WEB_ROUTES.pendingApproval;
  }

  const home = homePathFor(viewer.role);
  if (
    pathname === '/' ||
    isAuthPage(pathname) ||
    matchesPrefix(pathname, WEB_ROUTES.pendingApproval)
  ) {
    return home;
  }

  if (
    matchesPrefix(pathname, WEB_ROUTES.admin) &&
    viewer.role === 'TEAM_LEAD' &&
    !canAccess(pathname, viewer)
  ) {
    return WEB_ROUTES.admin;
  }
  return canAccess(pathname, viewer) ? null : home;
}

/**
 * Where to go right after a successful sign-in: the sanitised callbackUrl, unless it points
 * back at an auth page (then `/`, which the proxy resolves to the user's home).
 */
export function postSignInRedirect(callbackUrl: unknown): string {
  const target = safeCallbackUrl(callbackUrl);
  if (!target) return '/';
  const path = target.split(/[?#]/)[0] ?? '/';
  if (isAuthPage(path) || matchesPrefix(path, WEB_ROUTES.pendingApproval)) return '/';
  return target;
}

/**
 * The final destination for a user who just signed in: the (sanitised) callbackUrl when this
 * user may open it, otherwise their home — or `/pending` while awaiting approval.
 */
export function destinationAfterSignIn(user: RoutingUser, callbackUrl: unknown): string {
  const landing = landingPathFor(user);
  if (user.status !== 'ACTIVE') return landing;
  const target = postSignInRedirect(callbackUrl);
  if (target === '/') return landing;
  const path = target.split(/[?#]/)[0] ?? '/';
  return canAccess(path, user) ? target : landing;
}
