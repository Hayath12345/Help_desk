import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogActorListSchema,
  auditLogListSchema,
  helpArticleResponseSchema,
  type AuditLogList,
} from '@loons/shared';
import { decodeAuditCursor, encodeAuditCursor } from '../src/services/admin/audit-log.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Audit log viewer (decision E17): super admins only, read-only (no write routes), newest
// first, filters (entity, entity id, actor, action, from inclusive / to exclusive) and cursor
// paging over (createdAt, id). The rows below are inserted directly, in the year 2001, so the
// date filters isolate them from everything else in the database.

const BASE = '/admin/audit-log';
const at = (day: number, minute = 0) => new Date(Date.UTC(2001, 0, day, 12, minute)).toISOString();
const WINDOW = `from=${encodeURIComponent(at(1))}&to=${encodeURIComponent(at(28))}`;

describe('admin audit log', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let otherAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  const rowIds: string[] = [];
  /** Rows of the former admins (in 2000, outside WINDOW). */
  const formerRowIds: string[] = [];
  let former: { disabled: string; demoted: string; noEntries: string };
  const teamId = crypto.randomUUID();
  const articleIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const team = await f.team();
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Sam Admin' });
    const sa2 = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Olga Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    const ag = await f.staff({ staffDomain, role: 'AGENT' });
    await f.member(team.id, tl.id, 'LEAD');
    const { user: cl } = await f.client();
    superAdmin = await persona(ctx, sa);
    otherAdmin = await persona(ctx, sa2);
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, cl);

    // Seven rows: days 2..8 at noon, two of them at the same instant (day 5).
    const rows = [
      { day: 2, actorId: sa.id, action: 'CREATE', entity: 'Team', entityId: teamId },
      { day: 3, actorId: sa.id, action: 'UPDATE', entity: 'Team', entityId: teamId },
      { day: 4, actorId: sa2.id, action: 'UPDATE', entity: 'Category', entityId: rand() },
      { day: 5, actorId: sa2.id, action: 'ARCHIVE', entity: 'Team', entityId: teamId },
      { day: 5, actorId: null, action: 'RESTORE', entity: 'Team', entityId: teamId },
      { day: 7, actorId: sa.id, action: 'DELETE', entity: 'TeamMember', entityId: rand() },
      { day: 8, actorId: sa2.id, action: 'REORDER', entity: 'Team', entityId: 'teams' },
    ] as const;
    for (const row of rows) {
      const created = await ctx.prisma.adminAuditLog.create({
        data: {
          actorId: row.actorId,
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          entityLabel: `${row.entity} ${row.day}`,
          requestId: `req-${rand()}`,
          before: row.action === 'CREATE' ? undefined : { nameEn: 'Old', isActive: true },
          after: row.action === 'DELETE' ? undefined : { nameEn: 'New', isActive: false },
          createdAt: new Date(at(row.day)),
        },
        select: { id: true },
      });
      rowIds.push(created.id);
    }
    // Review web-comms-1 / contract-8: people who made changes and have since been disabled or
    // demoted must stay selectable in the "Changed by" filter.
    const disabled = await f.staff({
      staffDomain,
      role: 'SUPER_ADMIN',
      status: 'DISABLED',
      name: 'Dora Former',
    });
    const demoted = await f.staff({ staffDomain, role: 'AGENT', name: 'Dan Demoted' });
    former = { disabled: disabled.id, demoted: demoted.id, noEntries: ag.id };
    for (const actorId of [disabled.id, demoted.id]) {
      const created = await ctx.prisma.adminAuditLog.create({
        data: {
          actorId,
          action: 'UPDATE',
          entity: 'Team',
          entityId: teamId,
          entityLabel: 'Former',
          createdAt: new Date(Date.UTC(2000, 5, 1, 12)),
        },
        select: { id: true },
      });
      formerRowIds.push(created.id);
    }
    f.onCleanup(async () => {
      await ctx.prisma.adminAuditLog.deleteMany({
        where: {
          OR: [{ id: { in: [...rowIds, ...formerRowIds] } }, { entityId: { in: articleIds } }],
        },
      });
      await ctx.prisma.helpArticle.deleteMany({ where: { id: { in: articleIds } } });
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const sa = () => apiAs(ctx, superAdmin);
  const page = async (query: string): Promise<AuditLogList> => {
    const res = await sa().get(`${BASE}?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return auditLogListSchema.parse(res.json());
  };
  const days = (list: AuditLogList) => list.items.map((i) => i.entityLabel);

  describe('access (super admins only, read-only)', () => {
    it('401 without a token; 403 for clients, agents and team leads', async () => {
      for (const url of [BASE, `${BASE}/actors`]) {
        expect((await apiAs(ctx).get(url)).statusCode, url).toBe(401);
        for (const who of [client, agent, teamLead]) {
          expect((await apiAs(ctx, who).get(url)).statusCode, `${who.role} ${url}`).toBe(403);
        }
      }
    });

    it('has no write routes', async () => {
      const api = sa();
      expect((await api.post(BASE, {})).statusCode).toBe(404);
      expect((await api.patch(`${BASE}/${rowIds[0]}`, {})).statusCode).toBe(404);
      expect((await api.delete(`${BASE}/${rowIds[0]}`)).statusCode).toBe(404);
      expect(await ctx.prisma.adminAuditLog.count({ where: { id: { in: rowIds } } })).toBe(7);
    });
  });

  it('lists newest first with the actor, the entity and the changed fields', async () => {
    const list = await page(WINDOW);
    expect(days(list)).toEqual([
      'Team 8',
      'TeamMember 7',
      // Same instant: the larger id first (a stable order for paging).
      ...['Team 5', 'Team 5'],
      'Category 4',
      'Team 3',
      'Team 2',
    ]);
    const first = list.items[0]!;
    expect(first).toMatchObject({
      actor: { id: otherAdmin.id, name: 'Olga Admin', role: 'SUPER_ADMIN' },
      action: 'REORDER',
      entity: 'Team',
      entityId: 'teams',
      before: { nameEn: 'Old', isActive: true },
      after: { nameEn: 'New', isActive: false },
    });
    expect(list.items.find((i) => i.action === 'CREATE')?.before).toBeNull();
    expect(list.items.find((i) => i.action === 'DELETE')?.after).toBeNull();
    // A change with no actor (deleted user / system).
    expect(list.items.find((i) => i.action === 'RESTORE')?.actor).toBeNull();
    expect(list.nextCursor).toBeNull();
  });

  it('pages with a cursor: no row twice or missing, even across equal timestamps', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const list = await page(`${WINDOW}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(list.items.length).toBeLessThanOrEqual(2);
      seen.push(...list.items.map((i) => i.id));
      cursor = list.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual((await page(WINDOW)).items.map((i) => i.id));
  });

  it('filters by entity, entity id, actor, action and date range (from inclusive, to exclusive)', async () => {
    expect(days(await page(`${WINDOW}&entity=Category`))).toEqual(['Category 4']);
    expect((await page(`${WINDOW}&entityId=${teamId}`)).items).toHaveLength(4);
    expect(days(await page(`${WINDOW}&actorId=${superAdmin.id}`))).toEqual([
      'TeamMember 7',
      'Team 3',
      'Team 2',
    ]);
    expect(days(await page(`${WINDOW}&action=UPDATE`))).toEqual(['Category 4', 'Team 3']);
    expect(
      days(
        await page(`from=${encodeURIComponent(at(3))}&to=${encodeURIComponent(at(5))}&entity=Team`),
      ),
    ).toEqual(['Team 3']);
    expect(days(await page(`${WINDOW}&entity=Team&entityId=${teamId}&action=ARCHIVE`))).toEqual([
      'Team 5',
    ]);
  });

  it('400 for an unknown entity or action, a malformed cursor, date or limit', async () => {
    for (const query of [
      'entity=Nope',
      'action=ERASE',
      'cursor=not-a-cursor',
      `cursor=${Buffer.from(`${at(3)}|nope`).toString('base64url')}`,
      'from=yesterday',
      'actorId=someone',
      'limit=0',
      'limit=101',
    ]) {
      expect((await sa().get(`${BASE}?${query}`)).statusCode, query).toBe(400);
    }
  });

  it('lists everyone with entries as actors, disabled and demoted admins included', async () => {
    const res = await sa().get(`${BASE}/actors`);
    expect(res.statusCode, res.body).toBe(200);
    const { items } = auditLogActorListSchema.parse(res.json());
    const mine = items.filter((a) =>
      [superAdmin.id, otherAdmin.id, former.disabled, former.demoted, former.noEntries].includes(
        a.id,
      ),
    );
    // By name; someone without entries is not offered.
    expect(mine).toEqual([
      { id: former.demoted, name: 'Dan Demoted', role: 'AGENT', status: 'ACTIVE' },
      { id: former.disabled, name: 'Dora Former', role: 'SUPER_ADMIN', status: 'DISABLED' },
      { id: otherAdmin.id, name: 'Olga Admin', role: 'SUPER_ADMIN', status: 'ACTIVE' },
      { id: superAdmin.id, name: 'Sam Admin', role: 'SUPER_ADMIN', status: 'ACTIVE' },
    ]);
    // And filtering by one of them works.
    const byFormer = await page(`actorId=${former.disabled}`);
    expect(byFormer.items.map((i) => i.id)).toEqual([formerRowIds[0]]);
  });

  it('cursors round-trip; anything else is refused', () => {
    const cursor = { createdAt: new Date(at(3, 7)), id: crypto.randomUUID() };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor('')).toBeNull();
    expect(decodeAuditCursor(Buffer.from('2001-01-03|x').toString('base64url'))).toBeNull();
    expect(
      decodeAuditCursor(Buffer.from(`${at(3)}|${cursor.id}|x`).toString('base64url')),
    ).toBeNull();
  });

  it('shows a real admin change, written by the writer in the same request', async () => {
    const res = await sa().post('/admin/help-center', {
      key: `test-${rand()}`,
      titleEn: 'Audited article',
      bodyEn: 'Body',
    });
    expect(res.statusCode).toBe(201);
    const { item } = helpArticleResponseSchema.parse(res.json());
    articleIds.push(item.id);
    const list = await page(`entity=HelpArticle&entityId=${item.id}`);
    expect(list.items).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityLabel: 'Audited article',
        actor: { id: superAdmin.id, name: 'Sam Admin', role: 'SUPER_ADMIN' },
        requestId: res.headers['x-request-id'] ?? expect.any(String),
        before: null,
        after: expect.objectContaining({ key: item.key, titleEn: 'Audited article' }),
      }),
    ]);
  });
});
