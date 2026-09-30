import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { PrismaClient } from '@loons/db';
import { oauthResolveSchema, staffListSchema, staffResponseSchema } from '@loons/shared';
import { buildApp, type App } from '../src/app.ts';
import { createTestContext, mintToken, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Staff (E9, E17, E18, E19): super admins only; accounts on STAFF_EMAIL_DOMAIN without a
// password that the first Microsoft sign-in links to; phones in E.164; a role or status change
// revokes sessions and closes sockets; nobody changes their own role, disables themselves or the
// last active super admin.

describe('admin staff', () => {
  let ctx: TestContext;
  let admin: Persona;
  let lead: Persona;
  let agent: Persona;
  let tag: string;
  let broadcast: MockInstance;
  let revoked: MockInstance;
  let disconnect: MockInstance;

  const scopesSent = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const staffEmail = () => ctx.fixtures.trackEmail(`t-${rand()}@${ctx.config.staffEmailDomain}`);
  const userRow = (id: string) => ctx.prisma.user.findUniqueOrThrow({ where: { id } });
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const expectedOf = async (id: string) => (await userRow(id)).updatedAt.toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    tag = rand(4);
    admin = await persona(
      ctx,
      await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: `Sam Admin ${tag}` }),
    );
    lead = await persona(
      ctx,
      await f.staff({ staffDomain, role: 'TEAM_LEAD', name: `Tia Lead ${tag}` }),
    );
    agent = await persona(ctx, await f.staff({ staffDomain, name: `Ali Agent ${tag}` }));
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
    revoked = vi.spyOn(ctx.app.services.sessions, 'sessionsRevoked');
    disconnect = vi.spyOn(ctx.app.realtime, 'disconnectUser');
  });
  beforeEach(() => {
    broadcast.mockClear();
    revoked.mockClear();
    disconnect.mockClear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  it('super admins only: 401 without a token, 403 for team leads and agents', async () => {
    expect((await apiAs(ctx).get('/admin/staff')).statusCode).toBe(401);
    for (const who of [lead, agent]) {
      expect((await apiAs(ctx, who).get('/admin/staff')).statusCode).toBe(403);
      expect((await apiAs(ctx, who).post('/admin/staff', {})).statusCode).toBe(403);
      expect(
        (await apiAs(ctx, who).patch(`/admin/staff/${agent.id}`, { name: 'x' })).statusCode,
      ).toBe(403);
    }
  });

  describe('POST /admin/staff', () => {
    it('creates an ACTIVE account without a password, phone in E.164, audited with the phone masked', async () => {
      const email = staffEmail();
      const nora = `Nora New ${rand(4)}`;
      const res = await apiAs(ctx, admin).post('/admin/staff', {
        email: email.toUpperCase(),
        name: nora,
        role: 'AGENT',
        jobTitle: 'Field engineer',
        phone: '+974 5550 9876',
      });
      expect(res.statusCode).toBe(201);
      const { item } = staffResponseSchema.parse(res.json());
      expect(item).toMatchObject({
        email,
        role: 'AGENT',
        status: 'ACTIVE',
        jobTitle: 'Field engineer',
        phone: '+97455509876',
        phoneValid: true,
        microsoftLinked: false,
        lastLoginAt: null,
        teams: [],
      });
      const row = await userRow(item.id);
      expect(row.passwordHash).toBeNull();
      const [audit] = await auditRows(item.id);
      expect(audit).toMatchObject({ action: 'CREATE', entity: 'User', actorId: admin.id });
      expect(JSON.stringify(audit)).not.toContain('55509876');
      expect(scopesSent()).toEqual(['staff']);

      // The first Microsoft sign-in with that address links to the account (E9).
      const providerAccountId = `e-${rand()}`;
      const sso = await ctx.app.inject({
        method: 'POST',
        url: '/internal/auth/oauth',
        headers: ctx.internalHeaders(),
        payload: {
          provider: 'MICROSOFT_ENTRA_ID',
          providerAccountId,
          email,
          emailVerified: true,
          name: 'Nora (Entra)',
        },
      });
      expect(sso.statusCode).toBe(200);
      expect(sso.json().user).toMatchObject({ id: item.id, role: 'AGENT' });
      expect(
        await ctx.prisma.authAccount.count({
          where: { userId: item.id, provider: 'MICROSOFT_ENTRA_ID', providerAccountId },
        }),
      ).toBe(1);
      const list = staffListSchema.parse(
        (await apiAs(ctx, admin).get(`/admin/staff?search=${encodeURIComponent(nora)}`)).json(),
      );
      expect(list.items.find((s) => s.id === item.id)).toMatchObject({ microsoftLinked: true });
    });

    it('refuses other domains (400), bad phones (400) and taken addresses (409 EMAIL_TAKEN)', async () => {
      const outside = await apiAs(ctx, admin).post('/admin/staff', {
        email: ctx.fixtures.trackEmail(`t-${rand()}@example.com`),
        name: 'Outside Person',
        role: 'AGENT',
      });
      expect(outside.statusCode).toBe(400);
      expect(outside.json().error.details[0]).toMatchObject({
        path: ['email'],
        message: 'validation.staffDomain',
      });
      const phone = await apiAs(ctx, admin).post('/admin/staff', {
        email: staffEmail(),
        name: 'Bad Phone',
        role: 'AGENT',
        phone: '5550 1234',
      });
      expect(phone.statusCode).toBe(400);
      expect(phone.json().error.details[0]).toMatchObject({
        path: ['phone'],
        message: 'validation.phone',
      });
      const taken = await apiAs(ctx, admin).post('/admin/staff', {
        email: (await userRow(agent.id)).email,
        name: 'Copy Cat',
        role: 'AGENT',
      });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.code).toBe('EMAIL_TAKEN');
      expect(scopesSent()).toEqual([]);
    });
  });

  describe('GET /admin/staff', () => {
    it('filters by status and role, searches, and pages with a cursor', async () => {
      const disabled = await ctx.fixtures.staff({
        staffDomain: ctx.config.staffEmailDomain,
        status: 'DISABLED',
        name: `Dee Disabled ${tag}`,
      });
      const get = async (query: string) =>
        staffListSchema.parse((await apiAs(ctx, admin).get(`/admin/staff?${query}`)).json());
      const active = await get(`search=${tag}`);
      expect(active.items.map((s) => s.name)).toEqual([
        `Ali Agent ${tag}`,
        `Sam Admin ${tag}`,
        `Tia Lead ${tag}`,
      ]);
      expect((await get(`search=${tag}&status=archived`)).items.map((s) => s.id)).toEqual([
        disabled.id,
      ]);
      expect((await get(`search=${tag}&status=all`)).items).toHaveLength(4);
      expect((await get(`search=${tag}&role=TEAM_LEAD`)).items.map((s) => s.id)).toEqual([lead.id]);
      const first = await get(`search=${tag}&limit=2`);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await get(`search=${tag}&limit=2&cursor=${first.nextCursor}`);
      expect(second.items.map((s) => s.name)).toEqual([`Tia Lead ${tag}`]);
      expect(second.nextCursor).toBeNull();
      const bad = await apiAs(ctx, admin).get('/admin/staff?cursor=nonsense');
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('PATCH /admin/staff/:id', () => {
    it('edits name, job title and phone without revoking sessions', async () => {
      const u = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const res = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: await expectedOf(u.id),
        name: 'Renamed Person',
        jobTitle: 'Supervisor',
        phone: '0097455501111',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item).toMatchObject({
        name: 'Renamed Person',
        jobTitle: 'Supervisor',
        phone: '+97455501111',
      });
      expect((await userRow(u.id)).sessionVersion).toBe(0);
      expect(revoked).not.toHaveBeenCalled();
      const [audit] = await auditRows(u.id);
      expect(audit).toMatchObject({
        action: 'UPDATE',
        before: { name: 'Test User', jobTitle: null, phone: null },
        after: { name: 'Renamed Person', jobTitle: 'Supervisor' },
      });
      expect(JSON.stringify(audit)).not.toContain('55501111');
      expect(scopesSent()).toEqual(['staff']);
    });

    it('a role or status change bumps sessionVersion, revokes sessions and closes sockets', async () => {
      const u = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const token = await mintToken(ctx.config, { sub: u.id, role: 'AGENT' });
      const me = () =>
        ctx.app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await me()).statusCode).toBe(200);
      const res = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: await expectedOf(u.id),
        role: 'TEAM_LEAD',
      });
      expect(res.statusCode).toBe(200);
      expect((await userRow(u.id)).sessionVersion).toBe(1);
      expect(revoked).toHaveBeenCalledWith(u.id);
      expect(disconnect).toHaveBeenCalledWith(u.id);
      expect((await me()).statusCode).toBe(401);

      const disable = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: await expectedOf(u.id),
        status: 'DISABLED',
      });
      expect(disable.statusCode).toBe(200);
      expect(disable.json().item.status).toBe('DISABLED');
      expect((await userRow(u.id)).sessionVersion).toBe(2);
      expect((await auditRows(u.id)).map((r) => r.after)).toEqual([
        { role: 'TEAM_LEAD' },
        { status: 'DISABLED' },
      ]);
      // PENDING_APPROVAL is not a staff status.
      const pending = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: await expectedOf(u.id),
        status: 'PENDING_APPROVAL',
      });
      expect(pending.statusCode).toBe(400);
    });

    it('nobody changes their own role or disables themselves (409 guard)', async () => {
      const selfRole = await apiAs(ctx, admin).patch(`/admin/staff/${admin.id}`, {
        expectedUpdatedAt: await expectedOf(admin.id),
        role: 'AGENT',
      });
      expect(selfRole.statusCode).toBe(409);
      expect(selfRole.json().error.details).toEqual({ reason: 'guard', guard: 'self_role' });
      const selfDisable = await apiAs(ctx, admin).patch(`/admin/staff/${admin.id}`, {
        expectedUpdatedAt: await expectedOf(admin.id),
        status: 'DISABLED',
      });
      expect(selfDisable.json().error.details).toEqual({ reason: 'guard', guard: 'self_disable' });
      expect(await userRow(admin.id)).toMatchObject({ role: 'SUPER_ADMIN', status: 'ACTIVE' });
      expect(await auditRows(admin.id)).toEqual([]);
      // Editing one's own name is fine.
      const name = await apiAs(ctx, admin).patch(`/admin/staff/${admin.id}`, {
        expectedUpdatedAt: await expectedOf(admin.id),
        name: `Sam Admin ${tag}`,
        jobTitle: 'Head of support',
      });
      expect(name.statusCode).toBe(200);
    });

    it('a sign-in or a locale change is not an edit: a sheet opened before it still saves (E19)', async () => {
      const u = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const start = await expectedOf(u.id);
      await ctx.app.services.auth.resolveOAuth(
        oauthResolveSchema.parse({
          provider: 'MICROSOFT_ENTRA_ID',
          providerAccountId: `e-${rand()}`,
          email: u.email,
          emailVerified: true,
          name: 'Staff',
        }),
      );
      await ctx.app.services.me.updateLocale(u.id, 'ar');
      const row = await userRow(u.id);
      expect(row.lastLoginAt).not.toBeNull();
      expect(row.locale).toBe('ar');
      expect(row.updatedAt.toISOString()).toBe(start);
      const res = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: start,
        jobTitle: 'Site engineer',
      });
      expect(res.statusCode).toBe(200);
      expect((await userRow(u.id)).jobTitle).toBe('Site engineer');
    });

    it('the first Microsoft sign-in of an account the admin just created is not an edit (E19)', async () => {
      // The normal onboarding path: created here (address not verified yet), then the person
      // signs in with Microsoft for the first time while the admin still has the sheet open.
      const email = staffEmail();
      const created = await apiAs(ctx, admin).post('/admin/staff', {
        email,
        name: `Onboarding ${rand(4)}`,
        role: 'AGENT',
      });
      expect(created.statusCode).toBe(201);
      const { item } = staffResponseSchema.parse(created.json());
      expect((await userRow(item.id)).emailVerifiedAt).toBeNull();
      await ctx.app.services.auth.resolveOAuth(
        oauthResolveSchema.parse({
          provider: 'MICROSOFT_ENTRA_ID',
          providerAccountId: `e-${rand()}`,
          email,
          emailVerified: true,
          name: 'Staff',
        }),
      );
      const row = await userRow(item.id);
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(row.updatedAt.toISOString()).toBe(item.updatedAt);
      const res = await apiAs(ctx, admin).patch(`/admin/staff/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        jobTitle: 'Site engineer',
      });
      expect(res.statusCode).toBe(200);
    });

    it('409 stale on an old expectedUpdatedAt; 404 for clients and unknown ids', async () => {
      const u = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const start = await expectedOf(u.id);
      await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: start,
        name: 'First Save',
      });
      const stale = await apiAs(ctx, admin).patch(`/admin/staff/${u.id}`, {
        expectedUpdatedAt: start,
        name: 'Second Save',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      expect((await userRow(u.id)).name).toBe('First Save');
      const { user: clientUser } = await ctx.fixtures.client();
      const notStaff = await apiAs(ctx, admin).patch(`/admin/staff/${clientUser.id}`, {
        expectedUpdatedAt: await expectedOf(clientUser.id),
        name: 'Now staff?',
      });
      expect(notStaff.statusCode).toBe(404);
      const unknown = await apiAs(ctx, admin).patch(`/admin/staff/${crypto.randomUUID()}`, {
        expectedUpdatedAt: start,
        name: 'Ghost',
      });
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe('the last active super admin', () => {
    // The dev database always has other super admins, so this app counts exactly one.
    let app: App;
    beforeAll(async () => {
      const onlyOne = ctx.prisma.$extends({
        query: {
          user: {
            async count({ args, query }) {
              const where = args.where as { role?: unknown } | undefined;
              return where?.role === 'SUPER_ADMIN' ? 1 : query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      app = await buildApp({
        config: ctx.config,
        prisma: onlyOne,
        redis: ctx.redis,
        queues: ctx.queues,
        rateLimitNamespace: `${ctx.config.redisPrefix}rl2:`,
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
    });

    it('cannot be demoted or disabled (409 last_super_admin)', async () => {
      const other = await ctx.fixtures.staff({
        staffDomain: ctx.config.staffEmailDomain,
        role: 'SUPER_ADMIN',
      });
      const send = async (body: Record<string, unknown>) =>
        app.inject({
          method: 'PATCH',
          url: `/admin/staff/${other.id}`,
          headers: { authorization: `Bearer ${admin.token}` },
          payload: { expectedUpdatedAt: await expectedOf(other.id), ...body },
        });
      for (const body of [{ role: 'AGENT' }, { status: 'DISABLED' }]) {
        const res = await send(body);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.details).toEqual({ reason: 'guard', guard: 'last_super_admin' });
      }
      expect(await userRow(other.id)).toMatchObject({ role: 'SUPER_ADMIN', status: 'ACTIVE' });
      // With the real count (other super admins exist) the same change passes.
      const ok = await apiAs(ctx, admin).patch(`/admin/staff/${other.id}`, {
        expectedUpdatedAt: await expectedOf(other.id),
        role: 'AGENT',
      });
      expect(ok.statusCode).toBe(200);
    });
  });
});
