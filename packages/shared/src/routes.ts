import type { Role } from './enums.ts';

/** Web app paths shared by the proxy, the auth flow and e2e tests. */
export const WEB_ROUTES = {
  clientLogin: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  staffLogin: '/staff/login',
  pendingApproval: '/pending',
  /** Unverified clients land here until they click the link in the verification email. */
  verifyEmail: '/verify-email',
  /** Target of the emailed verification link (`?token=…`); confirms only inside that account's session. */
  verifyEmailConfirm: '/verify-email/confirm',
  clientHome: '/tickets',
  help: '/help',
  console: '/console',
  consoleInbox: '/console/inbox',
  admin: '/admin',
} as const;

/** Where a signed-in user lands after authentication. */
export function homePathFor(role: Role): string {
  switch (role) {
    case 'CLIENT':
      return WEB_ROUTES.clientHome;
    case 'SUPER_ADMIN':
      return WEB_ROUTES.admin;
    case 'AGENT':
    case 'TEAM_LEAD':
      return WEB_ROUTES.consoleInbox;
  }
}
