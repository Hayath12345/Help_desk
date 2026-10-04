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
  categoryResponseSchema,
  skillAdminListSchema,
  skillResponseSchema,
  staffResponseSchema,
} from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Skills (docs/AUTO_ASSIGN.md): super admins only; a catalog of labels that staff have and
// categories ask for. Archiving keeps the links; only active skills can be newly linked.

describe('admin skills', () => {
  let ctx: TestContext;
  let admin: Persona;
  let lead: Persona;
  let agent: Persona;
  let broadcast: MockInstance;

  const label = () => `Skill ${rand(6)}`;
  const scopesSent = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const createSkill = async (labelEn = label()) => {
    const res = await apiAs(ctx, admin).post('/admin/skills', { labelEn, labelAr: 'مهارة' });
    expect(res.statusCode).toBe(201);
    const { item } = skillResponseSchema.parse(res.json());
    ctx.fixtures.trackSkill(item.id);
    return item;
  };
  const staffUpdatedAt = async (id: string) =>
    (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
  const categoryUpdatedAt = async (id: string) =>
    (await ctx.prisma.category.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    admin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    lead = await persona(ctx, await f.staff({ staffDomain, role: 'TEAM_LEAD' }));
    agent = await persona(ctx, await f.staff({ staffDomain }));
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
  });
  beforeEach(() => broadcast.mockClear());
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  it('super admins only: 401 without a token, 403 for team leads and agents', async () => {
    expect((await apiAs(ctx).get('/admin/skills')).statusCode).toBe(401);
    for (const who of [lead, agent]) {
      expect((await apiAs(ctx, who).get('/admin/skills')).statusCode).toBe(403);
      expect((await apiAs(ctx, who).post('/admin/skills', {})).statusCode).toBe(403);
      expect((await apiAs(ctx, who).put(`/admin/staff/${agent.id}/skills`, {})).statusCode).toBe(
        403,
      );
    }
  });

  describe('catalog', () => {
    it('creates a skill with a generated key and announces the skills scope', async () => {
      const name = `Fibre ${rand(4)}`;
      const res = await apiAs(ctx, admin).post('/admin/skills', { labelEn: name });
      expect(res.statusCode).toBe(201);
      const { item } = skillResponseSchema.parse(res.json());
      ctx.fixtures.trackSkill(item.id);
      expect(item).toMatchObject({
        labelEn: name,
        labelAr: '',
        isActive: true,
        staffCount: 0,
        categoryCount: 0,
      });
      expect(item.key).toMatch(/^fibre-/);
      expect(scopesSent()).toEqual(['skills']);
      const [audit] = await ctx.prisma.adminAuditLog.findMany({ where: { entityId: item.id } });
      expect(audit).toMatchObject({ action: 'CREATE', entity: 'Skill', actorId: admin.id });
    });

    it('refuses a taken key or English label (case-insensitive), naming the existing skill', async () => {
      const skill = await createSkill();
      const sameKey = await apiAs(ctx, admin).post('/admin/skills', {
        key: skill.key,
        labelEn: label(),
      });
      expect(sameKey.statusCode).toBe(409);
      expect(sameKey.json().error.details).toMatchObject({
        reason: 'duplicate',
        fields: ['key'],
        existingId: skill.id,
      });
      const sameLabel = await apiAs(ctx, admin).post('/admin/skills', {
        labelEn: skill.labelEn.toUpperCase(),
      });
      expect(sameLabel.statusCode).toBe(409);
      expect(sameLabel.json().error.details).toMatchObject({
        reason: 'duplicate',
        fields: ['labelEn'],
        existingId: skill.id,
      });
    });

    it('renames, refuses a stale edit, and keeps the key', async () => {
      const skill = await createSkill();
      const res = await apiAs(ctx, admin).patch(`/admin/skills/${skill.id}`, {
        expectedUpdatedAt: skill.updatedAt,
        labelEn: `${skill.labelEn} v2`,
      });
      expect(res.statusCode).toBe(200);
      const { item } = skillResponseSchema.parse(res.json());
      expect(item).toMatchObject({ labelEn: `${skill.labelEn} v2`, key: skill.key });
      const stale = await apiAs(ctx, admin).patch(`/admin/skills/${skill.id}`, {
        expectedUpdatedAt: skill.updatedAt,
        labelAr: 'x',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
      const nothing = await apiAs(ctx, admin).patch(`/admin/skills/${skill.id}`, {
        expectedUpdatedAt: item.updatedAt,
      });
      expect(nothing.statusCode).toBe(400);
    });

    it('archives and restores, and the list filters by status', async () => {
      const skill = await createSkill();
      const archived = await apiAs(ctx, admin).post(`/admin/skills/${skill.id}/archive`, {
        expectedUpdatedAt: skill.updatedAt,
      });
      expect(archived.statusCode).toBe(200);
      const { item } = skillResponseSchema.parse(archived.json());
      expect(item.isActive).toBe(false);

      const ids = async (status: string) =>
        skillAdminListSchema
          .parse((await apiAs(ctx, admin).get(`/admin/skills?status=${status}`)).json())
          .items.map((s) => s.id);
      expect(await ids('active')).not.toContain(skill.id);
      expect(await ids('archived')).toContain(skill.id);
      expect(await ids('all')).toContain(skill.id);

      const restored = await apiAs(ctx, admin).post(`/admin/skills/${skill.id}/restore`, {
        expectedUpdatedAt: item.updatedAt,
      });
      expect(skillResponseSchema.parse(restored.json()).item.isActive).toBe(true);
      expect(await ids('active')).toContain(skill.id);
      const actions = (
        await ctx.prisma.adminAuditLog.findMany({
          where: { entityId: skill.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((a) => a.action);
      expect(actions).toEqual(['CREATE', 'ARCHIVE', 'RESTORE']);
    });

    it('searches by label and counts active staff and active categories', async () => {
      const skill = await createSkill(`Searchable ${rand(5)}`);
      const user = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const disabled = await ctx.fixtures.staff({
        staffDomain: ctx.config.staffEmailDomain,
        status: 'DISABLED',
      });
      await ctx.fixtures.giveSkills(user.id, [skill.id]);
      await ctx.fixtures.giveSkills(disabled.id, [skill.id]);
      const team = await ctx.fixtures.team();
      const live = await ctx.fixtures.category({ teamId: team.id });
      const gone = await ctx.fixtures.category({ teamId: team.id, isActive: false });
      await ctx.fixtures.requireSkills(live.category.id, [skill.id]);
      await ctx.fixtures.requireSkills(gone.category.id, [skill.id]);
      const res = await apiAs(ctx, admin).get(
        `/admin/skills?search=${encodeURIComponent(skill.labelEn.slice(0, 12))}`,
      );
      const found = skillAdminListSchema.parse(res.json()).items.find((s) => s.id === skill.id);
      expect(found).toMatchObject({ staffCount: 1, categoryCount: 1 });
    });
  });

  describe('PUT /admin/staff/:id/skills', () => {
    it('replaces the person’s skills, moves updatedAt, audits keys and announces staff + skills', async () => {
      const [a, b, c] = [await createSkill(), await createSkill(), await createSkill()];
      const person = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      broadcast.mockClear();
      const first = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [a.id, b.id],
      });
      expect(first.statusCode).toBe(200);
      expect(
        staffResponseSchema
          .parse(first.json())
          .item.skills.map((s) => s.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      expect(scopesSent().sort()).toEqual(['skills', 'staff']);

      const second = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [b.id, c.id],
      });
      expect(
        staffResponseSchema
          .parse(second.json())
          .item.skills.map((s) => s.id)
          .sort(),
      ).toEqual([b.id, c.id].sort());
      const audits = await ctx.prisma.adminAuditLog.findMany({
        where: { entityId: person.id, action: 'UPDATE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.at(-1)).toMatchObject({
        before: { skills: [a.key, b.key].sort() },
        after: { skills: [b.key, c.key].sort() },
      });

      const cleared = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [],
      });
      expect(staffResponseSchema.parse(cleared.json()).item.skills).toEqual([]);
    });

    it('refuses a stale save, an unknown skill, a duplicate, and a client account', async () => {
      const skill = await createSkill();
      const person = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const expectedUpdatedAt = await staffUpdatedAt(person.id);
      const ok = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt,
        skillIds: [skill.id],
      });
      expect(ok.statusCode).toBe(200);
      const stale = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt,
        skillIds: [],
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');

      const unknown = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: ['00000000-0000-4000-8000-000000000000'],
      });
      expect(unknown.statusCode).toBe(400);
      const dupe = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [skill.id, skill.id],
      });
      expect(dupe.statusCode).toBe(400);

      const { user: client } = await ctx.fixtures.client();
      const notStaff = await apiAs(ctx, admin).put(`/admin/staff/${client.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(client.id),
        skillIds: [skill.id],
      });
      expect(notStaff.statusCode).toBe(404);
    });

    it('lets an archived skill stay on a person but not be newly added', async () => {
      const keep = await createSkill();
      const person = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      await ctx.fixtures.giveSkills(person.id, [keep.id]);
      await ctx.prisma.skill.update({ where: { id: keep.id }, data: { isActive: false } });
      const fresh = await createSkill();
      await ctx.prisma.skill.update({ where: { id: fresh.id }, data: { isActive: false } });

      const adding = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [keep.id, fresh.id],
      });
      expect(adding.statusCode).toBe(400);
      const staying = await apiAs(ctx, admin).put(`/admin/staff/${person.id}/skills`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        skillIds: [keep.id],
      });
      expect(staying.statusCode).toBe(200);
      expect(staffResponseSchema.parse(staying.json()).item.skills).toMatchObject([
        { id: keep.id, isActive: false },
      ]);
    });

    it('PATCH /admin/staff/:id sets whether they take automatic tickets', async () => {
      const person = await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain });
      const res = await apiAs(ctx, admin).patch(`/admin/staff/${person.id}`, {
        expectedUpdatedAt: await staffUpdatedAt(person.id),
        acceptsAutoAssign: false,
      });
      expect(res.statusCode).toBe(200);
      expect(staffResponseSchema.parse(res.json()).item.acceptsAutoAssign).toBe(false);
      expect(
        (await ctx.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).acceptsAutoAssign,
      ).toBe(false);
    });
  });

  describe('categories', () => {
    it('PUT /admin/categories/:id/skills replaces the skills a category needs', async () => {
      const [a, b] = [await createSkill(), await createSkill()];
      const team = await ctx.fixtures.team();
      const { category } = await ctx.fixtures.category({ teamId: team.id });
      broadcast.mockClear();
      const res = await apiAs(ctx, admin).put(`/admin/categories/${category.id}/skills`, {
        expectedUpdatedAt: await categoryUpdatedAt(category.id),
        skillIds: [a.id, b.id],
      });
      expect(res.statusCode).toBe(200);
      expect(
        categoryResponseSchema
          .parse(res.json())
          .item.skills.map((s) => s.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      expect(scopesSent()).toEqual(['skills']);

      const narrowed = await apiAs(ctx, admin).put(`/admin/categories/${category.id}/skills`, {
        expectedUpdatedAt: await categoryUpdatedAt(category.id),
        skillIds: [b.id],
      });
      expect(categoryResponseSchema.parse(narrowed.json()).item.skills.map((s) => s.id)).toEqual([
        b.id,
      ]);
      const stale = await apiAs(ctx, admin).put(`/admin/categories/${category.id}/skills`, {
        expectedUpdatedAt: category.updatedAt.toISOString(),
        skillIds: [],
      });
      expect(stale.statusCode).toBe(409);
    });

    it('refuses to newly require an archived skill', async () => {
      const skill = await createSkill();
      await ctx.prisma.skill.update({ where: { id: skill.id }, data: { isActive: false } });
      const team = await ctx.fixtures.team();
      const { category } = await ctx.fixtures.category({ teamId: team.id });
      const res = await apiAs(ctx, admin).put(`/admin/categories/${category.id}/skills`, {
        expectedUpdatedAt: await categoryUpdatedAt(category.id),
        skillIds: [skill.id],
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a category with the skills it needs', async () => {
      const skill = await createSkill();
      const team = await ctx.fixtures.team();
      broadcast.mockClear();
      const res = await apiAs(ctx, admin).post('/admin/categories', {
        labelEn: `Skilled ${rand(5)}`,
        teamId: team.id,
        firstSubtype: { labelEn: 'General' },
        skillIds: [skill.id],
      });
      expect(res.statusCode).toBe(201);
      const { item } = categoryResponseSchema.parse(res.json());
      ctx.fixtures.trackCategory(item.id);
      expect(item.skills.map((s) => s.id)).toEqual([skill.id]);
      expect(scopesSent().sort()).toEqual(['skills', 'ticket-form']);
    });
  });
});
