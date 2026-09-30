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
import {
  organizationListSchema,
  organizationResponseSchema,
  pendingSignupListSchema,
  siteResponseSchema,
} from '@loons/shared';
import { matchOrganizationByDomain } from '../src/services/organizations.ts';
import {
  TEST_PASSWORD,
  createTestContext,
  rand,
  testDomain,
  testEmail,
  type TestContext,
} from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Clients & sites, pending sign-ups (E5, E10, E17, E18, E19): super admins only; email
// domain rules (lower-case, unique across every organisation, never the staff domain or a public
// mail domain); account manager and phone checks; archive makes clients read-only; sites with
// reorder / archive; approve / reject of PENDING_APPROVAL sign-ups; stale 409; audit rows; the
// `form-context` scope.

describe('admin clients', () => {
  let ctx: TestContext;
  let admin: Persona;
  let lead: Persona;
  let manager: { id: string; name: string };
  let disabledStaff: { id: string };
  let tag: string;
  let broadcast: MockInstance;
  let invalidate: MockInstance;
  let revoked: MockInstance;

  const scopesSent = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const orgUpdatedAt = async (id: string) =>
    (await ctx.prisma.organization.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
  const siteUpdatedAt = async (id: string) =>
    (await ctx.prisma.site.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

  async function createOrg(body: Record<string, unknown> = {}) {
    const res = await apiAs(ctx, admin).post('/admin/clients', {
      name: `Org ${tag} ${rand(3)}`,
      ...body,
    });
    if (res.statusCode !== 201) throw new Error(`create org: ${res.statusCode} ${res.body}`);
    const { item } = organizationResponseSchema.parse(res.json());
    ctx.fixtures.trackOrg(item.id);
    return item;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    tag = rand(4);
    // Organisations a refused request must not create (removed if a bug creates them).
    f.onCleanup(() =>
      ctx.prisma.organization.deleteMany({ where: { name: { endsWith: ` ${tag}!` } } }),
    );
    const staffDomain = ctx.config.staffEmailDomain;
    admin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    const team = await f.team();
    await f.member(team.id, tl.id, 'LEAD');
    lead = await persona(ctx, tl);
    manager = await f.staff({ staffDomain, name: 'Maya Manager' });
    disabledStaff = await f.staff({ staffDomain, status: 'DISABLED' });
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
    invalidate = vi.spyOn(ctx.app.principals, 'invalidate');
    revoked = vi.spyOn(ctx.app.services.sessions, 'sessionsRevoked');
  });
  beforeEach(() => {
    broadcast.mockClear();
    invalidate.mockClear();
    revoked.mockClear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  it('super admins only (team leads 403)', async () => {
    expect((await apiAs(ctx).get('/admin/clients')).statusCode).toBe(401);
    for (const url of ['/admin/clients', '/admin/clients/pending-signups']) {
      expect((await apiAs(ctx, lead).get(url)).statusCode).toBe(403);
    }
    expect(
      (await apiAs(ctx, lead).post('/admin/clients', { name: `Lead ${tag}!` })).statusCode,
    ).toBe(403);
  });

  describe('organisations', () => {
    it('creates one: key from the name, domains lower-cased, phone in E.164, account manager, audit, scope', async () => {
      const domain = testDomain();
      const name = `Qatar Clinic ${tag}`;
      const item = await createOrg({
        name,
        nameAr: 'عيادة قطر',
        contractType: 'BILLABLE',
        amcExpiry: '2027-03-31',
        accountManagerId: manager.id,
        emailDomains: [domain.toUpperCase(), domain],
        phone: '+974 4444 0000',
      });
      expect(item).toMatchObject({
        key: `qatar-clinic-${tag}`,
        name,
        nameAr: 'عيادة قطر',
        contractType: 'BILLABLE',
        amcExpiry: '2027-03-31',
        accountManager: { id: manager.id, name: 'Maya Manager' },
        emailDomains: [domain],
        phone: '+97444440000',
        isActive: true,
        sites: [],
        clientCount: 0,
      });
      const [row] = await auditRows(item.id);
      expect(row).toMatchObject({ action: 'CREATE', entity: 'Organization', entityLabel: name });
      expect(JSON.stringify(row)).not.toContain('44440000');
      expect(scopesSent()).toEqual(['form-context']);
    });

    it('refuses the staff domain, public mail domains, bad phones and inactive account managers (400)', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { emailDomains: [ctx.config.staffEmailDomain.toUpperCase()] },
          'validation.staffEmailDomain',
        ],
        [{ emailDomains: ['gmail.com'] }, 'validation.publicEmailDomain'],
        // Regional variants of consumer providers too (contract-2).
        [{ emailDomains: ['outlook.sa'] }, 'validation.publicEmailDomain'],
        [{ emailDomains: ['hotmail.co.uk'] }, 'validation.publicEmailDomain'],
        [{ emailDomains: ['not a domain'] }, 'validation.emailDomain'],
        [{ phone: '4444' }, 'validation.phone'],
        [{ accountManagerId: disabledStaff.id }, 'validation.activeStaff'],
        [{ accountManagerId: crypto.randomUUID() }, 'validation.activeStaff'],
      ];
      for (const [body, message] of cases) {
        const res = await apiAs(ctx, admin).post('/admin/clients', {
          name: `Refused ${tag}!`,
          ...body,
        });
        expect(res.statusCode, message).toBe(400);
        expect(JSON.stringify(res.json().error.details), message).toContain(message);
      }
      expect(await ctx.prisma.organization.count({ where: { name: `Refused ${tag}!` } })).toBe(0);
      expect(scopesSent()).toEqual([]);
    });

    it('email domains are unique across every organisation, archived ones included (409)', async () => {
      const domain = testDomain();
      const archived = await ctx.fixtures.org({ domains: [domain], isActive: false });
      const res = await apiAs(ctx, admin).post('/admin/clients', {
        name: `Clash ${tag}!`,
        emailDomains: [domain],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({
        reason: 'duplicate',
        fields: ['emailDomains'],
        existingId: archived.id,
        existingIsActive: false,
      });
      const mine = await createOrg({ emailDomains: [testDomain()] });
      const update = await apiAs(ctx, admin).patch(`/admin/clients/${mine.id}`, {
        expectedUpdatedAt: mine.updatedAt,
        emailDomains: [...mine.emailDomains, domain],
      });
      expect(update.statusCode).toBe(409);
      // Its own domains are not a clash.
      const same = await apiAs(ctx, admin).patch(`/admin/clients/${mine.id}`, {
        expectedUpdatedAt: mine.updatedAt,
        emailDomains: mine.emailDomains,
        name: `${mine.name} renamed`,
      });
      expect(same.statusCode).toBe(200);
    });

    it('updates with expectedUpdatedAt (409 stale) and audits the changed fields only', async () => {
      const org = await createOrg();
      const res = await apiAs(ctx, admin).patch(`/admin/clients/${org.id}`, {
        expectedUpdatedAt: org.updatedAt,
        contractType: 'BILLABLE',
        amcExpiry: null,
      });
      expect(res.statusCode).toBe(200);
      const stale = await apiAs(ctx, admin).patch(`/admin/clients/${org.id}`, {
        expectedUpdatedAt: org.updatedAt,
        name: 'Lost update',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      const rows = await auditRows(org.id);
      expect(rows.map((r) => [r.action, r.before, r.after])).toEqual([
        ['CREATE', null, expect.anything()],
        ['UPDATE', { contractType: 'AMC' }, { contractType: 'BILLABLE' }],
      ]);
    });

    it('lists with status, search (name or exact domain) and a cursor', async () => {
      const domain = testDomain();
      const a = await createOrg({ name: `Alpha ${tag}`, emailDomains: [domain] });
      const b = await createOrg({ name: `Beta ${tag}` });
      const c = await createOrg({ name: `Gamma ${tag}` });
      await apiAs(ctx, admin).post(`/admin/clients/${c.id}/archive`, {
        expectedUpdatedAt: c.updatedAt,
      });
      const get = async (query: string) =>
        organizationListSchema.parse(
          (await apiAs(ctx, admin).get(`/admin/clients?${query}`)).json(),
        );
      const search = `search=${encodeURIComponent(`a ${tag}`)}`;
      expect((await get(search)).items.map((o) => o.id)).toEqual([a.id, b.id]);
      expect((await get(`${search}&status=archived`)).items.map((o) => o.id)).toEqual([c.id]);
      expect((await get(`search=${domain}`)).items.map((o) => o.id)).toEqual([a.id]);
      const first = await get(`${search}&status=all&limit=2`);
      expect(first.items.map((o) => o.id)).toEqual([a.id, b.id]);
      const next = await get(`${search}&status=all&limit=2&cursor=${first.nextCursor}`);
      expect(next.items.map((o) => o.id)).toEqual([c.id]);
      expect(next.nextCursor).toBeNull();
    });

    it('archiving makes its clients read-only and stops sign-up matching; restore undoes it', async () => {
      const domain = testDomain();
      const org = await createOrg({ emailDomains: [domain] });
      const site = await ctx.fixtures.site(org.id);
      const user = await ctx.fixtures.user({ email: testEmail(domain), orgId: org.id });
      const client = await persona(ctx, user);
      expect(await matchOrganizationByDomain(ctx.prisma, domain)).toEqual({ id: org.id });
      broadcast.mockClear();
      const archived = await apiAs(ctx, admin).post(`/admin/clients/${org.id}/archive`, {
        expectedUpdatedAt: await orgUpdatedAt(org.id),
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().item.isActive).toBe(false);
      expect(invalidate).toHaveBeenCalledWith(user.id);
      expect(scopesSent()).toEqual(['form-context']);
      expect(await matchOrganizationByDomain(ctx.prisma, domain)).toBeNull();
      const presign = await apiAs(ctx, client).post('/tickets', {
        type: 'INCIDENT',
        categoryId: crypto.randomUUID(),
        subtypeId: crypto.randomUUID(),
        impact: 'SINGLE_USER',
        siteId: site.id,
        subject: 'Should be refused',
        description: 'The organisation is archived so this must be refused.',
      });
      expect(presign.statusCode).toBe(403);
      // Reads still work.
      expect((await apiAs(ctx, client).get('/tickets')).statusCode).toBe(200);
      const restored = await apiAs(ctx, admin).post(`/admin/clients/${org.id}/restore`, {
        expectedUpdatedAt: await orgUpdatedAt(org.id),
      });
      expect(restored.json().item.isActive).toBe(true);
      expect((await auditRows(org.id)).map((r) => r.action)).toEqual([
        'CREATE',
        'ARCHIVE',
        'RESTORE',
      ]);
    });
  });

  describe('sites', () => {
    it('adds, edits, archives, restores and reorders sites of one organisation', async () => {
      const org = await createOrg();
      broadcast.mockClear();
      const add = async (name: string) => {
        const res = await apiAs(ctx, admin).post(`/admin/clients/${org.id}/sites`, {
          name,
          nameAr: '',
          address: 'West Bay, Doha',
        });
        expect(res.statusCode).toBe(201);
        return siteResponseSchema.parse(res.json()).item;
      };
      const hq = await add('Head Office');
      const branch = await add('Branch');
      const lab = await add('Lab');
      expect(hq).toMatchObject({ key: 'head-office', nameAr: null, sortOrder: 0 });
      expect(lab.sortOrder).toBe(2);
      expect(scopesSent()).toEqual(['form-context', 'form-context', 'form-context']);

      const edit = await apiAs(ctx, admin).patch(`/admin/clients/${org.id}/sites/${hq.id}`, {
        expectedUpdatedAt: hq.updatedAt,
        nameAr: 'المكتب الرئيسي',
      });
      expect(edit.statusCode).toBe(200);
      expect(edit.json().item.nameAr).toBe('المكتب الرئيسي');
      const stale = await apiAs(ctx, admin).patch(`/admin/clients/${org.id}/sites/${hq.id}`, {
        expectedUpdatedAt: hq.updatedAt,
        name: 'Lost',
      });
      expect(stale.statusCode).toBe(409);

      // A site of another organisation is not found through this one.
      const other = await createOrg();
      const wrong = await apiAs(ctx, admin).patch(`/admin/clients/${other.id}/sites/${hq.id}`, {
        expectedUpdatedAt: await siteUpdatedAt(hq.id),
        name: 'Hijack',
      });
      expect(wrong.statusCode).toBe(404);

      const archived = await apiAs(ctx, admin).post(
        `/admin/clients/${org.id}/sites/${branch.id}/archive`,
        { expectedUpdatedAt: branch.updatedAt },
      );
      expect(archived.json().item.isActive).toBe(false);

      // Reorder the active sites (archived ones are not part of the list).
      const order = await apiAs(ctx, admin).post(`/admin/clients/${org.id}/sites/reorder`, {
        expectedIds: [hq.id, lab.id],
        ids: [lab.id, hq.id],
      });
      expect(order.statusCode).toBe(204);
      const changed = await apiAs(ctx, admin).post(`/admin/clients/${org.id}/sites/reorder`, {
        expectedIds: [hq.id, branch.id, lab.id],
        ids: [lab.id, branch.id, hq.id],
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.details.reason).toBe('order_changed');
      const list = organizationListSchema.parse(
        (
          await apiAs(ctx, admin).get(`/admin/clients?search=${encodeURIComponent(org.name)}`)
        ).json(),
      );
      expect(list.items[0]?.sites.map((s) => [s.name, s.isActive])).toEqual([
        ['Lab', true],
        ['Head Office', true],
        ['Branch', false],
      ]);

      const restored = await apiAs(ctx, admin).post(
        `/admin/clients/${org.id}/sites/${branch.id}/restore`,
        { expectedUpdatedAt: await siteUpdatedAt(branch.id) },
      );
      expect(restored.json().item.isActive).toBe(true);
      const actions = await ctx.prisma.adminAuditLog.findMany({
        where: { entity: 'Site', actorId: admin.id, entityId: { in: [branch.id, org.id] } },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      });
      expect(actions.map((a) => a.action)).toEqual(['CREATE', 'ARCHIVE', 'REORDER', 'RESTORE']);
    });
  });

  describe('pending sign-ups (E10)', () => {
    async function pending(name: string) {
      const user = await ctx.fixtures.user({ status: 'PENDING_APPROVAL', name });
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { signupCompany: 'Unknown Co' },
      });
      return ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    }

    it('lists pending clients oldest first with their domain and company', async () => {
      const first = await pending(`Pat Pending ${tag}`);
      const second = await pending(`Pia Pending ${tag}`);
      const res = await apiAs(ctx, admin).get(`/admin/clients/pending-signups?search=${tag}`);
      expect(res.statusCode).toBe(200);
      const { items } = pendingSignupListSchema.parse(res.json());
      expect(items.map((i) => i.id)).toEqual([first.id, second.id]);
      expect(items[0]).toMatchObject({
        emailDomain: first.email.split('@')[1],
        signupCompany: 'Unknown Co',
        status: 'PENDING_APPROVAL',
        org: null,
      });
      await ctx.prisma.user.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { status: 'DISABLED' },
      });
    });

    it('approves into an active organisation: ACTIVE, org set, principal invalidated, audited', async () => {
      const user = await pending(`Ann Approve ${tag}`);
      const org = await createOrg();
      const archivedOrg = await createOrg();
      await apiAs(ctx, admin).post(`/admin/clients/${archivedOrg.id}/archive`, {
        expectedUpdatedAt: archivedOrg.updatedAt,
      });
      const toArchived = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/approve`,
        { expectedUpdatedAt: user.updatedAt.toISOString(), orgId: archivedOrg.id },
      );
      expect(toArchived.statusCode).toBe(400);
      expect(toArchived.json().error.details[0].message).toBe('validation.activeOrganization');
      invalidate.mockClear();
      broadcast.mockClear();
      const res = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/approve`,
        {
          expectedUpdatedAt: user.updatedAt.toISOString(),
          orgId: org.id,
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().item).toMatchObject({
        status: 'ACTIVE',
        org: { id: org.id, name: org.name },
      });
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
        status: 'ACTIVE',
        orgId: org.id,
      });
      expect(invalidate).toHaveBeenCalledWith(user.id);
      expect(scopesSent()).toEqual(['form-context']);
      const [row] = await auditRows(user.id);
      expect(row).toMatchObject({
        action: 'APPROVE',
        entity: 'User',
        before: { status: 'PENDING_APPROVAL', orgId: null },
        after: { status: 'ACTIVE', orgId: org.id },
      });
      const again = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/reject`,
        { expectedUpdatedAt: res.json().item.updatedAt },
      );
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details).toEqual({ reason: 'guard', guard: 'signup_not_pending' });
    });

    it('the client signing in or switching language while the admin reviews is not a conflict (E19)', async () => {
      const user = await pending(`Lia Login ${tag}`);
      const res = await apiAs(ctx, admin).get(
        `/admin/clients/pending-signups?search=${encodeURIComponent(`Lia Login ${tag}`)}`,
      );
      const [listed] = pendingSignupListSchema.parse(res.json()).items;
      expect(listed?.id).toBe(user.id);
      await ctx.app.services.auth.login({
        email: user.email,
        password: TEST_PASSWORD,
        audience: 'client',
      });
      await ctx.app.services.me.updateLocale(user.id, 'ar');
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.lastLoginAt).not.toBeNull();
      expect(row.locale).toBe('ar');
      expect(row.updatedAt.toISOString()).toBe(listed!.updatedAt);
      const org = await createOrg();
      const approve = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/approve`,
        { expectedUpdatedAt: listed!.updatedAt, orgId: org.id },
      );
      expect(approve.statusCode).toBe(200);
      expect(approve.json().item.status).toBe('ACTIVE');
    });

    it('a rejected sign-up is listed under status=rejected and can still be approved (the way back)', async () => {
      const user = await pending(`Rex Rejected ${tag}`);
      const rejected = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/reject`,
        { expectedUpdatedAt: user.updatedAt.toISOString() },
      );
      expect(rejected.statusCode).toBe(200);
      const { updatedAt } = rejected.json().item as { updatedAt: string };
      const list = async (query: string) => {
        const res = await apiAs(ctx, admin).get(
          `/admin/clients/pending-signups?${query}search=${encodeURIComponent(`Rex Rejected ${tag}`)}`,
        );
        expect(res.statusCode).toBe(200);
        return pendingSignupListSchema.parse(res.json()).items;
      };
      expect(await list('')).toEqual([]);
      expect(await list('status=pending&')).toEqual([]);
      const listed = await list('status=rejected&');
      expect(listed.map((i) => i.id)).toEqual([user.id]);
      expect(listed[0]).toMatchObject({ status: 'DISABLED', org: null, updatedAt });

      const again = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/reject`,
        { expectedUpdatedAt: updatedAt },
      );
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details).toEqual({ reason: 'guard', guard: 'signup_not_pending' });

      const org = await createOrg();
      invalidate.mockClear();
      const approved = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/approve`,
        { expectedUpdatedAt: updatedAt, orgId: org.id },
      );
      expect(approved.statusCode).toBe(200);
      expect(approved.json().item).toMatchObject({
        status: 'ACTIVE',
        org: { id: org.id, name: org.name },
      });
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
        status: 'ACTIVE',
        orgId: org.id,
      });
      expect(invalidate).toHaveBeenCalledWith(user.id);
      const rows = await auditRows(user.id);
      expect(rows.map((r) => r.action)).toEqual(['REJECT', 'APPROVE']);
      expect(rows[1]).toMatchObject({
        before: { status: 'DISABLED', orgId: null },
        after: { status: 'ACTIVE', orgId: org.id },
      });
      expect(await list('status=rejected&')).toEqual([]);

      // A disabled client of an organisation is not a rejected sign-up.
      const { user: member } = await ctx.fixtures.client({ status: 'DISABLED' });
      const notSignup = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${member.id}/approve`,
        { expectedUpdatedAt: member.updatedAt.toISOString(), orgId: org.id },
      );
      expect(notSignup.statusCode).toBe(409);
      expect(notSignup.json().error.details).toEqual({
        reason: 'guard',
        guard: 'signup_not_pending',
      });
    });

    it('rejects: DISABLED, sessions revoked; a stale expectedUpdatedAt is 409', async () => {
      const user = await pending(`Rob Reject ${tag}`);
      const stale = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${user.id}/reject`,
        { expectedUpdatedAt: new Date(user.updatedAt.getTime() - 1000).toISOString() },
      );
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      const res = await apiAs(ctx, admin).post(`/admin/clients/pending-signups/${user.id}/reject`, {
        expectedUpdatedAt: user.updatedAt.toISOString(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item.status).toBe('DISABLED');
      const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row).toMatchObject({ status: 'DISABLED', sessionVersion: 1, orgId: null });
      expect(revoked).toHaveBeenCalledWith(user.id);
      expect((await auditRows(user.id)).map((r) => r.action)).toEqual(['REJECT']);
      // Staff ids are not sign-ups.
      const staff = await apiAs(ctx, admin).post(
        `/admin/clients/pending-signups/${manager.id}/reject`,
        {
          expectedUpdatedAt: (
            await ctx.prisma.user.findUniqueOrThrow({ where: { id: manager.id } })
          ).updatedAt.toISOString(),
        },
      );
      expect(staff.statusCode).toBe(404);
    });
  });
});
