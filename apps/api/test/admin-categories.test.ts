import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  categoryListSchema,
  categoryResponseSchema,
  subtypeResponseSchema,
  ticketFormConfigSchema,
  type Actor,
  type CategoryAdminDto,
} from '@loons/shared';
import { createCategoriesAdminService } from '../src/services/admin/categories.ts';
import type { AdminContext } from '../src/services/admin/write.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Categories & sub-types (spec §10.1; decisions E4, E5, E6, E16, E17, E18, E19): routes ×
// roles, validation, keys, archive guards, stale 409, audit rows in the same transaction and the
// `ticket-form` scope announced after commit.

describe('admin categories', () => {
  let ctx: TestContext;
  let admin: Persona;
  let lead: Persona;
  let agent: Persona;
  let client: Persona;
  let teamA: { id: string };
  let teamB: { id: string };
  let archivedTeam: { id: string };
  const sent: Array<[string, unknown]> = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    teamA = await f.team();
    teamB = await f.team();
    archivedTeam = await f.team();
    await ctx.prisma.team.update({ where: { id: archivedTeam.id }, data: { isActive: false } });
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Cat Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD', name: 'Cat Lead' });
    await f.member(teamA.id, tl.id, 'LEAD');
    const ag = await f.staff({ staffDomain, role: 'AGENT' });
    await f.member(teamA.id, ag.id);
    admin = await persona(ctx, sa);
    lead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, (await f.client()).user);
    const broadcast = ctx.app.realtime.broadcast.bind(ctx.app.realtime);
    vi.spyOn(ctx.app.realtime, 'broadcast').mockImplementation((event, payload) => {
      sent.push([event, payload]);
      broadcast(event, payload);
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const api = () => apiAs(ctx, admin);
  const label = (prefix = 'Test Cat') => `${prefix} ${rand()}`;
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const scopesSince = (mark: number) =>
    sent
      .slice(mark)
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);

  async function field(options: { isActive?: boolean } = {}) {
    const row = await ctx.prisma.customField.create({
      data: {
        key: `tf_cat_${rand(4)}`,
        labelEn: `Field ${rand(3)}`,
        type: 'TEXT',
        isActive: options.isActive ?? true,
      },
    });
    ctx.fixtures.trackField(row.id);
    return row;
  }

  async function createCategory(
    overrides: Record<string, unknown> = {},
  ): Promise<CategoryAdminDto> {
    const res = await api().post('/admin/categories', {
      labelEn: label(),
      labelAr: 'فئة اختبار',
      teamId: teamA.id,
      firstSubtype: { labelEn: 'First kind', defaultPriority: 'P2' },
      ...overrides,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { item } = categoryResponseSchema.parse(res.json());
    ctx.fixtures.trackCategory(item.id);
    return item;
  }

  async function formConfig() {
    const res = await apiAs(ctx, client).get('/config/ticket-form');
    expect(res.statusCode).toBe(200);
    return ticketFormConfigSchema.parse(res.json());
  }

  describe('access', () => {
    it('401 anonymous; 403 for clients, agents and team leads on every route', async () => {
      const cat = await createCategory();
      const st = cat.subtypes[0]!;
      const body = { expectedUpdatedAt: cat.updatedAt };
      const calls: Array<[string, (p?: Persona) => ReturnType<ReturnType<typeof apiAs>['get']>]> = [
        ['list', (p) => apiAs(ctx, p).get('/admin/categories')],
        ['create', (p) => apiAs(ctx, p).post('/admin/categories', {})],
        ['update', (p) => apiAs(ctx, p).patch(`/admin/categories/${cat.id}`, body)],
        ['archive', (p) => apiAs(ctx, p).post(`/admin/categories/${cat.id}/archive`, body)],
        ['restore', (p) => apiAs(ctx, p).post(`/admin/categories/${cat.id}/restore`, body)],
        ['reorder', (p) => apiAs(ctx, p).post('/admin/categories/reorder', {})],
        ['fields', (p) => apiAs(ctx, p).put(`/admin/categories/${cat.id}/fields`, body)],
        ['subtype+', (p) => apiAs(ctx, p).post(`/admin/categories/${cat.id}/subtypes`, {})],
        [
          'subtype',
          (p) => apiAs(ctx, p).patch(`/admin/categories/${cat.id}/subtypes/${st.id}`, body),
        ],
        [
          'subtype archive',
          (p) => apiAs(ctx, p).post(`/admin/categories/${cat.id}/subtypes/${st.id}/archive`, body),
        ],
        [
          'subtype reorder',
          (p) => apiAs(ctx, p).post(`/admin/categories/${cat.id}/subtypes/reorder`, {}),
        ],
      ];
      for (const [name, call] of calls) {
        expect((await call(undefined)).statusCode, `anonymous ${name}`).toBe(401);
        for (const [who, p] of [
          ['client', client],
          ['agent', agent],
          ['team lead', lead],
        ] as const) {
          expect((await call(p)).statusCode, `${who} ${name}`).toBe(403);
        }
      }
      // Nothing changed.
      const [row] = await ctx.prisma.category.findMany({ where: { id: cat.id } });
      expect(row?.updatedAt.toISOString()).toBe(cat.updatedAt);
    });
  });

  describe('create (E4, E5)', () => {
    it('creates a category with its first sub-type and linked fields, audits and announces it', async () => {
      const [f1, f2] = [await field(), await field()];
      const mark = sent.length;
      const labelEn = label('Test Door Access');
      const cat = await createCategory({
        labelEn,
        icon: 'cctv',
        assetPlaceholder: 'e.g. CAM-014',
        assetPlaceholderAr: 'مثال: CAM-014',
        fieldIds: [f2.id, f1.id],
      });
      expect(cat.key).toBe(labelEn.toLowerCase().replaceAll(' ', '-'));
      expect(cat).toMatchObject({
        labelAr: 'فئة اختبار',
        icon: 'cctv',
        assetPlaceholderAr: 'مثال: CAM-014',
        team: { id: teamA.id, isActive: true },
        isActive: true,
        isSecurityCategory: false,
        hiddenReason: null,
      });
      expect(cat.subtypes).toHaveLength(1);
      expect(cat.subtypes[0]).toMatchObject({
        key: 'first-kind',
        defaultPriority: 'P2',
        isActive: true,
        sortOrder: 0,
      });
      expect(cat.fields.map((l) => [l.fieldId, l.sortOrder])).toEqual([
        [f2.id, 0],
        [f1.id, 1],
      ]);
      // Appended after every other category.
      const max = await ctx.prisma.category.aggregate({ _max: { sortOrder: true } });
      expect(cat.sortOrder).toBe(max._max.sortOrder);

      const rows = await auditRows(cat.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'CREATE',
        entity: 'Category',
        entityLabel: labelEn,
        actorId: admin.id,
        before: null,
        after: expect.objectContaining({
          key: cat.key,
          teamId: teamA.id,
          fieldIds: [f2.id, f1.id],
        }),
      });
      expect(rows[0]?.requestId).toBeTruthy();
      expect(await auditRows(cat.subtypes[0]!.id)).toMatchObject([
        { action: 'CREATE', entity: 'Subtype', requestId: rows[0]?.requestId },
      ]);
      expect(scopesSince(mark)).toEqual(['ticket-form']);

      // On the New Ticket form right away (the writer bumped the config version).
      const config = await formConfig();
      const onForm = config.categories.find((c) => c.id === cat.id);
      expect(onForm?.subtypes.map((s) => s.id)).toEqual([cat.subtypes[0]!.id]);
      expect(onForm?.fields.map((x) => x.id)).toEqual([f2.id, f1.id]);
      expect(onForm?.assetPlaceholderAr).toBe('مثال: CAM-014');
    });

    it('generated keys get a suffix on a collision, archived rows included', async () => {
      const labelEn = label('Test Same Name');
      const first = await createCategory({ labelEn });
      await api().post(`/admin/categories/${first.id}/archive`, {
        expectedUpdatedAt: first.updatedAt,
      });
      const second = await createCategory({ labelEn });
      expect(second.key).toBe(`${first.key}-2`);
    });

    it('refuses an explicit key that is taken (archived included) with 409 duplicate', async () => {
      const first = await createCategory({ key: `test-${rand()}` });
      await api().post(`/admin/categories/${first.id}/archive`, {
        expectedUpdatedAt: first.updatedAt,
      });
      const res = await api().post('/admin/categories', {
        key: first.key,
        labelEn: label(),
        teamId: teamA.id,
        firstSubtype: { labelEn: 'x' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toMatchObject({
        reason: 'duplicate',
        fields: ['key'],
        existingId: first.id,
        existingIsActive: false,
      });
    });

    it('validation: first sub-type required, active team, known icon, key format, active fields', async () => {
      const archivedField = await field({ isActive: false });
      const labelEn = label();
      // Whatever a broken rule lets through is removed even if the test stops early.
      ctx.fixtures.onCleanup(async () => {
        const leaked = await ctx.prisma.category.findMany({
          where: { labelEn },
          select: { id: true },
        });
        const ids = leaked.map((row) => row.id);
        await ctx.prisma.adminAuditLog.deleteMany({ where: { entityId: { in: ids } } });
        await ctx.prisma.subtype.deleteMany({ where: { categoryId: { in: ids } } });
        await ctx.prisma.category.deleteMany({ where: { id: { in: ids } } });
      });
      const base = { labelEn, teamId: teamA.id, firstSubtype: { labelEn: 'x' } };
      const mark = sent.length;
      const cases: Array<[Record<string, unknown>, string, string]> = [
        [{ ...base, firstSubtype: undefined }, 'firstSubtype', ''],
        [{ ...base, teamId: archivedTeam.id }, 'teamId', 'validation.teamArchived'],
        [{ ...base, teamId: crypto.randomUUID() }, 'teamId', 'validation.notFound'],
        [{ ...base, icon: 'not-an-icon' }, 'icon', ''],
        [{ ...base, key: 'Bad Key!' }, 'key', 'validation.keyFormat'],
        [{ ...base, labelEn: '' }, 'labelEn', 'validation.required'],
        [{ ...base, fieldIds: [archivedField.id] }, 'fieldIds', 'validation.fieldArchived'],
      ];
      for (const [body, path, message] of cases) {
        const res = await api().post('/admin/categories', body);
        expect(res.statusCode, `${path} ${res.body}`).toBe(400);
        const issues = res.json().error.details as Array<{ path: unknown[]; message: string }>;
        const found = issues.find((i) => i.path[0] === path);
        expect(found, path).toBeDefined();
        if (message) expect(found?.message).toBe(message);
      }
      expect(await ctx.prisma.category.count({ where: { labelEn } })).toBe(0);
      expect(scopesSince(mark)).toEqual([]);
    });

    it('a failed audit insert rolls the whole create back (same transaction, E17)', async () => {
      const service = createCategoriesAdminService({
        prisma: ctx.prisma,
        writer: ctx.app.services.admin.writer,
      });
      const ghost: AdminContext = {
        actor: {
          id: crypto.randomUUID(),
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          orgId: null,
          teamIds: [],
          leadTeamIds: [],
          emailVerified: true,
        } satisfies Actor,
        requestId: `req-${rand()}`,
      };
      const key = `test-${rand()}`;
      const mark = sent.length;
      await expect(
        service.create(ghost, {
          key,
          labelEn: 'Ghost',
          labelAr: '',
          icon: 'cctv',
          assetPlaceholder: null,
          assetPlaceholderAr: null,
          teamId: teamA.id,
          firstSubtype: { labelEn: 'x', labelAr: '', defaultPriority: 'P3' },
          fieldIds: [],
          skillIds: [],
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect(await ctx.prisma.category.count({ where: { key } })).toBe(0);
      expect(scopesSince(mark)).toEqual([]);
    });
  });

  describe('update (E4, E19)', () => {
    it('updates labels, team and placeholders; the key never changes; audits the changed fields only', async () => {
      const cat = await createCategory();
      const mark = sent.length;
      const res = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: cat.updatedAt,
        key: 'something-else',
        labelAr: 'اسم جديد',
        teamId: teamB.id,
        assetPlaceholder: 'e.g. X-1',
      });
      expect(res.statusCode, res.body).toBe(200);
      const { item } = categoryResponseSchema.parse(res.json());
      expect(item).toMatchObject({
        key: cat.key,
        labelAr: 'اسم جديد',
        labelEn: cat.labelEn,
        team: { id: teamB.id },
        assetPlaceholder: 'e.g. X-1',
      });
      expect(item.updatedAt).not.toBe(cat.updatedAt);
      const update = (await auditRows(cat.id)).find((r) => r.action === 'UPDATE');
      expect(update?.before).toEqual({
        labelAr: 'فئة اختبار',
        teamId: teamA.id,
        assetPlaceholder: null,
      });
      expect(update?.after).toEqual({
        labelAr: 'اسم جديد',
        teamId: teamB.id,
        assetPlaceholder: 'e.g. X-1',
      });
      expect(scopesSince(mark)).toEqual(['ticket-form']);
      // '' clears it again.
      const cleared = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: item.updatedAt,
        assetPlaceholder: '',
      });
      expect(cleared.json().item.assetPlaceholder).toBeNull();
    });

    it('409 stale when someone saved first; nothing written, nothing announced', async () => {
      const cat = await createCategory();
      const first = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: cat.updatedAt,
        labelEn: `${cat.labelEn} v2`,
      });
      expect(first.statusCode).toBe(200);
      const mark = sent.length;
      const stale = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: cat.updatedAt,
        labelEn: `${cat.labelEn} v3`,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details).toMatchObject({
        reason: 'stale',
        currentUpdatedAt: first.json().item.updatedAt,
      });
      expect((await ctx.prisma.category.findUniqueOrThrow({ where: { id: cat.id } })).labelEn).toBe(
        `${cat.labelEn} v2`,
      );
      expect((await auditRows(cat.id)).filter((r) => r.action === 'UPDATE')).toHaveLength(1);
      expect(scopesSince(mark)).toEqual([]);
    });

    it('400 for an archived team or an empty change; 404 for an unknown category', async () => {
      const cat = await createCategory();
      const archived = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: cat.updatedAt,
        teamId: archivedTeam.id,
      });
      expect(archived.statusCode).toBe(400);
      expect(archived.json().error.details[0]).toMatchObject({
        path: ['teamId'],
        message: 'validation.teamArchived',
      });
      const empty = await api().patch(`/admin/categories/${cat.id}`, {
        expectedUpdatedAt: cat.updatedAt,
      });
      expect(empty.statusCode).toBe(400);
      expect(JSON.stringify(empty.json())).toContain('validation.nothingToChange');
      const missing = await api().patch(`/admin/categories/${crypto.randomUUID()}`, {
        expectedUpdatedAt: cat.updatedAt,
        labelEn: 'x',
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('archive / restore (E5, E6)', () => {
    it('archives out of the form and the active list, restores it back; audited', async () => {
      const cat = await createCategory();
      const archived = await api().post(`/admin/categories/${cat.id}/archive`, {
        expectedUpdatedAt: cat.updatedAt,
      });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().item).toMatchObject({ isActive: false, hiddenReason: 'archived' });
      expect((await formConfig()).categories.some((c) => c.id === cat.id)).toBe(false);

      const list = async (status: string) =>
        categoryListSchema
          .parse((await api().get(`/admin/categories?status=${status}`)).json())
          .items.map((c) => c.id);
      expect(await list('active')).not.toContain(cat.id);
      expect(await list('archived')).toContain(cat.id);
      expect(await list('all')).toContain(cat.id);

      const restored = await api().post(`/admin/categories/${cat.id}/restore`, {
        expectedUpdatedAt: archived.json().item.updatedAt,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().item).toMatchObject({ isActive: true, hiddenReason: null });
      expect((await formConfig()).categories.some((c) => c.id === cat.id)).toBe(true);
      expect((await auditRows(cat.id)).map((r) => r.action)).toEqual([
        'CREATE',
        'ARCHIVE',
        'RESTORE',
      ]);
    });

    it('can’t restore a category routed to an archived team (409 guard)', async () => {
      const team = await ctx.fixtures.team();
      const { category } = await ctx.fixtures.category({ teamId: team.id, isActive: false });
      await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
      const res = await api().post(`/admin/categories/${category.id}/restore`, {
        expectedUpdatedAt: category.updatedAt.toISOString(),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({
        reason: 'guard',
        guard: 'category_team_archived',
      });
    });

    it('lists why an active category is not on the form (no active sub-type, archived team)', async () => {
      const cat = await createCategory();
      const st = cat.subtypes[0]!;
      const res = await api().post(`/admin/categories/${cat.id}/subtypes/${st.id}/archive`, {
        expectedUpdatedAt: st.updatedAt,
      });
      expect(res.statusCode).toBe(200);
      const items = categoryListSchema.parse((await api().get('/admin/categories')).json()).items;
      expect(items.find((c) => c.id === cat.id)?.hiddenReason).toBe('no_active_subtype');
      expect((await formConfig()).categories.some((c) => c.id === cat.id)).toBe(false);

      const team = await ctx.fixtures.team();
      const { category } = await ctx.fixtures.category({ teamId: team.id });
      await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
      const again = categoryListSchema.parse((await api().get('/admin/categories')).json()).items;
      expect(again.find((c) => c.id === category.id)).toMatchObject({
        hiddenReason: 'team_archived',
        team: { id: team.id, isActive: false },
      });
    });

    it('the security category and its last active sub-type can’t be archived (E5)', async () => {
      const cat = await createCategory({ firstSubtype: { labelEn: 'Only kind' } });
      const service = createCategoriesAdminService(
        { prisma: ctx.prisma, writer: ctx.app.services.admin.writer },
        { securityCategoryKey: async () => cat.key },
      );
      const sa: AdminContext = {
        actor: {
          id: admin.id,
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          orgId: null,
          teamIds: [],
          leadTeamIds: [],
          emailVerified: true,
        },
        requestId: `req-${rand()}`,
      };
      await expect(
        service.archive(sa, cat.id, { expectedUpdatedAt: cat.updatedAt }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { reason: 'guard', guard: 'security_category' },
      });
      const only = cat.subtypes[0]!;
      await expect(
        service.archiveSubtype(sa, cat.id, only.id, { expectedUpdatedAt: only.updatedAt }),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { reason: 'guard', guard: 'security_category_last_subtype' },
      });
      // With a second active sub-type the first one may go.
      const second = await service.createSubtype(sa, cat.id, {
        labelEn: 'Second kind',
        labelAr: '',
        defaultPriority: 'P1',
      });
      const archived = await service.archiveSubtype(sa, cat.id, only.id, {
        expectedUpdatedAt: only.updatedAt,
      });
      expect(archived.isActive).toBe(false);
      await expect(
        service.archiveSubtype(sa, cat.id, second.id, { expectedUpdatedAt: second.updatedAt }),
      ).rejects.toMatchObject({ details: { guard: 'security_category_last_subtype' } });
      const listed = await service.list(sa, { status: 'all' });
      expect(listed.find((c) => c.id === cat.id)?.isSecurityCategory).toBe(true);
      // Nothing about the refused archives reached the audit log.
      expect((await auditRows(cat.id)).map((r) => r.action)).toEqual(['CREATE']);
    });

    it('the default security key is the AppSetting the form config uses', async () => {
      const { securityCategoryKey } = await import('../src/services/admin/categories.ts');
      expect(await securityCategoryKey(ctx.prisma)).toBe((await formConfig()).securityCategoryKey);
    });
  });

  describe('sub-types', () => {
    it('creates (key unique within the category), updates, archives, restores and reorders', async () => {
      const cat = await createCategory();
      const add = async (body: Record<string, unknown>) =>
        api().post(`/admin/categories/${cat.id}/subtypes`, body);
      const b = subtypeResponseSchema.parse((await add({ labelEn: 'First kind' })).json()).item;
      expect(b.key).toBe('first-kind-2'); // "first-kind" is the first sub-type's key
      expect(b.sortOrder).toBe(1);
      const dup = await add({ key: 'first-kind', labelEn: 'Dup' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.details).toMatchObject({ reason: 'duplicate', fields: ['key'] });
      const c = subtypeResponseSchema.parse(
        (await add({ labelEn: 'Third', labelAr: 'ثالث', defaultPriority: 'P4' })).json(),
      ).item;

      const upd = await api().patch(`/admin/categories/${cat.id}/subtypes/${b.id}`, {
        expectedUpdatedAt: b.updatedAt,
        defaultPriority: 'P1',
      });
      expect(upd.statusCode).toBe(200);
      expect(upd.json().item).toMatchObject({ defaultPriority: 'P1', key: b.key });

      // A sub-type is addressed through its own category only.
      const other = await createCategory();
      const wrong = await api().patch(`/admin/categories/${other.id}/subtypes/${b.id}`, {
        expectedUpdatedAt: upd.json().item.updatedAt,
        labelEn: 'x',
      });
      expect(wrong.statusCode).toBe(404);

      const a = cat.subtypes[0]!;
      const mark = sent.length;
      const reorder = await api().post(`/admin/categories/${cat.id}/subtypes/reorder`, {
        expectedIds: [a.id, b.id, c.id],
        ids: [c.id, a.id, b.id],
      });
      expect(reorder.statusCode, reorder.body).toBe(204);
      expect(scopesSince(mark)).toEqual(['ticket-form']);
      const config = await formConfig();
      expect(config.categories.find((x) => x.id === cat.id)?.subtypes.map((s) => s.id)).toEqual([
        c.id,
        a.id,
        b.id,
      ]);
      const moved = await api().post(`/admin/categories/${cat.id}/subtypes/reorder`, {
        expectedIds: [a.id, b.id, c.id],
        ids: [b.id, a.id, c.id],
      });
      expect(moved.statusCode).toBe(409);
      expect(moved.json().error.details).toEqual({ reason: 'order_changed' });
      const reorders = (await auditRows(cat.id)).filter((r) => r.action === 'REORDER');
      expect(reorders).toMatchObject([
        {
          entity: 'Subtype',
          before: { order: [a.id, b.id, c.id] },
          after: { order: [c.id, a.id, b.id] },
        },
      ]);

      const archived = await api().post(`/admin/categories/${cat.id}/subtypes/${c.id}/archive`, {
        expectedUpdatedAt: c.updatedAt,
      });
      expect(archived.json().item.isActive).toBe(false);
      const restored = await api().post(`/admin/categories/${cat.id}/subtypes/${c.id}/restore`, {
        expectedUpdatedAt: archived.json().item.updatedAt,
      });
      expect(restored.json().item.isActive).toBe(true);
      expect((await auditRows(c.id)).map((r) => r.action)).toEqual([
        'CREATE',
        'ARCHIVE',
        'RESTORE',
      ]);
    });
  });

  describe('linked fields (PUT /:id/fields)', () => {
    it('links, orders and unlinks fields; audits each link; stale guard on the category', async () => {
      const [f1, f2, f3] = [await field(), await field(), await field()];
      const cat = await createCategory({ fieldIds: [f1.id, f2.id] });
      const put = (expectedUpdatedAt: string, fieldIds: string[]) =>
        api().put(`/admin/categories/${cat.id}/fields`, { expectedUpdatedAt, fieldIds });

      const res = await put(cat.updatedAt, [f3.id, f2.id]);
      expect(res.statusCode, res.body).toBe(200);
      const { item } = categoryResponseSchema.parse(res.json());
      expect(item.fields.map((l) => [l.fieldId, l.sortOrder])).toEqual([
        [f3.id, 0],
        [f2.id, 1],
      ]);
      expect(item.updatedAt).not.toBe(cat.updatedAt);
      const config = await formConfig();
      expect(config.categories.find((c) => c.id === cat.id)?.fields.map((x) => x.id)).toEqual([
        f3.id,
        f2.id,
      ]);
      const rows = await ctx.prisma.adminAuditLog.findMany({
        where: { entity: 'CategoryField', actorId: admin.id, entityId: { startsWith: cat.id } },
      });
      expect(rows.map((r) => [r.action, r.entityId]).sort()).toEqual(
        [
          ['CREATE', `${cat.id}:${f3.id}`],
          ['DELETE', `${cat.id}:${f1.id}`],
        ].sort(),
      );

      // The old updatedAt is stale now.
      const stale = await put(cat.updatedAt, [f2.id]);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');

      // An archived field stays linked, but can't be newly linked.
      await ctx.prisma.customField.update({ where: { id: f2.id }, data: { isActive: false } });
      await ctx.prisma.customField.update({ where: { id: f1.id }, data: { isActive: false } });
      const kept = await put(item.updatedAt, [f2.id, f3.id]);
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.json().item.fields.map((l: { isActive: boolean }) => l.isActive)).toEqual([
        false,
        true,
      ]);
      const reorder = (await auditRows(cat.id)).find((r) => r.entity === 'CategoryField');
      expect(reorder).toMatchObject({
        action: 'REORDER',
        before: { order: [f3.id, f2.id] },
        after: { order: [f2.id, f3.id] },
        entityLabel: cat.labelEn, // E17; review contract-5
      });
      const refused = await put(kept.json().item.updatedAt, [f2.id, f3.id, f1.id]);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.details[0]).toMatchObject({
        path: ['fieldIds', 2],
        message: 'validation.fieldArchived',
      });
      const duplicate = await put(kept.json().item.updatedAt, [f3.id, f3.id]);
      expect(duplicate.statusCode).toBe(400);
    });
  });

  describe('reorder categories (E3)', () => {
    it('writes the new order in one request; 409 when the list moved meanwhile', async () => {
      const a = await createCategory();
      const b = await createCategory();
      // Other rows keep their positions afterwards (the dev database's own categories).
      const snapshot = await ctx.prisma.category.findMany({
        select: { id: true, sortOrder: true },
      });
      ctx.fixtures.onCleanup(async () => {
        for (const row of snapshot) {
          await ctx.prisma.category.updateMany({
            where: { id: row.id },
            data: { sortOrder: row.sortOrder },
          });
        }
      });
      const activeIds = async () =>
        categoryListSchema
          .parse((await api().get('/admin/categories')).json())
          .items.map((c) => c.id);

      // Other test files may add categories at the same time: retry on order_changed.
      let res;
      let expectedIds: string[] = [];
      let ids: string[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        expectedIds = await activeIds();
        ids = [b.id, a.id, ...expectedIds.filter((id) => id !== a.id && id !== b.id)];
        res = await api().post('/admin/categories/reorder', { expectedIds, ids });
        if (res.statusCode !== 409) break;
      }
      expect(res?.statusCode, res?.body).toBe(204);
      const after = await activeIds();
      expect(after.indexOf(b.id)).toBeLessThan(after.indexOf(a.id));
      expect((await formConfig()).categories.findIndex((c) => c.id === b.id)).toBeLessThan(
        (await formConfig()).categories.findIndex((c) => c.id === a.id),
      );
      // Audited with a label (E17; review contract-5).
      expect(
        await ctx.prisma.adminAuditLog.findFirst({
          where: { entity: 'Category', action: 'REORDER', actorId: admin.id },
          orderBy: { createdAt: 'desc' },
        }),
      ).toMatchObject({ entityId: 'categories', entityLabel: 'Categories' });
      // updatedAt untouched: an open edit sheet still saves.
      const aRow = await ctx.prisma.category.findUniqueOrThrow({ where: { id: a.id } });
      expect(aRow.updatedAt.toISOString()).toBe(a.updatedAt);
      const stale = await api().post('/admin/categories/reorder', {
        expectedIds,
        ids: expectedIds,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('order_changed');
      const mismatch = await api().post('/admin/categories/reorder', {
        expectedIds: [a.id, b.id],
        ids: [a.id],
      });
      expect(mismatch.statusCode).toBe(400);
    });
  });

  it('OpenAPI documents the category routes under the admin tag', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    expect(
      doc.paths['/admin/categories/']?.post?.tags ?? doc.paths['/admin/categories']?.post?.tags,
    ).toEqual(['admin']);
    expect(doc.paths['/admin/categories/{id}/subtypes/{subtypeId}']?.patch).toBeDefined();
  });
});
