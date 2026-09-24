import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authUserSchema } from '@loons/shared';
import { hashToken } from '../src/lib/tokens.ts';
import { requireAuth } from '../src/plugins/auth.ts';
import {
  TEST_PASSWORD,
  createTestContext,
  mintToken,
  testDomain,
  testEmail,
  type TestContext,
} from './helpers.ts';

// Client self-signup must prove mailbox ownership before it sees any organisation data (SEC-1).

describe('email verification', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({
      beforeReady: (app) => {
        // Stands in for every data route of later phases (tickets…): plain requireAuth().
        app.get('/__test/protected', { preHandler: requireAuth() }, async (req) => ({ id: req.actor?.id }));
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const post = (url: string, payload: Record<string, unknown>, clientIp?: string) =>
    ctx.app.inject({ method: 'POST', url: `/internal/auth${url}`, headers: ctx.internalHeaders(clientIp), payload });
  const register = (email: string, extra: Record<string, unknown> = {}) =>
    post('/register', { name: 'Nadia Test', company: 'Acme', email, password: TEST_PASSWORD, ...extra });
  /** Confirms `token` from the signed-in session of `userId` (the web server sends the session user). */
  const verify = (token: string, userId: string, clientIp?: string) => post('/email/verify', { token, userId }, clientIp);
  const describeLink = (token: string, clientIp?: string) => post('/email/link', { token }, clientIp);
  const resend = async (payload: Record<string, unknown>, clientIp?: string) => {
    const res = await post('/email/resend', payload, clientIp);
    await ctx.app.background.drain(); // the email is prepared after the 202
    return res;
  };
  const bearer = async (method: 'GET' | 'PATCH', url: string, userId: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await mintToken(ctx.config, { sub: userId })}` },
      ...(payload ? { payload } : {}),
    });

  const tokensOf = (userId: string) =>
    ctx.prisma.emailVerificationToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  async function latestLink(userId: string) {
    const unused = (await tokensOf(userId)).filter((t) => t.usedAt === null);
    expect(unused).toHaveLength(1);
    const job = await ctx.queues.email.getJob(`email-verification-${unused[0]!.id}`);
    expect(job, 'queued verification email').toBeDefined();
    const match = /verify-email\/confirm\?token=([A-Za-z0-9_-]+)/.exec(job!.data.text);
    if (!match?.[1]) throw new Error('verification link not found in the email');
    return { record: unused[0]!, job: job!, token: decodeURIComponent(match[1]) };
  }
  /** Whether an Arabic email is sent (the template row, if active, may have no Arabic text). */
  async function arabicAvailable(): Promise<boolean> {
    const row = await ctx.prisma.emailTemplate.findUnique({ where: { key: 'EMAIL_VERIFICATION' } });
    if (!row || !row.isActive || !row.subjectEn.trim() || !row.bodyEn.trim()) return true; // built-in default
    return row.subjectAr.trim() !== '' && row.bodyAr.trim() !== '';
  }
  async function registeredClient(extra: Record<string, unknown> = {}) {
    const domain = testDomain();
    const org = await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    const res = await register(email, extra);
    expect(res.statusCode).toBe(201);
    return { user: authUserSchema.parse(res.json().user), org, email };
  }

  it('sign-up on an organisation domain → unverified member, and a 24 h verification link is emailed', async () => {
    const { user, org, email } = await registeredClient();
    expect(user).toMatchObject({ email, status: 'ACTIVE', orgId: org.id, emailVerified: false });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();

    const { record, job, token } = await latestLink(user.id);
    expect(record.tokenHash).toBe(hashToken(token)); // only the hash is stored
    const ttlHours = (record.expiresAt.getTime() - record.createdAt.getTime()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThanOrEqual(24.01);
    expect(job.data).toMatchObject({ to: email, tag: 'email-verification' });
    expect(job.opts.attempts).toBe(5);
    expect(job.data.html).toContain(`href="${ctx.config.appUrl}/verify-email/confirm?token=`);
  });

  it('sign-up without a matching organisation is unverified and pending, and gets the email too', async () => {
    const email = ctx.fixtures.trackEmail(testEmail());
    const res = await register(email, { locale: 'ar' });
    expect(res.statusCode).toBe(201);
    const user = res.json().user;
    expect(user).toMatchObject({ status: 'PENDING_APPROVAL', emailVerified: false, locale: 'ar' });
    const { job } = await latestLink(user.id);
    const dir = (await arabicAvailable()) ? 'rtl' : 'ltr';
    expect(job.data.html).toMatch(new RegExp(`<html[^>]*dir="${dir}"`));
  });

  it('a failure to queue the email does not fail the sign-up (the user can resend)', async () => {
    const original = ctx.queues.enqueueEmail;
    ctx.queues.enqueueEmail = async () => {
      throw new Error('queue unavailable');
    };
    try {
      const email = ctx.fixtures.trackEmail(testEmail());
      const res = await register(email);
      expect(res.statusCode).toBe(201);
      expect(res.json().user.emailVerified).toBe(false);
    } finally {
      ctx.queues.enqueueEmail = original;
    }
  });

  it('unverified clients can sign in; the API user says emailVerified: false', async () => {
    const { user, email } = await registeredClient();
    const res = await post('/login', { email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, status: 'ACTIVE', emailVerified: false });
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: `/internal/auth/users/${user.id}`,
      headers: ctx.internalHeaders(),
    });
    expect(lookup.json().user.emailVerified).toBe(false);
  });

  it('unverified clients reach GET/PATCH /me only; every other Bearer route → 403 EMAIL_NOT_VERIFIED', async () => {
    const { user } = await registeredClient();
    const me = await bearer('GET', '/me', user.id);
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: user.id, emailVerified: false });
    expect(me.json().org).toBeNull(); // nothing of the matched organisation until verified
    expect((await bearer('PATCH', '/me', user.id, { locale: 'ar' })).statusCode).toBe(204);

    const denied = await bearer('GET', '/__test/protected', user.id);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('unverified comes before pending approval; verified pending users keep the pending answer', async () => {
    const unverifiedPending = await ctx.fixtures.user({ status: 'PENDING_APPROVAL', emailVerified: false });
    const res = await bearer('GET', '/__test/protected', unverifiedPending.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');

    const pending = await ctx.fixtures.user({ status: 'PENDING_APPROVAL' });
    const pendingRes = await bearer('GET', '/__test/protected', pending.id);
    expect(pendingRes.statusCode).toBe(403);
    expect(pendingRes.json().error.code).toBe('FORBIDDEN');

    // Staff are gated by SSO, not by email verification.
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, emailVerified: false });
    expect((await bearer('GET', '/__test/protected', staff.id)).statusCode).toBe(200);
  });

  it('verify → 200 with the verified user; access works at once (principal cache cleared); single use', async () => {
    const { user } = await registeredClient();
    const { token, record } = await latestLink(user.id);
    // Warm the principal cache with the unverified state.
    expect((await bearer('GET', '/__test/protected', user.id)).statusCode).toBe(403);

    const res = await verify(token, user.id);
    expect(res.statusCode).toBe(200);
    expect(authUserSchema.parse(res.json().user)).toMatchObject({ id: user.id, emailVerified: true, sessionVersion: 0 });

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.sessionVersion).toBe(0); // verifying doesn't sign anyone out
    expect((await ctx.prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: record.id } })).usedAt).not.toBeNull();

    const allowed = await bearer('GET', '/__test/protected', user.id);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ id: user.id });
    expect((await bearer('GET', '/me', user.id)).json().org).toMatchObject({ id: user.orgId });

    const again = await verify(token, user.id);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('VERIFY_TOKEN_INVALID');
    expect((await describeLink(token)).json().error.code).toBe('VERIFY_TOKEN_INVALID');
  });

  it('verify deletes the user’s other links', async () => {
    const { user } = await registeredClient();
    const { token } = await latestLink(user.id);
    const other = 'other-link-'.padEnd(43, 'y');
    await ctx.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(other), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    expect((await verify(token, user.id)).statusCode).toBe(200);
    expect(await tokensOf(user.id)).toHaveLength(1); // only the used one is kept
    expect((await verify(other, user.id)).json().error.code).toBe('VERIFY_TOKEN_INVALID');
  });

  it('expired, unknown and disabled-account links → 400 VERIFY_TOKEN_INVALID; malformed → 400 VALIDATION_FAILED', async () => {
    const user = await ctx.fixtures.user({ emailVerified: false });
    const expired = 'expired-link-'.padEnd(43, 'x');
    await ctx.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(expired), expiresAt: new Date(Date.now() - 1000) },
    });
    const expiredRes = await verify(expired, user.id);
    expect(expiredRes.statusCode).toBe(400);
    expect(expiredRes.json().error.code).toBe('VERIFY_TOKEN_INVALID');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();

    const unknown = await verify('u'.repeat(43), user.id);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('VERIFY_TOKEN_INVALID');

    const disabled = await ctx.fixtures.user({ status: 'DISABLED', emailVerified: false });
    const disabledToken = 'disabled-link-'.padEnd(43, 'z');
    await ctx.prisma.emailVerificationToken.create({
      data: { userId: disabled.id, tokenHash: hashToken(disabledToken), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    expect((await verify(disabledToken, disabled.id)).json().error.code).toBe('VERIFY_TOKEN_INVALID');
    for (const dead of [expired, 'u'.repeat(43), disabledToken]) {
      expect((await describeLink(dead)).json().error.code).toBe('VERIFY_TOKEN_INVALID');
    }

    const malformed = await verify('short', user.id);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_FAILED');
    // The signed-in user is required.
    const valid = 'no-session-link-'.padEnd(43, 'n');
    await ctx.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(valid), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const noUser = await post('/email/verify', { token: valid });
    expect(noUser.statusCode).toBe(400);
    expect(noUser.json().error.code).toBe('VALIDATION_FAILED');
    expect((await describeLink('short')).json().error.code).toBe('VALIDATION_FAILED');
  });

  it('link lookup names the account without using the link up (the page shows who must sign in)', async () => {
    const { user, email } = await registeredClient();
    const { token, record } = await latestLink(user.id);
    for (let i = 0; i < 2; i++) {
      const res = await describeLink(token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId: user.id, email });
    }
    expect((await ctx.prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: record.id } })).usedAt).toBeNull();
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });

  it('a link only confirms inside its own account’s session: signed out / another user → 403, link kept (RR-SEC-1)', async () => {
    const { user } = await registeredClient();
    const { token, record } = await latestLink(user.id);
    const other = await ctx.fixtures.user();

    for (const userId of [other.id, crypto.randomUUID()]) {
      const res = await verify(token, userId);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('VERIFY_WRONG_ACCOUNT');
    }
    // Nothing changed: the address is unverified and the link still works for its owner.
    expect((await ctx.prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: record.id } })).usedAt).toBeNull();
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).sessionVersion).toBe(0);
    expect((await verify(token, user.id)).statusCode).toBe(200);
  });

  it('resend → 202; a new link replaces the old one (in the requested language)', async () => {
    const { user } = await registeredClient();
    const first = await latestLink(user.id);
    const res = await resend({ userId: user.id, locale: 'ar' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const second = await latestLink(user.id);
    expect(second.record.id).not.toBe(first.record.id);
    const lang = (await arabicAvailable()) ? 'ar' : 'en';
    expect(second.job.data.html).toMatch(new RegExp(`<html[^>]*lang="${lang}"`));
    expect((await verify(first.token, user.id)).json().error.code).toBe('VERIFY_TOKEN_INVALID');
    expect((await verify(second.token, user.id)).statusCode).toBe(200);
  });

  it('resend sends nothing for verified, staff, disabled or unknown users (still 202)', async () => {
    const before = await ctx.queues.email.getJobCounts();
    const verified = await ctx.fixtures.user();
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, emailVerified: false });
    const disabled = await ctx.fixtures.user({ status: 'DISABLED', emailVerified: false });
    for (const userId of [verified.id, staff.id, disabled.id, crypto.randomUUID()]) {
      expect((await resend({ userId })).statusCode).toBe(202);
      expect(await tokensOf(userId)).toHaveLength(0);
    }
    expect(await ctx.queues.email.getJobCounts()).toEqual(before);
    expect((await resend({ userId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('resend: 3 per user per 15 min, whatever the client IP', async () => {
    const user = await ctx.fixtures.user({ emailVerified: false });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await resend({ userId: user.id }, `100.64.2.${i + 1}`)).statusCode);
    expect(statuses).toEqual([202, 202, 202, 429]);
  });

  it('verify: 10 attempts per client IP per 15 min', async () => {
    const ip = '100.64.3.1';
    const statuses: number[] = [];
    const userId = crypto.randomUUID();
    for (let i = 0; i < 11; i++) statuses.push((await verify(`guess-${i}`.padEnd(43, 'g'), userId, ip)).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await verify('another'.padEnd(43, 'g'), userId, '100.64.3.2')).statusCode).toBe(400);
  });

  it('link lookup: 30 per client IP per 15 min', async () => {
    const ip = '100.64.4.1';
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await describeLink(`peek-${i}`.padEnd(43, 'p'), ip)).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await describeLink('another'.padEnd(43, 'p'), '100.64.4.2')).statusCode).toBe(400);
  });
});
