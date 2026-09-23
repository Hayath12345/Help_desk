import { describe, expect, it } from 'vitest';
import {
  apiTokenClaimsSchema,
  authUserSchema,
  emailDomain,
  isStaffEmail,
  normalizeEmail,
} from './auth.ts';
import { ERROR_CODES, apiErrorSchema } from './errors.ts';
import { homePathFor } from './routes.ts';
import { loginSchema, registerSchema } from './schemas/auth.ts';
import { formatTicketNumber, parseTicketNumber } from './ticket-number.ts';

describe('staff email detection', () => {
  it('matches the staff domain exactly, case-insensitively', () => {
    expect(isStaffEmail('Maya.Ruiz@LoonsGroup.com')).toBe(true);
    expect(isStaffEmail('maya@loonsgroup.com.evil.io')).toBe(false);
    expect(isStaffEmail('maya@sub.loonsgroup.com')).toBe(false);
    expect(isStaffEmail('loonsgroup.com@gmail.com')).toBe(false);
  });

  it('normalises emails', () => {
    expect(normalizeEmail('  A@B.COM ')).toBe('a@b.com');
    expect(emailDomain('x@QNB.com')).toBe('qnb.com');
  });
});

describe('session version', () => {
  const user = {
    id: '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f',
    email: 'aisha@hamad.qa',
    name: 'Aisha',
    role: 'CLIENT',
    status: 'ACTIVE',
    orgId: null,
    locale: 'en',
    teamIds: [],
    sessionVersion: 0,
  };
  const claims = {
    sub: user.id,
    role: 'CLIENT',
    sv: 3,
    iss: 'loons-web',
    aud: 'loons-api',
    iat: 1_800_000_000,
    exp: 1_800_000_900,
  };

  it('is part of the API user and must be a non-negative integer', () => {
    expect(authUserSchema.parse(user).sessionVersion).toBe(0);
    const { sessionVersion: _omit, ...withoutVersion } = user;
    expect(authUserSchema.safeParse(withoutVersion).success).toBe(false);
    expect(authUserSchema.safeParse({ ...user, sessionVersion: -1 }).success).toBe(false);
    expect(authUserSchema.safeParse({ ...user, sessionVersion: 1.5 }).success).toBe(false);
  });

  it('is required in API access token claims (sv)', () => {
    expect(apiTokenClaimsSchema.parse(claims).sv).toBe(3);
    const { sv: _omit, ...withoutSv } = claims;
    expect(apiTokenClaimsSchema.safeParse(withoutSv).success).toBe(false);
    expect(apiTokenClaimsSchema.safeParse({ ...claims, sv: '3' }).success).toBe(false);
    expect(apiTokenClaimsSchema.safeParse({ ...claims, sv: -1 }).success).toBe(false);
  });
});

describe('error codes', () => {
  it('include SERVICE_UNAVAILABLE for fail-closed dependencies', () => {
    expect(ERROR_CODES).toContain('SERVICE_UNAVAILABLE');
    const body = { error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again later.' } };
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });
});

describe('auth schemas', () => {
  it('lower-cases and trims the email', () => {
    const r = loginSchema.parse({ email: '  Khalid@QNB.com ', password: 'x' });
    expect(r.email).toBe('khalid@qnb.com');
    expect(r.audience).toBe('client');
  });

  it('enforces the password policy on registration', () => {
    const base = { name: 'Jane Doe', email: 'jane@qnb.com' };
    expect(registerSchema.safeParse({ ...base, password: 'short1' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: 'onlyletterslong' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, password: 'letters-and-123' }).success).toBe(true);
  });
});

describe('routing', () => {
  it('sends each role to its home', () => {
    expect(homePathFor('CLIENT')).toBe('/tickets');
    expect(homePathFor('AGENT')).toBe('/console/inbox');
    expect(homePathFor('TEAM_LEAD')).toBe('/console/inbox');
    expect(homePathFor('SUPER_ADMIN')).toBe('/admin');
  });
});

describe('ticket numbers', () => {
  it('formats and parses LG ids', () => {
    expect(formatTicketNumber(4817)).toBe('LG-4817');
    expect(parseTicketNumber('lg-4817')).toBe(4817);
    expect(parseTicketNumber('4817')).toBe(4817);
    expect(parseTicketNumber('LG-')).toBeNull();
    expect(parseTicketNumber('LG-12a')).toBeNull();
  });
});
