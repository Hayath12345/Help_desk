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
import { STAFF_PROVIDER_IDS } from './provider-ids';

export interface RoutingUser {
  role: Role;
  status: UserStatus;
  /** Whether the user proved they own their mailbox (only gates CLIENT accounts). */
  emailVerified: boolean;
}

/**
 * Where the emailed verification link points (`?token=…`). Public, signed in or out, but the
 * address is only confirmed inside that account's own session: anyone else is asked to sign in.
 */
export const VERIFY_EMAIL_CONFIRM_PATH = WEB_ROUTES.verifyEmailConfirm;

/** `/verify-email/confirm?token=…` */
export function emailConfirmPath(token: string): string {
  return `${VERIFY_EMAIL_CONFIRM_PATH}?${new URLSearchParams({ token }).toString()}`;
}

/**
 * Pages for signed-out visitors (a signed-in visitor is sent home — except on /reset-password,
 * which is also an emailed-link page, see below).
 */
export const AUTH_PAGES = [
  WEB_ROUTES.clientLogin,
  WEB_ROUTES.signup,
  WEB_ROUTES.forgotPassword,
  WEB_ROUTES.resetPassword,
  WEB_ROUTES.staffLogin,
] as const;

/**
 * Pages opened from links in emails. They work for everyone, signed in or not, and handle any
 * session themselves: a password reset signs the browser out afterwards; confirming an email
 * address refreshes the session of that same user.
 */
const EMAIL_LINK_PAGES = [WEB_ROUTES.resetPassword, VERIFY_EMAIL_CONFIRM_PATH] as const;

/** Client portal areas (CLIENT only). */
const PORTAL_PREFIXES = [WEB_ROUTES.clientHome, WEB_ROUTES.help] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function pathOf(url: string): string {
  return url.split(/[?#]/)[0] ?? '/';
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((page) => matchesPrefix(pathname, page));
}

function isEmailLinkPage(pathname: string): boolean {
  return EMAIL_LINK_PAGES.some((page) => matchesPrefix(pathname, page));
}

function isVerifyEmailArea(pathname: string): boolean {
  return matchesPrefix(pathname, WEB_ROUTES.verifyEmail);
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

/** The routing fields of a session user, or null when the session is incomplete. */
export function toRoutingUser(
  user:
    | { id?: string | null; role?: Role; status?: UserStatus; emailVerified?: boolean }
    | null
    | undefined,
): RoutingUser | null {
  if (!user?.id || !user.role || !user.status) return null;
  return { role: user.role, status: user.status, emailVerified: user.emailVerified === true };
}

/**
 * A client who has not confirmed their email address yet. They can sign in, but may only use the
 * /verify-email screens (spec §5 tenant isolation: the API refuses them everything but /me).
 * Staff are gated by SSO instead.
 */
export function needsEmailVerification(user: RoutingUser): boolean {
  return user.role === 'CLIENT' && !user.emailVerified;
}

/** Status ACTIVE and, for clients, a verified email address (mirrors `isActive` in @loons/shared). */
function isUsable(user: RoutingUser): boolean {
  return user.status === 'ACTIVE' && !needsEmailVerification(user);
}

/**
 * Where a signed-in user belongs: /verify-email until a client confirmed their address, then the
 * approval page while pending, otherwise their role home.
 */
export function landingPathFor(user: RoutingUser): string {
  if (needsEmailVerification(user)) return WEB_ROUTES.verifyEmail;
  return user.status === 'PENDING_APPROVAL' ? WEB_ROUTES.pendingApproval : homePathFor(user.role);
}

/** `/login?callbackUrl=…` (or `/staff/login?…` for the console and admin areas). */
export function loginRedirectFor(pathname: string, search = ''): string {
  const loginPath = isStaffArea(pathname) ? WEB_ROUTES.staffLogin : WEB_ROUTES.clientLogin;
  const target = safeCallbackUrl(`${pathname}${search}`);
  if (!target || target === '/') return loginPath;
  return `${loginPath}?${new URLSearchParams({ callbackUrl: target }).toString()}`;
}

/** `/login?callbackUrl=…` that comes back to the emailed confirmation link after signing in. */
export function signInToConfirmPath(token: string): string {
  const query = new URLSearchParams({ callbackUrl: emailConfirmPath(token) });
  return `${WEB_ROUTES.clientLogin}?${query.toString()}`;
}

/** Whether `user` may open `pathname` (coarse, role-level check). */
export function canAccess(pathname: string, user: RoutingUser): boolean {
  if (!isUsable(user)) return false;
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
  // Links from emails (reset password, confirm email) work whoever is signed in.
  if (isEmailLinkPage(pathname)) return null;

  // A disabled account is treated as signed out.
  const viewer = user && user.status !== 'DISABLED' ? user : null;

  if (!viewer) {
    if (isAuthPage(pathname)) return null;
    if (
      pathname === '/' ||
      matchesPrefix(pathname, WEB_ROUTES.pendingApproval) ||
      isVerifyEmailArea(pathname)
    ) {
      return WEB_ROUTES.clientLogin;
    }
    return loginRedirectFor(pathname, search);
  }

  // An unverified client confirms their address first — before anything else, approval included.
  if (needsEmailVerification(viewer)) {
    return isVerifyEmailArea(pathname) ? null : WEB_ROUTES.verifyEmail;
  }
  if (isVerifyEmailArea(pathname)) return landingPathFor(viewer);

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
 * back at an auth page (then `/`, which the proxy resolves to the user's home). The emailed
 * confirmation link is kept: its page asks the account to sign in before it confirms anything.
 */
export function postSignInRedirect(callbackUrl: unknown): string {
  const target = safeCallbackUrl(callbackUrl);
  if (!target) return '/';
  const path = pathOf(target);
  if (path === VERIFY_EMAIL_CONFIRM_PATH) return target;
  if (
    isAuthPage(path) ||
    matchesPrefix(path, WEB_ROUTES.pendingApproval) ||
    isVerifyEmailArea(path)
  ) {
    return '/';
  }
  return target;
}

/**
 * The final destination for a user who just signed in: the (sanitised) callbackUrl when this
 * user may open it, otherwise their landing page (home, /verify-email or /pending). A sign-in
 * started from the emailed confirmation link goes back to it, confirmed or not (that is what the
 * unverified client signed in for).
 */
export function destinationAfterSignIn(user: RoutingUser, callbackUrl: unknown): string {
  const landing = landingPathFor(user);
  const target = postSignInRedirect(callbackUrl);
  const path = pathOf(target);
  if (path === VERIFY_EMAIL_CONFIRM_PATH) return target;
  if (!isUsable(user) || target === '/') return landing;
  return canAccess(path, user) ? target : landing;
}

/**
 * Auth.js sends every error of its own (the provider refused, the user cancelled consent, a
 * misconfiguration…) to `pages.error`, the client /login. For the staff (Microsoft Entra ID) flow
 * that is the wrong page: returns the same redirect pointed at /staff/login (query kept), or null
 * when the response needs no change.
 *
 * @param requestPath the Auth.js endpoint that answered, e.g. /api/auth/callback/microsoft-entra-id
 * @param location    the Location header Auth.js responded with
 */
export function staffAuthErrorLocation(
  requestPath: string,
  location: string | null,
): string | null {
  if (!location) return null;
  const match = /^\/api\/auth\/(?:callback|signin)\/([^/]+)\/?$/.exec(requestPath);
  if (!match?.[1] || !STAFF_PROVIDER_IDS.includes(match[1])) return null;
  let url: URL;
  try {
    url = new URL(location, 'http://loons.invalid');
  } catch {
    return null;
  }
  if (url.pathname !== WEB_ROUTES.clientLogin || !url.searchParams.has('error')) return null;
  url.pathname = WEB_ROUTES.staffLogin;
  return url.origin === 'http://loons.invalid' ? `${url.pathname}${url.search}` : url.toString();
}
