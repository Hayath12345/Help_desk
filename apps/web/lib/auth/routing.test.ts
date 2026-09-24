import { describe, expect, it } from 'vitest';
import {
  canAccess,
  destinationAfterSignIn,
  emailConfirmPath,
  landingPathFor,
  loginRedirectFor,
  postSignInRedirect,
  resolveRedirect,
  signInToConfirmPath,
  staffAuthErrorLocation,
  toRoutingUser,
  type RoutingUser,
} from './routing';

const client: RoutingUser = { role: 'CLIENT', status: 'ACTIVE', emailVerified: true };
const agent: RoutingUser = { role: 'AGENT', status: 'ACTIVE', emailVerified: true };
const lead: RoutingUser = { role: 'TEAM_LEAD', status: 'ACTIVE', emailVerified: true };
const admin: RoutingUser = { role: 'SUPER_ADMIN', status: 'ACTIVE', emailVerified: true };
const pending: RoutingUser = { role: 'CLIENT', status: 'PENDING_APPROVAL', emailVerified: true };
const disabled: RoutingUser = { role: 'AGENT', status: 'DISABLED', emailVerified: true };
const unverified: RoutingUser = { role: 'CLIENT', status: 'ACTIVE', emailVerified: false };
const unverifiedPending: RoutingUser = {
  role: 'CLIENT',
  status: 'PENDING_APPROVAL',
  emailVerified: false,
};
/** SSO-gated staff are never sent to /verify-email, whatever the flag says. */
const unverifiedAgent: RoutingUser = { role: 'AGENT', status: 'ACTIVE', emailVerified: false };

const go = (path: string, user: RoutingUser | null) => {
  const url = new URL(path, 'http://localhost:3000');
  return resolveRedirect({ pathname: url.pathname, search: url.search }, user);
};

describe('resolveRedirect — signed out', () => {
  it('lets auth pages through', () => {
    for (const path of [
      '/login',
      '/signup',
      '/forgot-password',
      '/reset-password?token=abc',
      '/staff/login',
    ]) {
      expect(go(path, null)).toBeNull();
    }
  });

  it('sends "/" to the client login without a callbackUrl', () => {
    expect(go('/', null)).toBe('/login');
  });

  it('sends portal pages to /login with a callbackUrl (path + query)', () => {
    expect(go('/tickets', null)).toBe('/login?callbackUrl=%2Ftickets');
    expect(go('/tickets/42?tab=active', null)).toBe(
      '/login?callbackUrl=%2Ftickets%2F42%3Ftab%3Dactive',
    );
    expect(go('/help', null)).toBe('/login?callbackUrl=%2Fhelp');
  });

  it('sends console and admin pages to /staff/login', () => {
    expect(go('/console/inbox', null)).toBe('/staff/login?callbackUrl=%2Fconsole%2Finbox');
    expect(go('/console', null)).toBe('/staff/login?callbackUrl=%2Fconsole');
    expect(go('/admin/teams', null)).toBe('/staff/login?callbackUrl=%2Fadmin%2Fteams');
  });

  it('does not treat look-alike prefixes as staff areas', () => {
    expect(go('/consoles', null)).toBe('/login?callbackUrl=%2Fconsoles');
    expect(go('/administrator', null)).toBe('/login?callbackUrl=%2Fadministrator');
  });

  it('sends /pending and /verify-email to the login page', () => {
    expect(go('/pending', null)).toBe('/login');
    expect(go('/verify-email', null)).toBe('/login');
    expect(go('/verify-email?checked=1', null)).toBe('/login');
  });

  it('lets the emailed confirmation link through (public page)', () => {
    expect(go('/verify-email/confirm?token=abc', null)).toBeNull();
  });

  it('never redirects API routes (they answer 401 themselves)', () => {
    expect(go('/api/token', null)).toBeNull();
    expect(go('/api/auth/session', null)).toBeNull();
  });

  it('treats a disabled account as signed out', () => {
    expect(go('/console/inbox', disabled)).toBe('/staff/login?callbackUrl=%2Fconsole%2Finbox');
    expect(go('/login', disabled)).toBeNull();
  });
});

describe('resolveRedirect — clients', () => {
  it('allows the portal', () => {
    expect(go('/tickets', client)).toBeNull();
    expect(go('/tickets/17', client)).toBeNull();
    expect(go('/help', client)).toBeNull();
  });

  it('sends clients away from the console and admin areas', () => {
    expect(go('/console/inbox', client)).toBe('/tickets');
    expect(go('/console', client)).toBe('/tickets');
    expect(go('/admin', client)).toBe('/tickets');
    expect(go('/admin/categories', client)).toBe('/tickets');
  });

  it('sends signed-in clients from auth pages and "/" home', () => {
    expect(go('/', client)).toBe('/tickets');
    expect(go('/login', client)).toBe('/tickets');
    expect(go('/login?callbackUrl=%2Fconsole', client)).toBe('/tickets');
    expect(go('/signup', client)).toBe('/tickets');
    expect(go('/staff/login', client)).toBe('/tickets');
    expect(go('/pending', client)).toBe('/tickets');
  });

  it('sends verified clients away from /verify-email but lets email links through', () => {
    expect(go('/verify-email', client)).toBe('/tickets');
    expect(go('/verify-email/confirm?token=abc', client)).toBeNull();
    // F4: a reset link works for a signed-in user too (the reset then signs the browser out).
    expect(go('/reset-password?token=abc', client)).toBeNull();
  });
});

describe('resolveRedirect — unverified clients (SEC-1)', () => {
  it('sends every app page to /verify-email', () => {
    for (const path of [
      '/',
      '/tickets',
      '/tickets/42',
      '/help',
      '/pending',
      '/console/inbox',
      '/admin',
      '/login',
      '/signup',
      '/forgot-password',
      '/staff/login',
      '/something-else',
    ]) {
      expect(go(path, unverified), path).toBe('/verify-email');
    }
  });

  it('allows the verification screens, email links and API routes', () => {
    expect(go('/verify-email', unverified)).toBeNull();
    expect(go('/verify-email?checked=1', unverified)).toBeNull();
    expect(go('/verify-email/confirm?token=abc', unverified)).toBeNull();
    expect(go('/reset-password?token=abc', unverified)).toBeNull();
    expect(go('/api/token', unverified)).toBeNull();
    expect(go('/api/auth/signout', unverified)).toBeNull();
  });

  it('checks verification before approval', () => {
    expect(go('/pending', unverifiedPending)).toBe('/verify-email');
    expect(go('/tickets', unverifiedPending)).toBe('/verify-email');
    expect(go('/verify-email', unverifiedPending)).toBeNull();
    expect(go('/verify-email', pending)).toBe('/pending');
  });

  it('never gates staff on the flag (they sign in with SSO)', () => {
    expect(go('/console/inbox', unverifiedAgent)).toBeNull();
    expect(go('/verify-email', unverifiedAgent)).toBe('/console/inbox');
  });
});

describe('resolveRedirect — staff', () => {
  it('lets agents use the console but not the admin panel or portal', () => {
    expect(go('/console/inbox', agent)).toBeNull();
    expect(go('/console/queue', agent)).toBeNull();
    expect(go('/admin', agent)).toBe('/console/inbox');
    expect(go('/admin/sla', agent)).toBe('/console/inbox');
    expect(go('/tickets', agent)).toBe('/console/inbox');
    expect(go('/help', agent)).toBe('/console/inbox');
  });

  it('lets team leads into /admin, limited to their sections', () => {
    expect(go('/console/inbox', lead)).toBeNull();
    expect(go('/admin', lead)).toBeNull();
    expect(go('/admin/teams', lead)).toBeNull();
    expect(go('/admin/macros', lead)).toBeNull();
    expect(go('/admin/categories', lead)).toBe('/admin');
    expect(go('/admin/audit-log', lead)).toBe('/admin');
    expect(go('/tickets', lead)).toBe('/console/inbox');
  });

  it('lets super admins into every staff area', () => {
    for (const path of [
      '/console/inbox',
      '/console/reports',
      '/admin',
      '/admin/categories',
      '/admin/audit-log',
    ]) {
      expect(go(path, admin)).toBeNull();
    }
    expect(go('/', admin)).toBe('/admin');
    expect(go('/staff/login', admin)).toBe('/admin');
    expect(go('/tickets', admin)).toBe('/admin');
  });
});

describe('resolveRedirect — pending approval', () => {
  it('keeps pending users on /pending', () => {
    expect(go('/pending', pending)).toBeNull();
    expect(go('/', pending)).toBe('/pending');
    expect(go('/tickets', pending)).toBe('/pending');
    expect(go('/console/inbox', pending)).toBe('/pending');
    expect(go('/login', pending)).toBe('/pending');
    expect(go('/signup', pending)).toBe('/pending');
  });

  it('still lets pending users reach API routes (GET /api/token for /me)', () => {
    expect(go('/api/token', pending)).toBeNull();
  });
});

describe('landingPathFor / canAccess', () => {
  it('maps roles to homes and pending users to /pending', () => {
    expect(landingPathFor(client)).toBe('/tickets');
    expect(landingPathFor(agent)).toBe('/console/inbox');
    expect(landingPathFor(lead)).toBe('/console/inbox');
    expect(landingPathFor(admin)).toBe('/admin');
    expect(landingPathFor(pending)).toBe('/pending');
    expect(landingPathFor(unverified)).toBe('/verify-email');
    expect(landingPathFor(unverifiedPending)).toBe('/verify-email');
    expect(landingPathFor(unverifiedAgent)).toBe('/console/inbox');
  });

  it('denies everything protected to inactive users', () => {
    expect(canAccess('/tickets', pending)).toBe(false);
    expect(canAccess('/console', disabled)).toBe(false);
    expect(canAccess('/tickets', unverified)).toBe(false);
    expect(canAccess('/help', unverified)).toBe(false);
  });

  it('reads the routing fields of a session user', () => {
    expect(
      toRoutingUser({ id: 'u1', role: 'CLIENT', status: 'ACTIVE', emailVerified: false }),
    ).toEqual(unverified);
    expect(toRoutingUser({ id: 'u1', role: 'CLIENT', status: 'ACTIVE' })).toEqual(unverified);
    expect(
      toRoutingUser({ id: 'u1', role: 'AGENT', status: 'ACTIVE', emailVerified: true }),
    ).toEqual(agent);
    expect(toRoutingUser({ role: 'CLIENT', status: 'ACTIVE' })).toBeNull();
    expect(toRoutingUser(null)).toBeNull();
  });
});

describe('loginRedirectFor', () => {
  it('never produces an open redirect from a crafted path', () => {
    expect(loginRedirectFor('//evil.com')).toBe('/login');
    expect(loginRedirectFor('/\\evil.com')).toBe('/login');
  });
});

describe('destinationAfterSignIn', () => {
  it('goes home when there is no (usable) callbackUrl', () => {
    expect(destinationAfterSignIn(client, undefined)).toBe('/tickets');
    expect(destinationAfterSignIn(agent, '')).toBe('/console/inbox');
    expect(destinationAfterSignIn(admin, 'https://evil.com/admin')).toBe('/admin');
    expect(destinationAfterSignIn(lead, '/login')).toBe('/console/inbox');
  });

  it('honours a callbackUrl the user may open', () => {
    expect(destinationAfterSignIn(client, '/tickets/42?tab=active')).toBe('/tickets/42?tab=active');
    expect(destinationAfterSignIn(agent, '/console/queue')).toBe('/console/queue');
    expect(destinationAfterSignIn(lead, '/admin/macros')).toBe('/admin/macros');
  });

  it('ignores a callbackUrl the role may not open', () => {
    expect(destinationAfterSignIn(client, '/console/inbox')).toBe('/tickets');
    expect(destinationAfterSignIn(agent, '/admin')).toBe('/console/inbox');
    expect(destinationAfterSignIn(lead, '/admin/categories')).toBe('/console/inbox');
    expect(destinationAfterSignIn(admin, '/tickets')).toBe('/admin');
  });

  it('always sends pending users to /pending', () => {
    expect(destinationAfterSignIn(pending, '/tickets')).toBe('/pending');
  });

  it('sends unverified clients (e.g. right after sign-up) to /verify-email', () => {
    expect(destinationAfterSignIn(unverified, null)).toBe('/verify-email');
    expect(destinationAfterSignIn(unverified, '/tickets/42')).toBe('/verify-email');
    expect(destinationAfterSignIn(unverifiedPending, undefined)).toBe('/verify-email');
  });

  it('goes back to the emailed confirmation link a sign-in started from, confirmed or not (RR-SEC-1)', () => {
    const link = '/verify-email/confirm?token=abc';
    expect(destinationAfterSignIn(unverified, link)).toBe(link);
    expect(destinationAfterSignIn(unverifiedPending, link)).toBe(link);
    // Anyone else too: the page itself decides (it asks for the right account).
    expect(destinationAfterSignIn(client, link)).toBe(link);
    expect(destinationAfterSignIn(agent, link)).toBe(link);
    // Only that exact page, not the rest of the /verify-email area.
    expect(destinationAfterSignIn(unverified, '/verify-email/confirmed')).toBe('/verify-email');
  });
});

describe('confirmation link paths', () => {
  it('builds the link page and the sign-in that comes back to it', () => {
    const token = 'A-b_9'.repeat(9);
    expect(emailConfirmPath(token)).toBe(`/verify-email/confirm?token=${token}`);
    const signIn = signInToConfirmPath(token);
    expect(signIn).toBe(`/login?callbackUrl=${encodeURIComponent(emailConfirmPath(token))}`);
    const callbackUrl = new URL(signIn, 'http://localhost').searchParams.get('callbackUrl');
    expect(postSignInRedirect(callbackUrl)).toBe(emailConfirmPath(token));
  });
});

describe('postSignInRedirect', () => {
  it('keeps safe same-origin callback URLs', () => {
    expect(postSignInRedirect('/tickets/42?tab=active')).toBe('/tickets/42?tab=active');
    expect(postSignInRedirect('/console/inbox')).toBe('/console/inbox');
  });

  it('falls back to "/" for missing, unsafe or auth-page targets', () => {
    expect(postSignInRedirect(undefined)).toBe('/');
    expect(postSignInRedirect('')).toBe('/');
    expect(postSignInRedirect('https://evil.com')).toBe('/');
    expect(postSignInRedirect('//evil.com/tickets')).toBe('/');
    expect(postSignInRedirect('/login')).toBe('/');
    expect(postSignInRedirect('/staff/login?callbackUrl=/admin')).toBe('/');
    expect(postSignInRedirect('/pending')).toBe('/');
    expect(postSignInRedirect('/verify-email')).toBe('/');
    expect(postSignInRedirect('/verify-email?checked=1')).toBe('/');
    expect(postSignInRedirect('/api/auth/signout')).toBe('/');
  });

  it('keeps the emailed confirmation link (its page asks the right account to sign in)', () => {
    expect(postSignInRedirect('/verify-email/confirm?token=abc')).toBe(
      '/verify-email/confirm?token=abc',
    );
  });
});

describe('staffAuthErrorLocation (F5)', () => {
  const entraCallback = '/api/auth/callback/microsoft-entra-id';

  it('sends Auth.js errors of the Entra flow to /staff/login, keeping the error', () => {
    expect(
      staffAuthErrorLocation(entraCallback, 'http://localhost:3000/login?error=OAuthCallbackError'),
    ).toBe('http://localhost:3000/staff/login?error=OAuthCallbackError');
    expect(staffAuthErrorLocation(entraCallback, '/login?error=AccessDenied')).toBe(
      '/staff/login?error=AccessDenied',
    );
    expect(
      staffAuthErrorLocation(
        '/api/auth/signin/microsoft-entra-id',
        'https://support.example/login?error=Configuration',
      ),
    ).toBe('https://support.example/staff/login?error=Configuration');
  });

  it('leaves other providers, successes and non-error redirects alone', () => {
    expect(
      staffAuthErrorLocation('/api/auth/callback/google', 'http://localhost:3000/login?error=X'),
    ).toBeNull();
    expect(staffAuthErrorLocation(entraCallback, 'http://localhost:3000/console/inbox')).toBeNull();
    expect(staffAuthErrorLocation(entraCallback, 'http://localhost:3000/login')).toBeNull();
    // The signIn callback already chose the staff page for API rejections.
    expect(
      staffAuthErrorLocation(entraCallback, 'http://localhost:3000/staff/login?error=FORBIDDEN'),
    ).toBeNull();
    expect(staffAuthErrorLocation(entraCallback, null)).toBeNull();
    expect(staffAuthErrorLocation('/api/auth/session', '/login?error=X')).toBeNull();
  });
});
