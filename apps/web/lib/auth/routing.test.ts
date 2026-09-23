import { describe, expect, it } from 'vitest';
import {
  canAccess,
  destinationAfterSignIn,
  landingPathFor,
  loginRedirectFor,
  postSignInRedirect,
  resolveRedirect,
  type RoutingUser,
} from './routing';

const client: RoutingUser = { role: 'CLIENT', status: 'ACTIVE' };
const agent: RoutingUser = { role: 'AGENT', status: 'ACTIVE' };
const lead: RoutingUser = { role: 'TEAM_LEAD', status: 'ACTIVE' };
const admin: RoutingUser = { role: 'SUPER_ADMIN', status: 'ACTIVE' };
const pending: RoutingUser = { role: 'CLIENT', status: 'PENDING_APPROVAL' };
const disabled: RoutingUser = { role: 'AGENT', status: 'DISABLED' };

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

  it('sends /pending to the login page', () => {
    expect(go('/pending', null)).toBe('/login');
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
  });

  it('denies everything protected to inactive users', () => {
    expect(canAccess('/tickets', pending)).toBe(false);
    expect(canAccess('/console', disabled)).toBe(false);
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
    expect(postSignInRedirect('/api/auth/signout')).toBe('/');
  });
});
