import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authUserSchema } from '@loons/shared';
import { TEST_PASSWORD, createTestContext, testEmail, type TestContext } from './helpers.ts';

describe('POST /internal/auth/login', () => {
  let ctx: TestContext;
  let noDevCtx: TestContext;
  beforeAll(async () => {
    [ctx, noDevCtx] = await Promise.all([
      createTestContext({ config: { devStaffLogin: true } }),
      createTestContext({ config: { devStaffLogin: false } }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([ctx.close(), noDevCtx.close()]);
  });

  const login = (c: TestContext, payload: Record<string, unknown>) =>
    c.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: c.internalHeaders(),
      payload,
    });

  it('signs in an active client and records lastLoginAt', async () => {
    const { user, org } = await ctx.fixtures.client({ locale: 'ar' });
    const res = await login(ctx, { email: user.email.toUpperCase(), password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(authUserSchema.parse(body.user)).toMatchObject({
      id: user.id,
      email: user.email,
      role: 'CLIENT',
      status: 'ACTIVE',
      orgId: org.id,
      locale: 'ar',
      teamIds: [],
      sessionVersion: 0,
      emailVerified: true,
    });
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lastLoginAt).not.toBeNull();
  });

  it('wrong password → 401 INVALID_CREDENTIALS', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await login(ctx, { email: user.email, password: 'Wrong-password-1' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('unknown email → the same generic 401 as a wrong password', async () => {
    const { user } = await ctx.fixtures.client();
    const wrong = await login(ctx, { email: user.email, password: 'Wrong-password-1' });
    const unknown = await login(ctx, { email: testEmail(), password: 'Wrong-password-1' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toEqual(wrong.json().error);
  });

  it('SSO-only account (no password) → generic 401', async () => {
    const { user } = await ctx.fixtures.client({ password: null });
    const res = await login(ctx, { email: user.email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('disabled account → 403 ACCOUNT_DISABLED (only once the password is right)', async () => {
    const { user } = await ctx.fixtures.client({ status: 'DISABLED' });
    const right = await login(ctx, { email: user.email, password: TEST_PASSWORD });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('ACCOUNT_DISABLED');
    const wrong = await login(ctx, { email: user.email, password: 'Wrong-password-1' });
    expect(wrong.statusCode).toBe(401);
  });

  it('pending-approval client signs in with status PENDING_APPROVAL', async () => {
    const user = await ctx.fixtures.user({ status: 'PENDING_APPROVAL' });
    const res = await login(ctx, { email: user.email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, status: 'PENDING_APPROVAL', orgId: null });
  });

  it('client on the staff sign-in page → 403 CLIENT_PORTAL_ONLY', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await login(ctx, { email: user.email, password: TEST_PASSWORD, audience: 'staff' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLIENT_PORTAL_ONLY');
  });

  it('staff email on the client sign-in page → 403 STAFF_MUST_USE_SSO', async () => {
    const staff = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
    const res = await login(ctx, {
      email: staff.email,
      password: TEST_PASSWORD,
      audience: 'client',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_MUST_USE_SSO');
  });

  it('staff role with a non-staff email on the client page → 403 STAFF_MUST_USE_SSO', async () => {
    const staff = await ctx.fixtures.user({ role: 'TEAM_LEAD' });
    const res = await login(ctx, {
      email: staff.email,
      password: TEST_PASSWORD,
      audience: 'client',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_MUST_USE_SSO');
  });

  it('staff password sign-in works on the staff page when the dev flag is on', async () => {
    const staff = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      role: 'SUPER_ADMIN',
    });
    const team = await ctx.fixtures.team();
    await ctx.fixtures.member(team.id, staff.id, 'LEAD');
    const res = await login(ctx, {
      email: staff.email,
      password: TEST_PASSWORD,
      audience: 'staff',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      id: staff.id,
      role: 'SUPER_ADMIN',
      orgId: null,
      teamIds: [team.id],
    });
  });

  it('dev flag off → staff password sign-in is refused with STAFF_MUST_USE_SSO', async () => {
    const staff = await noDevCtx.fixtures.staff({ staffDomain: noDevCtx.config.staffEmailDomain });
    const res = await login(noDevCtx, {
      email: staff.email,
      password: TEST_PASSWORD,
      audience: 'staff',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_MUST_USE_SSO');

    // Also for a staff role on a non-staff domain.
    const other = await noDevCtx.fixtures.user({ role: 'AGENT' });
    const res2 = await login(noDevCtx, {
      email: other.email,
      password: TEST_PASSWORD,
      audience: 'staff',
    });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().error.code).toBe('STAFF_MUST_USE_SSO');
  });

  it('the dev flag is always off in production', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const prod = loadConfig({
      ...process.env,
      NODE_ENV: 'production',
      AUTH_DEV_STAFF_LOGIN: 'true',
    });
    expect(prod.devStaffLogin).toBe(false);
  });
});
