import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/tokens.ts';
import {
  TEST_PASSWORD,
  createTestContext,
  mintToken,
  rand,
  testDomain,
  testEmail,
  type TestContext,
} from './helpers.ts';

describe('POST /internal/auth/oauth', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const resolve = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/oauth',
      headers: ctx.internalHeaders(),
      payload,
    });
  const google = (email: string, extra: Record<string, unknown> = {}) =>
    resolve({
      provider: 'GOOGLE',
      providerAccountId: `g-${rand()}`,
      email,
      emailVerified: true,
      name: 'Google User',
      ...extra,
    });
  const entra = (email: string, extra: Record<string, unknown> = {}) =>
    resolve({
      provider: 'MICROSOFT_ENTRA_ID',
      providerAccountId: `e-${rand()}`,
      email,
      emailVerified: true,
      name: 'Staff',
      ...extra,
    });
  const passwordLogin = (email: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: ctx.internalHeaders(),
      payload: { email, password: TEST_PASSWORD },
    });
  const getMe = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
  /** The "Google sign-in was added" email queued for the user's (only) Google link, if any. */
  async function googleLinkedEmail(userId: string) {
    const account = await ctx.prisma.authAccount.findFirst({
      where: { userId, provider: 'GOOGLE' },
    });
    if (!account) return undefined;
    return ctx.queues.email.getJob(`google-linked-${account.id}`);
  }

  it('Google: new client on a known domain → created ACTIVE in that org, account linked', async () => {
    const domain = testDomain();
    const org = await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    const providerAccountId = `g-${rand()}`;
    const res = await google(email, { providerAccountId, locale: 'ar' });
    expect(res.statusCode).toBe(200);
    const user = res.json().user;
    expect(user).toMatchObject({
      email,
      role: 'CLIENT',
      status: 'ACTIVE',
      orgId: org.id,
      locale: 'ar',
    });

    const account = await ctx.prisma.authAccount.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: 'GOOGLE', providerAccountId } },
    });
    expect(account.userId).toBe(user.id);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();

    // Second sign-in with the same Google account resolves to the same user.
    const again = await google(email, { providerAccountId });
    expect(again.json().user.id).toBe(user.id);
  });

  it('Google: unknown domain → PENDING_APPROVAL', async () => {
    const email = ctx.fixtures.trackEmail(testEmail());
    const res = await google(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ status: 'PENDING_APPROVAL', orgId: null });
  });

  it('Google first linked to a verified password account: linked, password removed, sessions revoked, owner emailed', async () => {
    const { user } = await ctx.fixtures.client({ locale: 'ar' });
    const oldToken = await mintToken(ctx.config, { sub: user.id, sv: 0 });
    expect((await getMe(oldToken)).statusCode).toBe(200); // warms the principal cache

    const providerAccountId = `g-${rand()}`;
    const res = await google(user.email.toUpperCase(), { providerAccountId });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, emailVerified: true, sessionVersion: 1 });
    expect(
      await ctx.prisma.authAccount.count({ where: { userId: user.id, provider: 'GOOGLE' } }),
    ).toBe(1);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.sessionVersion).toBe(1);
    expect((await passwordLogin(user.email)).statusCode).toBe(401);
    expect((await getMe(oldToken)).statusCode).toBe(401);

    const job = await googleLinkedEmail(user.id);
    expect(job, 'queued "Google sign-in added" email').toBeDefined();
    expect(job!.data).toMatchObject({ to: user.email, tag: 'google-linked' });
    expect(job!.data.html).toContain(`href="${ctx.config.appUrl}/login"`);
    expect(job!.data.html).toMatch(/<html[^>]*dir="(rtl|ltr)"/);

    // Later sign-ins with the same Google account just sign in: nothing more is revoked.
    const again = await google(user.email, { providerAccountId });
    expect(again.json().user.sessionVersion).toBe(1);
    const newToken = await mintToken(ctx.config, { sub: user.id, sv: 1 });
    expect((await getMe(newToken)).statusCode).toBe(200);
  });

  it('register → confirm via the emailed link → Google link: the registrant loses password and tokens (RR-SEC-1)', async () => {
    const domain = testDomain();
    const org = await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    // Someone registers the victim's address with a password of their choosing…
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/register',
      headers: ctx.internalHeaders(),
      payload: { name: 'Registrant', email, password: TEST_PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const registrant = reg.json().user;
    const registrantToken = await mintToken(ctx.config, {
      sub: registrant.id,
      sv: registrant.sessionVersion,
    });

    // …and the address gets confirmed with the emailed link (in the registrant's session).
    const link = await ctx.prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: registrant.id },
    });
    const job = await ctx.queues.email.getJob(`email-verification-${link.id}`);
    const token = decodeURIComponent(/confirm\?token=([A-Za-z0-9_-]+)/.exec(job!.data.text)![1]!);
    expect(link.tokenHash).toBe(hashToken(token));
    const verified = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/email/verify',
      headers: ctx.internalHeaders(),
      payload: { token, userId: registrant.id },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user).toMatchObject({ emailVerified: true, orgId: org.id });
    expect((await getMe(registrantToken)).statusCode).toBe(200);

    // The mailbox owner later uses "Continue with Google".
    const res = await google(email);
    expect(res.statusCode).toBe(200);
    const owner = res.json().user;
    expect(owner).toMatchObject({
      id: registrant.id,
      emailVerified: true,
      sessionVersion: registrant.sessionVersion + 1,
    });

    // The registrant's password and existing tokens stop working at once…
    const login = await passwordLogin(email);
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await getMe(registrantToken)).statusCode).toBe(401);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: registrant.id } })).passwordHash,
    ).toBeNull();
    // …the owner's new session works, and the owner is told what happened.
    const ownerMe = await getMe(
      await mintToken(ctx.config, { sub: owner.id, sv: owner.sessionVersion }),
    );
    expect(ownerMe.statusCode).toBe(200);
    expect((await googleLinkedEmail(registrant.id))?.data.to).toBe(email);
  });

  it('Google first linked to an account without a password: nothing to remove, nothing revoked or sent', async () => {
    const { user } = await ctx.fixtures.client({ password: null });
    const res = await google(user.email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, sessionVersion: 0 });
    expect(await googleLinkedEmail(user.id)).toBeUndefined();
  });

  it('a second Google identity on an account that already has Google is not a first link', async () => {
    const { user } = await ctx.fixtures.client();
    await ctx.prisma.authAccount.create({
      data: {
        userId: user.id,
        provider: 'GOOGLE',
        providerAccountId: `g-${rand()}`,
        email: user.email,
      },
    });
    const res = await google(user.email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.sessionVersion).toBe(0);
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
    ).not.toBeNull();
    expect(
      await ctx.prisma.authAccount.count({ where: { userId: user.id, provider: 'GOOGLE' } }),
    ).toBe(2);
  });

  it('a queueing failure does not fail the Google sign-in (the revocation stands)', async () => {
    const { user } = await ctx.fixtures.client();
    const original = ctx.queues.enqueueEmail;
    ctx.queues.enqueueEmail = async () => {
      throw new Error('queue unavailable');
    };
    try {
      const res = await google(user.email);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.sessionVersion).toBe(1);
    } finally {
      ctx.queues.enqueueEmail = original;
    }
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
    ).toBeNull();
  });

  it('Google on an address nobody verified: the pre-registered password and sessions are revoked (SEC-2)', async () => {
    const domain = testDomain();
    await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    // Someone else registers the victim's address first (they can't open the verification link).
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/register',
      headers: ctx.internalHeaders(),
      payload: { name: 'Squatter', email, password: TEST_PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const squatter = reg.json().user;
    const squatterToken = await mintToken(ctx.config, {
      sub: squatter.id,
      sv: squatter.sessionVersion,
    });
    expect((await getMe(squatterToken)).statusCode).toBe(200); // warms the principal cache

    // The owner of the mailbox later signs in with Google.
    const res = await google(email);
    expect(res.statusCode).toBe(200);
    const owner = res.json().user;
    expect(owner).toMatchObject({
      id: squatter.id,
      emailVerified: true,
      sessionVersion: squatter.sessionVersion + 1,
    });

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: squatter.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(await ctx.prisma.emailVerificationToken.count({ where: { userId: squatter.id } })).toBe(
      0,
    );

    // The squatter's password and existing sessions / API tokens stop working at once…
    const login = await passwordLogin(email);
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await getMe(squatterToken)).statusCode).toBe(401);
    // …while the owner's new session (issued with the returned version) works.
    const ownerMe = await getMe(
      await mintToken(ctx.config, { sub: owner.id, sv: owner.sessionVersion }),
    );
    expect(ownerMe.statusCode).toBe(200);
    expect(ownerMe.json().user.emailVerified).toBe(true);

    // Signing in again later just signs in.
    const again = await google(email);
    expect(again.json().user.sessionVersion).toBe(owner.sessionVersion);
  });

  it('Google: staff-domain email → 403 STAFF_MUST_USE_SSO', async () => {
    const res = await google(`t-${rand()}@${ctx.config.staffEmailDomain}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_MUST_USE_SSO');
  });

  it('Google: unverified email → 403 EMAIL_NOT_VERIFIED', async () => {
    const res = await google(testEmail(), { emailVerified: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('Google: disabled client → 403 ACCOUNT_DISABLED', async () => {
    const { user } = await ctx.fixtures.client({ status: 'DISABLED' });
    const res = await google(user.email);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_DISABLED');
  });

  it('Entra: non-staff email → 403 STAFF_DOMAIN_REQUIRED', async () => {
    const res = await entra(testEmail());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_DOMAIN_REQUIRED');
  });

  it('Entra: unknown staff → 403 FORBIDDEN (accounts are provisioned by admins)', async () => {
    const email = ctx.fixtures.trackEmail(`t-${rand()}@${ctx.config.staffEmailDomain}`);
    const res = await entra(email);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(await ctx.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('Entra: existing active staff → 200 and the account is linked', async () => {
    const staff = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      role: 'TEAM_LEAD',
      password: null,
    });
    const providerAccountId = `e-${rand()}`;
    const res = await entra(staff.email, { providerAccountId });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: staff.id, role: 'TEAM_LEAD' });
    const account = await ctx.prisma.authAccount.findUniqueOrThrow({
      where: { provider_providerAccountId: { provider: 'MICROSOFT_ENTRA_ID', providerAccountId } },
    });
    expect(account.userId).toBe(staff.id);
  });

  it('Entra: a successful staff sign-in marks the address verified (and revokes nothing)', async () => {
    const staff = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      emailVerified: false,
    });
    const res = await entra(staff.email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: staff.id, emailVerified: true, sessionVersion: 0 });
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBeNull();
  });

  it('Entra: disabled staff → 403 ACCOUNT_DISABLED', async () => {
    const staff = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      status: 'DISABLED',
    });
    const res = await entra(staff.email);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_DISABLED');
  });
});
