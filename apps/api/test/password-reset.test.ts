import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickTemplateText, DEFAULT_EMAIL_TEMPLATES } from '@loons/emails';
import { hashToken } from '../src/lib/tokens.ts';
import {
  TEST_PASSWORD,
  createTestContext,
  mintToken,
  testEmail,
  type TestContext,
} from './helpers.ts';

const NEW_PASSWORD = 'Brand-new-pass-77';

describe('password reset', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const forgot = async (email: string, locale: 'en' | 'ar' = 'en') => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/password/forgot',
      headers: ctx.internalHeaders(),
      payload: { email, locale },
    });
    await ctx.app.background.drain(); // the email is prepared after the 202
    return res;
  };
  const reset = (token: string, password = NEW_PASSWORD) =>
    ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/password/reset',
      headers: ctx.internalHeaders(),
      payload: { token, password },
    });
  const tokensOf = (userId: string) =>
    ctx.prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const tokenFromJob = (text: string) => {
    const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(text);
    if (!match?.[1]) throw new Error('reset link not found in email');
    return decodeURIComponent(match[1]);
  };

  /** What the email should look like given the (optional) EmailTemplate row in this database. */
  async function expectedLocale(userLocale: 'en' | 'ar') {
    const row = await ctx.prisma.emailTemplate.findUnique({ where: { key: 'PASSWORD_RESET' } });
    const usable = row && row.isActive && row.subjectEn.trim() && row.bodyEn.trim();
    return pickTemplateText(usable ? row : DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET, userLocale)
      .locale;
  }

  it('forgot → 202, hashed token stored, email job queued; reset → 204 and the new password works', async () => {
    const { user } = await ctx.fixtures.client({ name: 'Rania <b>Test</b>' });
    const res = await forgot(user.email);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const [record] = await tokensOf(user.id);
    expect(record).toBeDefined();
    expect(record!.usedAt).toBeNull();
    const ttlMinutes = (record!.expiresAt.getTime() - record!.createdAt.getTime()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29);
    expect(ttlMinutes).toBeLessThanOrEqual(30.1);

    const job = await ctx.queues.email.getJob(`password-reset-${record!.id}`);
    expect(job).toBeDefined();
    expect(job!.data.to).toBe(user.email);
    expect(job!.data.tag).toBe('password-reset');
    expect(job!.opts.attempts).toBe(5);
    expect(job!.data.html).toContain(`${ctx.config.appUrl}/reset-password?token=`);
    expect(job!.data.html).not.toContain('<b>Test</b>'); // the name is escaped in HTML
    expect(job!.data.html).toMatch(new RegExp(`<html[^>]*lang="${await expectedLocale('en')}"`));

    const token = tokenFromJob(job!.data.text);
    expect(record!.tokenHash).toBe(hashToken(token)); // only the hash is stored
    expect(record!.tokenHash).not.toContain(token);

    // An API token from a session that existed before the reset (the call caches the principal).
    const getMe = (bearer: string) =>
      ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${bearer}` } });
    const oldApiToken = await mintToken(ctx.config, { sub: user.id, sv: 0 });
    expect((await getMe(oldApiToken)).statusCode).toBe(200);

    const done = await reset(token);
    expect(done.statusCode).toBe(204);

    const updated = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.emailVerifiedAt).not.toBeNull();
    // Every existing session is revoked: the version moved on and old tokens stop working at once.
    expect(updated.sessionVersion).toBe(1);
    const revoked = await getMe(oldApiToken);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe('UNAUTHENTICATED');
    expect((await getMe(await mintToken(ctx.config, { sub: user.id, sv: 1 }))).statusCode).toBe(
      200,
    );

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: ctx.internalHeaders(),
      payload: { email: user.email, password: NEW_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.sessionVersion).toBe(1); // new sessions carry the new version
    const oldLogin = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: ctx.internalHeaders(),
      payload: { email: user.email, password: TEST_PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);

    // Single use.
    const again = await reset(token, 'Another-pass-88');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('RESET_TOKEN_INVALID');
    // A rejected reset revokes nothing.
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
    ).toBe(1);
  });

  it('Arabic-speaking users get the email in their language (when Arabic text exists)', async () => {
    const { user } = await ctx.fixtures.client({ locale: 'ar' });
    await forgot(user.email, 'en');
    const [record] = await tokensOf(user.id);
    const job = await ctx.queues.email.getJob(`password-reset-${record!.id}`);
    const locale = await expectedLocale('ar');
    expect(job!.data.html).toMatch(
      new RegExp(`<html[^>]*dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`),
    );
  });

  it('expired token → 400 RESET_TOKEN_INVALID', async () => {
    const { user } = await ctx.fixtures.client();
    const token = 'expired-token-'.padEnd(43, 'x');
    await ctx.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await reset(token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESET_TOKEN_INVALID');
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
    ).toBe(0);
  });

  it('unknown token → 400 RESET_TOKEN_INVALID', async () => {
    const res = await reset('x'.repeat(43));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESET_TOKEN_INVALID');
  });

  it('a new request invalidates the previous unused token', async () => {
    const { user } = await ctx.fixtures.client();
    await forgot(user.email);
    const [first] = await tokensOf(user.id);
    const firstJob = await ctx.queues.email.getJob(`password-reset-${first!.id}`);
    const firstToken = tokenFromJob(firstJob!.data.text);

    await forgot(user.email);
    const tokens = await tokensOf(user.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).not.toBe(first!.id);

    const res = await reset(firstToken);
    expect(res.statusCode).toBe(400);
  });

  it('unknown, staff and disabled accounts get 202 but no token and no email', async () => {
    const before = await ctx.queues.email.getJobCounts();
    const unknown = await forgot(testEmail());
    expect(unknown.statusCode).toBe(202);

    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    const staffRes = await forgot(staff.email);
    expect(staffRes.statusCode).toBe(202);
    expect(await tokensOf(staff.id)).toHaveLength(0);

    const { user: disabled } = await ctx.fixtures.client({ status: 'DISABLED' });
    const disabledRes = await forgot(disabled.email);
    expect(disabledRes.statusCode).toBe(202);
    expect(await tokensOf(disabled.id)).toHaveLength(0);

    const after = await ctx.queues.email.getJobCounts();
    expect(after).toEqual(before);
  });

  it('pending-approval clients can reset their password', async () => {
    const user = await ctx.fixtures.user({ status: 'PENDING_APPROVAL' });
    await forgot(user.email);
    expect(await tokensOf(user.id)).toHaveLength(1);
  });
});
