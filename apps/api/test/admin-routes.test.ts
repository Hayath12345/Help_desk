import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS, staffDirectorySchema } from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// The /admin route plugin (decision E20): authentication and section access before anything else,
// the per-user write limit, the staff directory for pickers, OpenAPI, and the mapping of Prisma
// request errors to 409 / 404.

describe('admin routes', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let otherAdmin: Persona;
  let teamA: { id: string; key: string };
  let archivedTeam: { id: string };
  const WRITE_LIMIT = 3;

  beforeAll(async () => {
    ctx = await createTestContext({
      deps: { adminWriteLimit: { max: WRITE_LIMIT, windowMs: 60_000 } },
      beforeReady(app) {
        // Routes that fail inside Prisma the way admin writes can.
        app.post('/__test/prisma/:kind', async (req) => {
          const { kind } = req.params as { kind: string };
          if (kind === 'unique') {
            return app.prisma.team.create({ data: { key: teamA.key, nameEn: 'x', nameAr: 'x' } });
          }
          if (kind === 'foreign-key') {
            return app.prisma.subtype.create({
              data: { categoryId: crypto.randomUUID(), key: `x-${rand()}`, labelEn: 'x' },
            });
          }
          if (kind === 'restrict') return app.prisma.team.delete({ where: { id: teamA.id } });
          return app.prisma.team.update({
            where: { id: crypto.randomUUID() },
            data: { nameEn: 'x' },
          });
        });
      },
    });
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    teamA = await f.team();
    archivedTeam = await f.team();
    await ctx.prisma.team.update({ where: { id: archivedTeam.id }, data: { isActive: false } });
    // teamA has a ticket-free category so deleting it is refused by a foreign key.
    await f.category({ teamId: teamA.id });

    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Sam Admin' });
    const sa2 = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Olga Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD', name: 'Tia Lead' });
    const ag = await f.staff({ staffDomain, role: 'AGENT', name: 'Ali Agent' });
    const disabled = await f.staff({ staffDomain, role: 'AGENT', status: 'DISABLED' });
    await f.member(teamA.id, tl.id, 'LEAD');
    await f.member(teamA.id, ag.id);
    await f.member(archivedTeam.id, ag.id);
    await f.member(teamA.id, disabled.id);
    await ctx.prisma.user.update({ where: { id: ag.id }, data: { phone: '+974 5550 1234' } });
    await ctx.prisma.user.update({ where: { id: tl.id }, data: { phone: '5550 1234' } });
    const { user: cl } = await f.client();
    superAdmin = await persona(ctx, sa);
    otherAdmin = await persona(ctx, sa2);
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, cl);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('access', () => {
    it('401 without a token, before the body is validated', async () => {
      const res = await apiAs(ctx).post('/admin/categories', { garbage: true });
      expect(res.statusCode).toBe(401);
      expect((await apiAs(ctx).get('/admin/staff-directory')).statusCode).toBe(401);
    });

    it('403 for clients and agents on every section and the directory', async () => {
      for (const who of [client, agent]) {
        for (const section of ADMIN_SECTIONS) {
          const res = await apiAs(ctx, who).get(`/admin/${section}`);
          expect(res.statusCode, `${who.role} ${section}`).toBe(403);
          expect(res.json().error.code).toBe('FORBIDDEN');
        }
        expect((await apiAs(ctx, who).get('/admin/staff-directory')).statusCode).toBe(403);
      }
    });

    it('team leads reach Teams and Macros only (E7); super admins every section', async () => {
      for (const section of ADMIN_SECTIONS) {
        const lead = await apiAs(ctx, teamLead).get(`/admin/${section}`);
        const expected = section === 'teams' || section === 'macros' ? 200 : 403;
        expect(lead.statusCode, `TEAM_LEAD ${section}`).toBe(expected);
        const admin = await apiAs(ctx, superAdmin).get(`/admin/${section}`);
        expect(admin.statusCode, `SUPER_ADMIN ${section}`).toBe(200);
      }
    });

    it('a section refuses before validating the body (403, not 400)', async () => {
      const res = await apiAs(ctx, teamLead).post('/admin/staff', { not: 'valid' });
      expect(res.statusCode).toBe(403);
    });

    it('unknown admin paths are 404', async () => {
      expect((await apiAs(ctx, superAdmin).get('/admin/nope')).statusCode).toBe(404);
    });
  });

  describe('per-user write limit', () => {
    it(`allows ${WRITE_LIMIT} writes per window per user, then 429 with Retry-After`, async () => {
      const api = apiAs(ctx, otherAdmin);
      // Invalid bodies (400) still count: the limit runs before the body is read.
      for (let i = 0; i < WRITE_LIMIT; i++) {
        expect((await api.post('/admin/help-center', {})).statusCode).toBe(400);
      }
      const limited = await api.patch('/admin/help-center/x', {});
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Reads are not writes; other users have their own budget.
      expect((await api.get('/admin/help-center')).statusCode).toBe(200);
      expect((await apiAs(ctx, superAdmin).post('/admin/help-center', {})).statusCode).toBe(400);
    });
  });

  describe('GET /admin/staff-directory', () => {
    it('lists active staff with memberships of active teams and phone presence, never the phone', async () => {
      const res = await apiAs(ctx, superAdmin).get(`/admin/staff-directory?teamId=${teamA.id}`);
      expect(res.statusCode).toBe(200);
      const { items } = staffDirectorySchema.parse(res.json());
      expect(items.map((i) => i.name)).toEqual(['Ali Agent', 'Tia Lead']); // sorted; disabled left out
      const ali = items.find((i) => i.name === 'Ali Agent');
      expect(ali).toMatchObject({ role: 'AGENT', hasPhone: true, phoneValid: true });
      // The archived team's membership is not listed.
      expect(ali?.teams).toEqual([{ teamId: teamA.id, memberRole: 'MEMBER' }]);
      const tia = items.find((i) => i.name === 'Tia Lead');
      expect(tia).toMatchObject({ role: 'TEAM_LEAD', hasPhone: true, phoneValid: false });
      expect(tia?.teams).toEqual([{ teamId: teamA.id, memberRole: 'LEAD' }]);
      expect(res.body).not.toContain('+974 5550');
      expect(res.body).not.toContain('5550 1234');
    });

    it('team leads may use it (adding members); search and role filters work', async () => {
      const res = await apiAs(ctx, teamLead).get(
        '/admin/staff-directory?search=olga&role=SUPER_ADMIN',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((i: { name: string }) => i.name)).toEqual(['Olga Admin']);
      const none = await apiAs(ctx, teamLead).get('/admin/staff-directory?search=olga&role=AGENT');
      expect(none.json().items).toEqual([]);
    });

    it('never lists clients', async () => {
      const res = await apiAs(ctx, superAdmin).get('/admin/staff-directory?limit=500');
      expect(res.json().items.some((i: { id: string }) => i.id === client.id)).toBe(false);
    });
  });

  describe('Prisma errors (E19)', () => {
    const call = (kind: string) =>
      ctx.app.inject({ method: 'POST', url: `/__test/prisma/${kind}`, payload: {} });

    it('a unique violation is 409 CONFLICT duplicate with the fields', async () => {
      const res = await call('unique');
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'duplicate', fields: ['key'] },
      });
    });

    it('a foreign-key violation is 409 in_use (insert and restricted delete)', async () => {
      for (const kind of ['foreign-key', 'restrict']) {
        const res = await call(kind);
        expect(res.statusCode, kind).toBe(409);
        expect(res.json().error.details.reason).toBe('in_use');
      }
      expect(await ctx.prisma.team.count({ where: { id: teamA.id } })).toBe(1);
    });

    it('a missing record is 404', async () => {
      const res = await call('missing');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('OpenAPI', () => {
    it('documents the admin tag, the staff directory and every section', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
      const doc = res.json() as {
        tags: Array<{ name: string }>;
        paths: Record<string, Record<string, { tags?: string[] }>>;
      };
      expect(doc.tags.map((t) => t.name)).toContain('admin');
      expect(doc.paths['/admin/staff-directory']).toBeDefined();
      for (const section of ADMIN_SECTIONS) {
        const paths = Object.keys(doc.paths).filter(
          (p) => p === `/admin/${section}` || p.startsWith(`/admin/${section}/`),
        );
        expect(paths.length, section).toBeGreaterThan(0);
        for (const path of paths) {
          for (const op of Object.values(doc.paths[path]!)) expect(op.tags).toEqual(['admin']);
        }
      }
    });
  });
});
