import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, createTestContext, mintToken, rand, testDomain, testEmail, type TestContext } from './helpers.ts';

describe('POST /internal/auth/oauth', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const resolve = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/internal/auth/oauth', headers: ctx.internalHeaders(), payload });
  const google = (email: string, extra: Record<string, unknown> = {}) =>
    resolve({ provider: 'GOOGLE', providerAccountId: `g-${rand()}`, email, emailVerified: true, name: 'Google User', ...extra });
  const entra = (email: string, extra: Record<string, unknown> = {}) =>
    resolve({ provider: 'MICROSOFT_ENTRA_ID', providerAccountId: `e-${rand()}`, email, emailVerified: true, name: 'Staff', ...extra });
  const passwordLogin = (email: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: ctx.internalHeaders(),
      payload: { email, password: TEST_PASSWORD },
    });
  const getMe = (token: string) =>
    ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });

  it('Google: new client on a known domain → created ACTIVE in that org, account linked', async () => {
    const domain = testDomain();
    const org = await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    const providerAccountId = `g-${rand()}`;
    const res = await google(email, { providerAccountId, locale: 'ar' });
    expect(res.statusCode).toBe(200);
    const user = res.json().user;
    expect(user).toMatchObject({ email, role: 'CLIENT', status: 'ACTIVE', orgId: org.id, locale: 'ar' });

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

  it('Google: existing verified password account is linked, not duplicated; password and sessions kept', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await google(user.email.toUpperCase());
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, emailVerified: true, sessionVersion: 0 });
    expect(await ctx.prisma.authAccount.count({ where: { userId: user.id, provider: 'GOOGLE' } })).toBe(1);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).not.toBeNull();
    expect(row.sessionVersion).toBe(0);
    expect((await passwordLogin(user.email)).statusCode).toBe(200);
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
    const squatterToken = await mintToken(ctx.config, { sub: squatter.id, sv: squatter.sessionVersion });
    expect((await getMe(squatterToken)).statusCode).toBe(200); // warms the principal cache

    // The owner of the mailbox later signs in with Google.
    const res = await google(email);
    expect(res.statusCode).toBe(200);
    const owner = res.json().user;
    expect(owner).toMatchObject({ id: squatter.id, emailVerified: true, sessionVersion: squatter.sessionVersion + 1 });

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: squatter.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(await ctx.prisma.emailVerificationToken.count({ where: { userId: squatter.id } })).toBe(0);

    // The squatter's password and existing sessions / API tokens stop working at once…
    const login = await passwordLogin(email);
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await getMe(squatterToken)).statusCode).toBe(401);
    // …while the owner's new session (issued with the returned version) works.
    const ownerMe = await getMe(await mintToken(ctx.config, { sub: owner.id, sv: owner.sessionVersion }));
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
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, role: 'TEAM_LEAD', password: null });
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
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, emailVerified: false });
    const res = await entra(staff.email);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: staff.id, emailVerified: true, sessionVersion: 0 });
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.passwordHash).not.toBeNull();
  });

  it('Entra: disabled staff → 403 ACCOUNT_DISABLED', async () => {
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain, status: 'DISABLED' });
    const res = await entra(staff.email);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_DISABLED');
  });
});
