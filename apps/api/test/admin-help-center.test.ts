import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  helpArticleListSchema,
  helpArticleResponseSchema,
  type Actor,
  type HelpArticleAdminDto,
} from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Help center (decision E15): articles in English and Arabic, drafts and published ones,
// archive / restore, keys generated from the English title (E4), reorder with the expected order
// (E3), `expectedUpdatedAt` (E19), audit rows in the same transaction (E17) and
// `config:updated {scope: 'help-center'}` after commit (E18). Super admins only.
//
// The help center is one global list, so the tests' articles sit next to the dev database's
// (seeded) ones: every article created here has a `test-` key and is deleted in cleanup, and the
// `sortOrder` of the other articles is put back as it was.

const BASE = '/admin/help-center';

describe('admin help center', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  const created = new Set<string>();

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const team = await f.team();
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    const ag = await f.staff({ staffDomain, role: 'AGENT' });
    await f.member(team.id, tl.id, 'LEAD');
    const { user: cl } = await f.client();
    superAdmin = await persona(ctx, sa);
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, cl);

    const order = await ctx.prisma.helpArticle.findMany({ select: { id: true, sortOrder: true } });
    f.onCleanup(async () => {
      const ids = [...created];
      await ctx.prisma.adminAuditLog.deleteMany({
        where: { OR: [{ entityId: { in: ids } }, { actorId: superAdmin.id }] },
      });
      await ctx.prisma.helpArticle.deleteMany({
        where: { OR: [{ id: { in: ids } }, { key: { startsWith: 'test-' } }] },
      });
      for (const row of order) {
        await ctx.prisma.$executeRaw`
          UPDATE "HelpArticle" SET "sortOrder" = ${row.sortOrder} WHERE "id" = ${row.id}::uuid`;
      }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const sa = () => apiAs(ctx, superAdmin);
  const title = (label = 'article') => `Test ${label} ${rand()}`;

  async function create(body: Record<string, unknown> = {}): Promise<HelpArticleAdminDto> {
    const res = await sa().post(BASE, { titleEn: title(), bodyEn: 'How to do it.', ...body });
    expect(res.statusCode, res.body).toBe(201);
    const { item } = helpArticleResponseSchema.parse(res.json());
    created.add(item.id);
    return item;
  }
  const list = async (query = '') =>
    helpArticleListSchema.parse((await sa().get(`${BASE}${query}`)).json()).items;
  const activeIds = async () => (await list()).map((a) => a.id);
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const configEvents = () => {
    const spy = vi.spyOn(ctx.app.realtime, 'broadcast');
    return () =>
      spy.mock.calls
        .filter(([event]) => event === 'config:updated')
        .map(([, payload]) => (payload as { scope: string }).scope);
  };

  describe('access (super admins only)', () => {
    it('401 without a token, 403 for clients, agents and team leads on every route', async () => {
      const id = crypto.randomUUID();
      const routes: Array<[string, string]> = [
        ['GET', BASE],
        ['POST', BASE],
        ['POST', `${BASE}/reorder`],
        ['PATCH', `${BASE}/${id}`],
        ['POST', `${BASE}/${id}/archive`],
        ['POST', `${BASE}/${id}/restore`],
      ];
      for (const [method, url] of routes) {
        const call = (api: ReturnType<typeof apiAs>) =>
          method === 'GET' ? api.get(url) : method === 'PATCH' ? api.patch(url) : api.post(url);
        expect((await call(apiAs(ctx))).statusCode, `${method} ${url}`).toBe(401);
        for (const who of [client, agent, teamLead]) {
          expect((await call(apiAs(ctx, who))).statusCode, `${who.role} ${method} ${url}`).toBe(
            403,
          );
        }
      }
    });

    it('the service refuses a team lead even when called directly', async () => {
      const lead: Actor = {
        id: teamLead.id,
        role: 'TEAM_LEAD',
        status: 'ACTIVE',
        orgId: null,
        teamIds: [],
        leadTeamIds: [],
        emailVerified: true,
      };
      await expect(
        ctx.app.services.admin.helpCenter.list(
          { actor: lead, requestId: 'r' },
          { status: 'active' },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('create', () => {
    it('creates a draft at the end of the list with a key from the English title, audited and announced', async () => {
      const events = configEvents();
      const before = await list();
      const t = title('Resetting a camera');
      const item = await create({ titleEn: t, titleAr: 'إعادة ضبط الكاميرا', bodyAr: 'الخطوات.' });
      expect(item).toMatchObject({
        key: t.toLowerCase().replaceAll(' ', '-'),
        titleEn: t,
        titleAr: 'إعادة ضبط الكاميرا',
        isPublished: false,
        isActive: true,
      });
      const after = await list();
      expect(after.at(-1)?.id).toBe(item.id);
      expect(item.sortOrder).toBeGreaterThan(Math.max(-1, ...before.map((a) => a.sortOrder)));
      const [audit, ...more] = await auditRows(item.id);
      expect(more).toEqual([]);
      expect(audit).toMatchObject({
        action: 'CREATE',
        entity: 'HelpArticle',
        entityLabel: t,
        actorId: superAdmin.id,
        before: null,
        after: { key: item.key, titleEn: t, isPublished: false, isActive: true },
      });
      expect(events()).toEqual(['help-center']);
    });

    it('adds -2 on a key collision, archived articles included (E4)', async () => {
      const t = title('Same title');
      const first = await create({ titleEn: t });
      await sa().post(`${BASE}/${first.id}/archive`, { expectedUpdatedAt: first.updatedAt });
      const second = await create({ titleEn: t });
      expect(second.key).toBe(`${first.key}-2`);
    });

    it('409 duplicate for a key that is taken, 400 for a malformed key or a missing English title', async () => {
      const first = await create();
      const dup = await sa().post(BASE, { titleEn: title(), bodyEn: 'x', key: first.key });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.details).toEqual({
        reason: 'duplicate',
        fields: ['key'],
        existingId: first.id,
        existingIsActive: true,
      });
      const bad = await sa().post(BASE, { titleEn: title(), bodyEn: 'x', key: 'Bad Key!' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.details[0]).toMatchObject({
        path: ['key'],
        message: 'validation.keyFormat',
      });
      const noTitle = await sa().post(BASE, { titleEn: '  ', titleAr: 'عنوان', bodyEn: 'x' });
      expect(noTitle.statusCode).toBe(400);
      expect(noTitle.json().error.details[0]).toMatchObject({
        path: ['titleEn'],
        message: 'validation.required',
      });
      const noBody = await sa().post(BASE, { titleEn: title(), bodyEn: '' });
      expect(noBody.statusCode).toBe(400);
    });

    it('an explicit key is kept; a published article can be created straight away', async () => {
      const key = `test-${rand()}`;
      const item = await create({ key, isPublished: true });
      expect(item).toMatchObject({ key, isPublished: true });
    });

    it('a failed audit insert undoes the create (same transaction)', async () => {
      const ghost: Actor = {
        id: crypto.randomUUID(), // no such user: the audit row's actor foreign key fails
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        orgId: null,
        teamIds: [],
        leadTeamIds: [],
        emailVerified: true,
      };
      const key = `test-${rand()}`;
      const events = configEvents();
      await expect(
        ctx.app.services.admin.helpCenter.create(
          { actor: ghost, requestId: 'r' },
          { key, titleEn: 'Ghost', titleAr: '', bodyEn: 'x', bodyAr: '', isPublished: false },
        ),
      ).rejects.toBeTruthy();
      expect(await ctx.prisma.helpArticle.findUnique({ where: { key } })).toBeNull();
      expect(events()).toEqual([]);
    });
  });

  describe('update', () => {
    it('edits the text and publishes, auditing only the changed fields', async () => {
      const item = await create();
      const events = configEvents();
      const res = await sa().patch(`${BASE}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        bodyAr: 'النص العربي.',
        isPublished: true,
      });
      expect(res.statusCode).toBe(200);
      const updated = helpArticleResponseSchema.parse(res.json()).item;
      expect(updated).toMatchObject({ bodyAr: 'النص العربي.', isPublished: true, key: item.key });
      const audit = (await auditRows(item.id)).at(-1);
      expect(audit).toMatchObject({
        action: 'UPDATE',
        before: { bodyAr: '', isPublished: false },
        after: { bodyAr: 'النص العربي.', isPublished: true },
      });
      expect(Object.keys(audit!.after as object).sort()).toEqual(['bodyAr', 'isPublished']);
      expect(events()).toEqual(['help-center']);

      // Unpublish.
      const back = await sa().patch(`${BASE}/${item.id}`, {
        expectedUpdatedAt: updated.updatedAt,
        isPublished: false,
      });
      expect(helpArticleResponseSchema.parse(back.json()).item.isPublished).toBe(false);
    });

    it('409 stale for an old expectedUpdatedAt; 404 for an unknown article', async () => {
      const item = await create();
      const first = await sa().patch(`${BASE}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        titleAr: 'أول',
      });
      expect(first.statusCode).toBe(200);
      const second = await sa().patch(`${BASE}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        titleAr: 'ثاني',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.details).toMatchObject({
        reason: 'stale',
        currentUpdatedAt: helpArticleResponseSchema.parse(first.json()).item.updatedAt,
      });
      const missing = await sa().patch(`${BASE}/${crypto.randomUUID()}`, {
        expectedUpdatedAt: item.updatedAt,
        titleAr: 'x',
      });
      expect(missing.statusCode).toBe(404);
    });

    it('400 when nothing is sent; an unchanged value writes nothing', async () => {
      const item = await create();
      const nothing = await sa().patch(`${BASE}/${item.id}`, { expectedUpdatedAt: item.updatedAt });
      expect(nothing.statusCode).toBe(400);
      expect(nothing.json().error.details[0].message).toBe('validation.nothingToChange');
      const events = configEvents();
      const same = await sa().patch(`${BASE}/${item.id}`, {
        expectedUpdatedAt: item.updatedAt,
        titleEn: item.titleEn,
      });
      expect(same.statusCode).toBe(200);
      expect(helpArticleResponseSchema.parse(same.json()).item.updatedAt).toBe(item.updatedAt);
      expect(await auditRows(item.id)).toHaveLength(1); // the CREATE only
      expect(events()).toEqual([]);
    });
  });

  describe('archive / restore', () => {
    it('archives out of the active list and restores to the end, both audited', async () => {
      const a = await create();
      const b = await create();
      const events = configEvents();
      const archived = await sa().post(`${BASE}/${a.id}/archive`, {
        expectedUpdatedAt: a.updatedAt,
      });
      expect(archived.statusCode).toBe(200);
      const aArchived = helpArticleResponseSchema.parse(archived.json()).item;
      expect(aArchived.isActive).toBe(false);
      expect(await activeIds()).not.toContain(a.id);
      expect((await list('?status=archived')).map((x) => x.id)).toContain(a.id);
      const all = await list('?status=all');
      expect(all.map((x) => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));
      // Archived ones come after the active ones.
      expect(all.findIndex((x) => x.id === a.id)).toBeGreaterThan(
        all.findIndex((x) => x.id === b.id),
      );

      const restored = await sa().post(`${BASE}/${a.id}/restore`, {
        expectedUpdatedAt: aArchived.updatedAt,
      });
      expect(restored.statusCode).toBe(200);
      expect((await activeIds()).at(-1)).toBe(a.id);
      expect((await auditRows(a.id)).map((r) => [r.action, r.before, r.after])).toEqual([
        ['CREATE', null, expect.anything()],
        ['ARCHIVE', { isActive: true }, { isActive: false }],
        ['RESTORE', { isActive: false }, { isActive: true }],
      ]);
      expect(events()).toEqual(['help-center', 'help-center']);
    });

    it('409 stale for an old expectedUpdatedAt', async () => {
      const a = await create();
      await sa().patch(`${BASE}/${a.id}`, { expectedUpdatedAt: a.updatedAt, titleAr: 'x' });
      const res = await sa().post(`${BASE}/${a.id}/archive`, { expectedUpdatedAt: a.updatedAt });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('stale');
    });
  });

  describe('reorder', () => {
    it('writes the new order in one request, audited with the keys, updatedAt untouched', async () => {
      const a = await create();
      const b = await create();
      const expectedIds = await activeIds();
      const ids = [...expectedIds.filter((id) => id !== b.id && id !== a.id), b.id, a.id];
      const events = configEvents();
      const res = await sa().post(`${BASE}/reorder`, { expectedIds, ids });
      expect(res.statusCode).toBe(204);
      const after = await list();
      expect(after.map((x) => x.id)).toEqual(ids);
      expect(after.find((x) => x.id === a.id)?.updatedAt).toBe(a.updatedAt);
      const audit = await ctx.prisma.adminAuditLog.findFirst({
        where: { entityId: 'help-center', actorId: superAdmin.id, action: 'REORDER' },
        orderBy: { createdAt: 'desc' },
      });
      const keyOf = new Map(after.map((x) => [x.id, x.key]));
      expect(audit).toMatchObject({
        entity: 'HelpArticle',
        before: { order: expectedIds.map((id) => keyOf.get(id)) },
        after: { order: ids.map((id) => keyOf.get(id)) },
      });
      expect(events()).toEqual(['help-center']);
    });

    it('409 order_changed when the list changed meanwhile; 400 for a list that is not a permutation', async () => {
      const a = await create();
      const stale = await activeIds();
      await create(); // someone added an article since
      const res = await sa().post(`${BASE}/reorder`, {
        expectedIds: stale,
        ids: [a.id, ...stale.filter((id) => id !== a.id)],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toEqual({ reason: 'order_changed' });

      const current = await activeIds();
      const mismatch = await sa().post(`${BASE}/reorder`, {
        expectedIds: current,
        ids: current.slice(1),
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json().error.details[0].message).toBe('validation.reorderMismatch');
    });

    it('the same order again changes nothing and announces nothing', async () => {
      await create();
      const ids = await activeIds();
      const events = configEvents();
      const res = await sa().post(`${BASE}/reorder`, { expectedIds: ids, ids });
      expect(res.statusCode).toBe(204);
      expect(events()).toEqual([]);
    });
  });

  it('lists with search (key or title) and status', async () => {
    const tag = rand();
    const item = await create({ titleEn: `Test searchable ${tag}`, titleAr: `بحث ${tag}` });
    expect((await list(`?search=searchable%20${tag}`)).map((x) => x.id)).toEqual([item.id]);
    expect((await list(`?search=${encodeURIComponent(`بحث ${tag}`)}`)).map((x) => x.id)).toEqual([
      item.id,
    ]);
    expect(await list(`?status=archived&search=${tag}`)).toEqual([]);
    expect((await sa().get(`${BASE}?status=deleted`)).statusCode).toBe(400);
  });

  it('is in the OpenAPI document under the admin tag', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    const paths = res.json().paths as Record<string, Record<string, { tags?: string[] }>>;
    expect(
      paths['/admin/help-center/']?.post?.tags ?? paths['/admin/help-center']?.post?.tags,
    ).toEqual(['admin']);
    expect(paths['/admin/help-center/reorder']?.post?.tags).toEqual(['admin']);
  });
});
