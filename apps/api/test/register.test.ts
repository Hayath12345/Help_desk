import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, createTestContext, rand, testDomain, testEmail, type TestContext } from './helpers.ts';

describe('POST /internal/auth/register', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const register = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/internal/auth/register', headers: ctx.internalHeaders(), payload });

  it('email domain matching an organisation → ACTIVE member of that organisation, email not yet verified', async () => {
    const domain = testDomain();
    const org = await ctx.fixtures.org({ domains: [domain] });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    const res = await register({ name: 'Nadia Test', company: 'Ignored', email: email.toUpperCase(), password: TEST_PASSWORD, locale: 'ar' });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({
      email,
      role: 'CLIENT',
      status: 'ACTIVE',
      orgId: org.id,
      locale: 'ar',
      emailVerified: false,
    });

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.signupCompany).toBeNull();
    // No data access until the emailed link is opened (see email-verification.test.ts).
    expect(row.emailVerifiedAt).toBeNull();
    expect(await ctx.prisma.emailVerificationToken.count({ where: { userId: row.id } })).toBe(1);
  });

  it('no matching organisation → PENDING_APPROVAL, no org, company kept for review', async () => {
    const email = ctx.fixtures.trackEmail(testEmail());
    const company = `Acme ${rand()}`;
    const res = await register({ name: 'Omar Test', company, email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email, status: 'PENDING_APPROVAL', orgId: null, locale: 'en' });
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.signupCompany).toBe(company);
  });

  it('an archived organisation does not match', async () => {
    const domain = testDomain();
    await ctx.fixtures.org({ domains: [domain], isActive: false });
    const email = ctx.fixtures.trackEmail(testEmail(domain));
    const res = await register({ name: 'Archived Org', email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.status).toBe('PENDING_APPROVAL');
  });

  it('staff-domain email → 403 STAFF_MUST_USE_SSO', async () => {
    const email = ctx.fixtures.trackEmail(`t-${rand()}@${ctx.config.staffEmailDomain}`);
    const res = await register({ name: 'Staff Person', email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_MUST_USE_SSO');
    expect(await ctx.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('existing email → 409 EMAIL_TAKEN', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await register({ name: 'Dup User', email: user.email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('password policy is enforced (400 VALIDATION_FAILED)', async () => {
    const res = await register({ name: 'Weak Pass', email: testEmail(), password: 'onlyletters' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toEqual([
      expect.objectContaining({ path: ['password'], message: 'validation.passwordComplexity' }),
    ]);
  });
});
