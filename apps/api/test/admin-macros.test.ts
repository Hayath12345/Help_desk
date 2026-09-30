import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { macroAdminListSchema, macroResponseSchema, type MacroAdminDto } from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Macros (spec §10.8; decisions E7, E17, E18, E19): super admins manage every macro; team
// leads only their teams' (never global ones, never moved elsewhere); setStatus limited to
// staff-settable statuses; body variables limited to MACRO_VARIABLES; stale 409, audit rows, the
// `macros` scope, and the console's GET /macros sees the change.

describe('admin macros', () => {
  let ctx: TestContext;
  let admin: Persona;
  let leadA: Persona;
  let agentA: Persona;
  let client: Persona;
  let teamA: { id: string; nameEn: string };
  let teamB: { id: string };
  let archivedTeam: { id: string };
  const macroIds = new Set<string>();
  const sent: Array<[string, unknown]> = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    teamA = await f.team();
    teamB = await f.team();
    archivedTeam = await f.team();
    await ctx.prisma.team.update({ where: { id: archivedTeam.id }, data: { isActive: false } });
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Mac Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD', name: 'Mac Lead' });
    await f.member(teamA.id, tl.id, 'LEAD');
    // Leads team A, is a plain member of team B: team B stays out of reach (E7).
    await f.member(teamB.id, tl.id, 'MEMBER');
    const ag = await f.staff({ staffDomain, role: 'AGENT' });
    await f.member(teamA.id, ag.id);
    admin = await persona(ctx, sa);
    leadA = await persona(ctx, tl);
    agentA = await persona(ctx, ag);
    client = await persona(ctx, (await f.client()).user);
    f.onCleanup(() => ctx.prisma.macro.deleteMany({ where: { id: { in: [...macroIds] } } }));
    const broadcast = ctx.app.realtime.broadcast.bind(ctx.app.realtime);
    vi.spyOn(ctx.app.realtime, 'broadcast').mockImplementation((event, payload) => {
      sent.push([event, payload]);
      broadcast(event, payload);
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const scopesSince = (mark: number) =>
    sent
      .slice(mark)
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  async function createMacro(
    as: Persona,
    body: Record<string, unknown>,
    status = 201,
  ): Promise<MacroAdminDto> {
    const res = await apiAs(ctx, as).post('/admin/macros', {
      titleEn: `Test macro ${rand()}`,
      bodyEn: 'Hi {{requesterFirstName}}, we are on it at {{siteName}}.',
      ...body,
    });
    expect(res.statusCode, res.body).toBe(status);
    const { item } = macroResponseSchema.parse(res.json());
    macroIds.add(item.id);
    return item;
  }

  /** A macro created directly (another team's, a global one…). */
  async function macroRow(teamId: string | null) {
    const row = await ctx.prisma.macro.create({
      data: { key: `test-${rand()}`, teamId, titleEn: `Row ${rand(3)}`, bodyEn: 'Body' },
    });
    macroIds.add(row.id);
    return row;
  }

  it('401 anonymous; 403 for clients and agents', async () => {
    const m = await macroRow(teamA.id);
    const body = { expectedUpdatedAt: m.updatedAt.toISOString() };
    const calls: Array<[string, (p?: Persona) => ReturnType<ReturnType<typeof apiAs>['get']>]> = [
      ['list', (p) => apiAs(ctx, p).get('/admin/macros')],
      ['create', (p) => apiAs(ctx, p).post('/admin/macros', {})],
      ['update', (p) => apiAs(ctx, p).patch(`/admin/macros/${m.id}`, body)],
      ['archive', (p) => apiAs(ctx, p).post(`/admin/macros/${m.id}/archive`, body)],
      ['restore', (p) => apiAs(ctx, p).post(`/admin/macros/${m.id}/restore`, body)],
      ['reorder', (p) => apiAs(ctx, p).post('/admin/macros/reorder', {})],
    ];
    for (const [name, call] of calls) {
      expect((await call(undefined)).statusCode, `anonymous ${name}`).toBe(401);
      expect((await call(client)).statusCode, `client ${name}`).toBe(403);
      expect((await call(agentA)).statusCode, `agent ${name}`).toBe(403);
    }
  });

  describe('super admin', () => {
    it('creates global and team macros; the console sees them; audited; scope macros', async () => {
      const mark = sent.length;
      const global = await createMacro(admin, {
        teamId: null,
        titleAr: 'رد عام',
        bodyAr: 'مرحبا {{requesterFirstName}}',
        setStatus: 'PENDING',
      });
      expect(global).toMatchObject({
        teamId: null,
        team: null,
        setStatus: 'PENDING',
        createdBy: { id: admin.id },
      });
      expect(global.key).toMatch(/^test-macro-/);
      const team = await createMacro(admin, { teamId: teamA.id });
      expect(team.team).toMatchObject({ id: teamA.id, isActive: true });
      expect(scopesSince(mark)).toEqual(['macros', 'macros']);
      expect(await auditRows(team.id)).toMatchObject([
        { action: 'CREATE', entity: 'Macro', actorId: admin.id },
      ]);
      const console = (await apiAs(ctx, agentA).get('/macros')).json().items as Array<{
        id: string;
      }>;
      expect(console.map((m) => m.id)).toEqual(expect.arrayContaining([global.id, team.id]));

      const list = macroAdminListSchema.parse(
        (await apiAs(ctx, admin).get('/admin/macros')).json(),
      );
      const globalIndex = list.items.findIndex((m) => m.id === global.id);
      const teamIndex = list.items.findIndex((m) => m.id === team.id);
      expect(globalIndex).toBeGreaterThanOrEqual(0);
      expect(globalIndex).toBeLessThan(teamIndex);
      expect(list.items.slice(0, globalIndex).every((m) => m.teamId === null)).toBe(true);
      const onlyA = macroAdminListSchema.parse(
        (await apiAs(ctx, admin).get(`/admin/macros?teamId=${teamA.id}`)).json(),
      );
      expect(onlyA.items.every((m) => m.teamId === teamA.id)).toBe(true);
    });

    it('the console lists global macros first, then each team’s in its own order (E3)', async () => {
      // Order is per scope: a team's positions restart at 0, so a flat sortOrder sort would
      // interleave them with the global ones (review api-setup-2).
      const row = (teamId: string | null, sortOrder: number, titleEn: string) =>
        ctx.prisma.macro
          .create({ data: { key: `test-${rand()}`, teamId, titleEn, bodyEn: 'Body', sortOrder } })
          .then((m) => (macroIds.add(m.id), m));
      const global = await row(null, 1, `Zz global ${rand(3)}`);
      const first = await row(teamA.id, 0, `Zz team first ${rand(3)}`);
      const second = await row(teamA.id, 1, `Aa team second ${rand(3)}`);
      const items = (await apiAs(ctx, agentA).get('/macros')).json().items as Array<{
        id: string;
        teamId: string | null;
      }>;
      const lastGlobal = items.findLastIndex((m) => m.teamId === null);
      const firstTeam = items.findIndex((m) => m.teamId !== null);
      expect(lastGlobal).toBeLessThan(firstTeam);
      expect(items.findIndex((m) => m.id === global.id)).toBeLessThanOrEqual(lastGlobal);
      const mine = new Set([first.id, second.id]);
      expect(items.filter((m) => mine.has(m.id)).map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it('validation: staff-settable statuses only, known variables only, active team', async () => {
      const titleEn = `Test v ${rand()}`;
      // Whatever a broken rule lets through is removed even if the test stops early.
      ctx.fixtures.onCleanup(() => ctx.prisma.macro.deleteMany({ where: { titleEn } }));
      const cases: Array<[Record<string, unknown>, string, string]> = [
        [{ teamId: null, setStatus: 'CLOSED' }, 'setStatus', ''],
        [{ teamId: null, bodyEn: 'Hi {{name}}' }, 'bodyEn', 'validation.unknownVariable'],
        [{ teamId: null, bodyAr: 'مرحبا {{ phone }}' }, 'bodyAr', 'validation.unknownVariable'],
        [{ teamId: null, bodyEn: '' }, 'bodyEn', 'validation.required'],
        [{ teamId: archivedTeam.id }, 'teamId', 'validation.teamArchived'],
        [{ teamId: crypto.randomUUID() }, 'teamId', 'validation.notFound'],
      ];
      for (const [body, path, message] of cases) {
        const res = await apiAs(ctx, admin).post('/admin/macros', {
          titleEn,
          bodyEn: 'Body',
          ...body,
        });
        expect(res.statusCode, `${path} ${res.body}`).toBe(400);
        const found = (
          res.json().error.details as Array<{ path: unknown[]; message: string }>
        ).find((i) => i.path[0] === path);
        expect(found, path).toBeDefined();
        if (message) expect(found?.message).toBe(message);
      }
      expect(await ctx.prisma.macro.count({ where: { titleEn } })).toBe(0);
      const m = await createMacro(admin, { teamId: null });
      const res = await apiAs(ctx, admin).patch(`/admin/macros/${m.id}`, {
        expectedUpdatedAt: m.updatedAt,
        bodyEn: '{{ticketRef}}',
      });
      expect(res.statusCode).toBe(400);
    });

    it('moves a macro between teams and global; the key never changes; 409 stale', async () => {
      const m = await createMacro(admin, { teamId: teamA.id });
      const moved = await apiAs(ctx, admin).patch(`/admin/macros/${m.id}`, {
        expectedUpdatedAt: m.updatedAt,
        teamId: null,
        key: 'changed',
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().item).toMatchObject({ teamId: null, key: m.key });
      const update = (await auditRows(m.id)).find((r) => r.action === 'UPDATE');
      expect(update).toMatchObject({ before: { teamId: teamA.id }, after: { teamId: null } });
      const stale = await apiAs(ctx, admin).patch(`/admin/macros/${m.id}`, {
        expectedUpdatedAt: m.updatedAt,
        titleEn: 'Lost',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details.reason).toBe('stale');
    });

    it('archive / restore; the console no longer offers an archived macro', async () => {
      const m = await createMacro(admin, { teamId: teamA.id });
      const archived = await apiAs(ctx, admin).post(`/admin/macros/${m.id}/archive`, {
        expectedUpdatedAt: m.updatedAt,
      });
      expect(archived.json().item.isActive).toBe(false);
      const console = (await apiAs(ctx, agentA).get('/macros')).json().items as Array<{
        id: string;
      }>;
      expect(console.some((x) => x.id === m.id)).toBe(false);
      const archivedList = macroAdminListSchema.parse(
        (await apiAs(ctx, admin).get('/admin/macros?status=archived')).json(),
      );
      expect(archivedList.items.some((x) => x.id === m.id)).toBe(true);
      const restored = await apiAs(ctx, admin).post(`/admin/macros/${m.id}/restore`, {
        expectedUpdatedAt: archived.json().item.updatedAt,
      });
      expect(restored.json().item.isActive).toBe(true);
      expect((await auditRows(m.id)).map((r) => r.action)).toEqual([
        'CREATE',
        'ARCHIVE',
        'RESTORE',
      ]);
    });
  });

  describe('team lead (E7)', () => {
    it('lists only the macros of teams they lead; other scopes are 403', async () => {
      const own = await macroRow(teamA.id);
      const other = await macroRow(teamB.id);
      const global = await macroRow(null);
      const list = macroAdminListSchema.parse(
        (await apiAs(ctx, leadA).get('/admin/macros')).json(),
      );
      const ids = list.items.map((m) => m.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(other.id);
      expect(ids).not.toContain(global.id);
      expect(list.items.every((m) => m.teamId === teamA.id)).toBe(true);
      expect((await apiAs(ctx, leadA).get('/admin/macros?teamId=global')).statusCode).toBe(403);
      expect((await apiAs(ctx, leadA).get(`/admin/macros?teamId=${teamB.id}`)).statusCode).toBe(
        403,
      );
      expect((await apiAs(ctx, leadA).get(`/admin/macros?teamId=${teamA.id}`)).statusCode).toBe(
        200,
      );
    });

    it('creates, edits, archives and reorders their team’s macros', async () => {
      const a1 = await createMacro(leadA, { teamId: teamA.id });
      const a2 = await createMacro(leadA, { teamId: teamA.id });
      const edited = await apiAs(ctx, leadA).patch(`/admin/macros/${a1.id}`, {
        expectedUpdatedAt: a1.updatedAt,
        titleAr: 'عنوان',
        teamId: teamA.id, // same team: not a move
      });
      expect(edited.statusCode, edited.body).toBe(200);
      const archived = await apiAs(ctx, leadA).post(`/admin/macros/${a2.id}/archive`, {
        expectedUpdatedAt: a2.updatedAt,
      });
      expect(archived.statusCode).toBe(200);
      await apiAs(ctx, leadA).post(`/admin/macros/${a2.id}/restore`, {
        expectedUpdatedAt: archived.json().item.updatedAt,
      });

      const order = async () =>
        (
          await ctx.prisma.macro.findMany({
            where: { teamId: teamA.id, isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { titleEn: 'asc' }, { id: 'asc' }],
            select: { id: true },
          })
        ).map((m) => m.id);
      const expectedIds = await order();
      const ids = [...expectedIds].reverse();
      const mark = sent.length;
      const res = await apiAs(ctx, leadA).post('/admin/macros/reorder', {
        teamId: teamA.id,
        expectedIds,
        ids,
      });
      expect(res.statusCode, res.body).toBe(204);
      expect(await order()).toEqual(ids);
      expect(scopesSince(mark)).toEqual(['macros']);
      expect(
        await ctx.prisma.adminAuditLog.findFirst({
          where: { entity: 'Macro', entityId: teamA.id, action: 'REORDER' },
        }),
      ).toMatchObject({
        before: { order: expectedIds },
        after: { order: ids },
        // Which list changed, by name (E17; review contract-5).
        entityLabel: `${teamA.nameEn} macros`,
      });
      const again = await apiAs(ctx, leadA).post('/admin/macros/reorder', {
        teamId: teamA.id,
        expectedIds,
        ids: expectedIds,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details.reason).toBe('order_changed');
    });

    it('never global macros, never another team’s, never a move — 403 before any stale check', async () => {
      const own = await createMacro(leadA, { teamId: teamA.id });
      const other = await macroRow(teamB.id);
      const global = await macroRow(null);
      const lead = apiAs(ctx, leadA);
      expect(
        (await lead.post('/admin/macros', { teamId: null, titleEn: 'x', bodyEn: 'y' })).statusCode,
      ).toBe(403);
      expect(
        (await lead.post('/admin/macros', { teamId: teamB.id, titleEn: 'x', bodyEn: 'y' }))
          .statusCode,
      ).toBe(403);
      // A stale timestamp still answers 403: nothing about other teams' macros leaks.
      const stale = { expectedUpdatedAt: new Date(0).toISOString() };
      for (const m of [other, global]) {
        expect(
          (await lead.patch(`/admin/macros/${m.id}`, { ...stale, titleEn: 'x' })).statusCode,
        ).toBe(403);
        expect((await lead.post(`/admin/macros/${m.id}/archive`, stale)).statusCode).toBe(403);
        expect((await lead.post(`/admin/macros/${m.id}/restore`, stale)).statusCode).toBe(403);
      }
      for (const teamId of [teamB.id, null]) {
        const move = await lead.patch(`/admin/macros/${own.id}`, {
          expectedUpdatedAt: own.updatedAt,
          teamId,
        });
        expect(move.statusCode, String(teamId)).toBe(403);
      }
      for (const teamId of [teamB.id, null]) {
        const reorder = await lead.post('/admin/macros/reorder', {
          teamId,
          expectedIds: [other.id],
          ids: [other.id],
        });
        expect(reorder.statusCode).toBe(403);
      }
      // Nothing changed.
      const [o, g, mine] = await Promise.all(
        [other.id, global.id, own.id].map((id) =>
          ctx.prisma.macro.findUniqueOrThrow({ where: { id } }),
        ),
      );
      expect(o?.updatedAt.getTime()).toBe(other.updatedAt.getTime());
      expect(g?.updatedAt.getTime()).toBe(global.updatedAt.getTime());
      expect(mine?.teamId).toBe(teamA.id);
    });
  });
});
