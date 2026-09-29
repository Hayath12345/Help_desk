import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isSlaAtRiskOrBreached,
  ticketCountsSchema,
  ticketListSchema,
  type TicketSummaryDto,
} from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Key = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm';

describe('GET /tickets (filters, SLA sort, cursors, search) and /tickets/counts', () => {
  let ctx: TestContext;
  let w: World;
  let agentT: Persona;
  let requester: Persona;
  let teamT: { id: string };
  const ids = {} as Record<Key, string>;
  const numbers = {} as Record<Key, number>;
  const tag = rand(4);

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    teamT = await ctx.fixtures.team();
    const cat = await ctx.fixtures.category({
      teamId: teamT.id,
      subtypes: [{ defaultPriority: 'P3' }, { defaultPriority: 'P1' }],
    });
    await ctx.app.services.ticketConfig.invalidate();
    const agentUser = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      name: 'Tara Team-T',
    });
    await ctx.fixtures.member(teamT.id, agentUser.id);
    agentT = await persona(ctx, agentUser);
    requester = await w.newClientX(`Rhea ${tag}`);

    const now = Date.now();
    const at = (ms: number) => new Date(now + ms);
    // [status, replied, createdAt offset, first-reply due, resolve due, first-reply at-risk
    //  instant, resolution at-risk instant (null = not known yet, e.g. pre-Phase 3), P1?]
    // "At risk" is the stored instant having passed (D1/D2), whatever the time left.
    type Spec = [string, boolean, number, number, number, number | null, number | null, boolean?];
    const specs: Record<Key, Spec> = {
      a: ['NEW', false, -10 * MIN, 2 * HOUR, 2 * DAY, 80 * MIN, DAY], // first reply comfortably ahead
      b: ['OPEN', false, -60 * MIN, 10 * MIN, 2 * DAY, -5 * MIN, DAY], // first reply at risk
      c: ['NEW', false, -30 * MIN, -5 * MIN, 2 * DAY, -10 * MIN, DAY], // first reply overdue
      d: ['OPEN', true, -60 * MIN, -30 * MIN, 3 * HOUR, -40 * MIN, 2 * HOUR], // replied, resolution fine
      e: ['OPEN', true, -4 * HOUR, -3 * HOUR, 20 * MIN, -3.5 * HOUR, -40 * MIN], // resolution at risk
      f: ['PENDING', true, -5 * HOUR, -4 * HOUR, -1 * HOUR, -4.5 * HOUR, -2 * HOUR], // paused (never at risk)
      g: ['SOLVED', true, -3 * DAY, -3 * DAY, -2 * DAY, -3 * DAY, -2 * DAY],
      h: ['CLOSED', true, -9 * DAY, -9 * DAY, -1 * DAY, -9 * DAY, -2 * DAY],
      i: ['NEW', false, -5 * MIN, DAY, 2 * DAY, 20 * HOUR, DAY, true], // P1 (due far ahead to keep the order)
      // PENDING without a first reply (e.g. a note with the "Awaiting client access" macro): the
      // first-reply clock keeps running — overdue here, so at risk and sorted by that due date.
      j: ['PENDING', false, -40 * MIN, -10 * MIN, 2 * DAY, -20 * MIN, DAY],
      // 12 of 72 minutes left: "at risk" under the Phase 2 rule (less than min(1 h, 50 %)), but
      // the stored instant is still ahead, so not at risk now.
      k: ['OPEN', false, -60 * MIN, 12 * MIN, 2 * DAY, 5 * MIN, DAY],
      // No instants yet (created before Phase 3, not backfilled): never "at risk" ...
      l: ['OPEN', false, -60 * MIN, 14 * MIN, 2 * DAY, null, null],
      // ... but an overdue target is still in the view (overdue comes from the due date).
      m: ['NEW', false, -60 * MIN, -2 * MIN, 2 * DAY, null, null],
    };
    let n = 0;
    for (const [
      key,
      [status, replied, created, firstDue, resolveDue, firstRisk, resolveRisk, p1],
    ] of Object.entries(specs) as Array<[Key, Spec]>) {
      const t = await createTicket(
        ctx,
        requester,
        ticketBody(w, {
          subject: `List ${tag} ${key.toUpperCase()} sample`,
          categoryId: cat.category.id,
          subtypeId: cat.subtypes[p1 ? 1 : 0]!.id,
        }),
      );
      ids[key] = t.id;
      numbers[key] = t.number;
      n += 1;
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          status: status as never,
          createdAt: at(created),
          firstReplyDueAt: at(firstDue),
          resolveDueAt: at(resolveDue),
          firstReplyAtRiskAt: firstRisk === null ? null : at(firstRisk),
          resolveAtRiskAt: resolveRisk === null ? null : at(resolveRisk),
          firstRepliedAt: replied ? at(created + MIN) : null,
          slaPausedAt: status === 'PENDING' ? at(-30 * MIN) : null,
          solvedAt: status === 'SOLVED' || status === 'CLOSED' ? at(-DAY) : null,
          // Two assigned to agentT (the "mine" view), one to someone else.
          assigneeId: key === 'a' || key === 'e' ? agentT.id : key === 'd' ? w.agentA.id : null,
          // Distinct, known update times for the "recent" sort: a newest … i oldest.
          updatedAt: at(-n * MIN),
        },
      });
    }
  });
  afterAll(async () => {
    await ctx.close();
  });

  const keysOf = (items: Array<{ id: string }>) =>
    items.map((t) => (Object.keys(ids) as Key[]).find((k) => ids[k] === t.id) ?? t.id);

  async function list(as: Persona, query: string) {
    const res = await apiAs(ctx, as).get(`/tickets?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return ticketListSchema.parse(res.json());
  }

  /** Every page, following nextCursor. */
  async function allPages(as: Persona, query: string, limit: number) {
    const items: TicketSummaryDto[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(
        as,
        `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    return { items, pages };
  }

  const SLA_ORDER: Key[] = ['j', 'c', 'm', 'b', 'k', 'l', 'a', 'i', 'e', 'd', 'f', 'g', 'h'];
  const RECENT_ORDER: Key[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'];

  it('staff default sort is SLA: unanswered first by due, then replied, paused, done last', async () => {
    const { items } = await list(agentT, `teamId=${teamT.id}`);
    expect(keysOf(items)).toEqual(SLA_ORDER);
  });

  it('sort=recent: most recently updated first', async () => {
    const { items } = await list(agentT, `teamId=${teamT.id}&sort=recent`);
    expect(keysOf(items)).toEqual(RECENT_ORDER);
  });

  it.each([1, 2, 4])('cursor pagination is stable (page size %i, both sorts)', async (limit) => {
    const sla = await allPages(agentT, `teamId=${teamT.id}&sort=sla`, limit);
    expect(keysOf(sla.items)).toEqual(SLA_ORDER);
    expect(sla.pages).toBe(Math.ceil(SLA_ORDER.length / limit));
    const recent = await allPages(agentT, `teamId=${teamT.id}&sort=recent`, limit);
    expect(keysOf(recent.items)).toEqual(RECENT_ORDER);
  });

  it('an invalid cursor, or one from the other sort → 400', async () => {
    const first = await list(agentT, `teamId=${teamT.id}&sort=sla&limit=2`);
    const res = await apiAs(ctx, agentT).get(
      `/tickets?teamId=${teamT.id}&sort=recent&cursor=${first.nextCursor}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toEqual(['cursor']);
    expect((await apiAs(ctx, agentT).get('/tickets?cursor=garbage')).statusCode).toBe(400);
  });

  it('cursor timestamps Postgres cannot take → 400, never 500 (review SEC-API-1)', async () => {
    const id = ids.a;
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const bad = [
      { s: 'recent', k: [9e15, id] },
      { s: 'recent', k: [8.64e15, id] },
      { s: 'recent', k: [3e14, id] }, // after the year 9999
      { s: 'recent', k: [-9e15, id] },
      { s: 'recent', k: [-62_135_596_800_001, id] }, // before 0001-01-01
      { s: 'sla', k: [0, 0, 0, 9e15, 1, id] },
      { s: 'sla', k: [0, 0, 0, null, 9e15, id] },
      { s: 'sla', k: [0, 0, 0, 1, -9e15, id] },
    ];
    for (const value of bad) {
      for (const as of [agentT, requester]) {
        const res = await apiAs(ctx, as).get(`/tickets?sort=${value.s}&cursor=${cursor(value)}`);
        expect(res.statusCode, JSON.stringify(value)).toBe(400);
        expect(res.json().error.details[0].path).toEqual(['cursor']);
      }
    }
    // The extremes that are accepted work (nothing before 0001 or after 9999 exists).
    for (const k of [253_402_300_799_999, -62_135_596_800_000]) {
      const res = await apiAs(ctx, agentT).get(
        `/tickets?teamId=${teamT.id}&sort=recent&cursor=${cursor({ s: 'recent', k: [k, id] })}`,
      );
      expect(res.statusCode, String(k)).toBe(200);
    }
  });

  it('views: mine, unassigned, risk, p1, open, solved', async () => {
    const view = async (v: string) =>
      keysOf((await list(agentT, `teamId=${teamT.id}&view=${v}`)).items).sort();
    expect(await view('mine')).toEqual(['a', 'e']);
    expect(await view('unassigned')).toEqual(['b', 'c', 'f', 'i', 'j', 'k', 'l', 'm']);
    // j is PENDING but unanswered: its first reply is overdue (review DA-3). The instant of k is
    // still ahead (D1), l has no instant yet, m has none but is overdue.
    expect(await view('risk')).toEqual(['b', 'c', 'e', 'j', 'm']);
    expect(await view('p1')).toEqual(['i']);
    expect(await view('open')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'i', 'j', 'k', 'l', 'm']);
    expect(await view('solved')).toEqual(['g', 'h']);
  });

  it('the SQL "risk" view matches isSlaAtRiskOrBreached from @loons/shared', async () => {
    const { items } = await list(agentT, `teamId=${teamT.id}`);
    const inJs = keysOf(items.filter((t) => isSlaAtRiskOrBreached(t))).sort();
    const inSql = keysOf((await list(agentT, `teamId=${teamT.id}&view=risk`)).items).sort();
    expect(inSql).toEqual(inJs);
    expect(inJs).toContain('j');
    expect(inJs).toContain('m');
    expect(inJs).not.toContain('f');
    expect(inJs).not.toContain('k');
    expect(inJs).not.toContain('l');
  });

  it('search: subject (any case), LG number, bare number, requester name and email', async () => {
    const search = async (term: string) =>
      keysOf((await list(agentT, `search=${encodeURIComponent(term)}`)).items).sort();
    expect(await search(`list ${tag} c sample`)).toEqual(['c']);
    expect(await search(`LG-${numbers.d}`)).toEqual(['d']);
    // A bare number matches the ticket number (and, like any term, subjects / names containing it).
    expect(await search(`${numbers.e}`)).toContain('e');
    expect(await search(`Rhea ${tag}`)).toEqual([...SLA_ORDER].sort());
    expect(await search(requester.email.toUpperCase())).toEqual([...SLA_ORDER].sort());
    expect(await search(`${tag}%`)).toEqual([]); // wildcards are literal
    // Control characters are dropped, never sent to Postgres (review SEC-API-2).
    expect(await search(`\u0000list ${tag} c\u0007 sample`)).toEqual(['c']);
    expect((await apiAs(ctx, requester).get('/tickets?search=%00abc')).statusCode).toBe(200);
  });

  it('staff counts: views and teams within what the caller can see', async () => {
    const res = await apiAs(ctx, agentT).get('/tickets/counts');
    expect(res.statusCode).toBe(200);
    const counts = ticketCountsSchema.parse(res.json());
    expect(counts).toEqual({
      kind: 'staff',
      views: { mine: 2, unassigned: 8, risk: 5, p1: 1, open: 11, solved: 2 },
      teams: [
        {
          id: teamT.id,
          key: expect.any(String),
          nameEn: expect.any(String),
          nameAr: expect.any(String),
          count: 11,
        },
      ],
    });
    // A super admin sees every active team, including team T with the same count.
    const admin = ticketCountsSchema.parse(
      (await apiAs(ctx, w.admin).get('/tickets/counts')).json(),
    );
    if (admin.kind !== 'staff') throw new Error('expected staff counts');
    expect(admin.teams.find((t) => t.id === teamT.id)?.count).toBe(11);
    expect(admin.teams.some((t) => t.id === w.inactiveTeam.id)).toBe(false);
    // Agent A sees d (assigned) but not team T in their team list.
    const a = ticketCountsSchema.parse((await apiAs(ctx, w.agentA).get('/tickets/counts')).json());
    if (a.kind !== 'staff') throw new Error('expected staff counts');
    expect(a.teams.map((t) => t.id)).toEqual([w.teamA.id]);
  });

  it('clients: tabs over the tickets they requested, with counts', async () => {
    const tab = async (t: string) =>
      keysOf((await list(requester, `tab=${t}&limit=100`)).items).sort();
    expect(await tab('all')).toEqual([...SLA_ORDER].sort());
    expect(await tab('active')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'i', 'j', 'k', 'l', 'm']);
    expect(await tab('solved')).toEqual(['g', 'h']);
    // Default client sort: recent.
    expect(keysOf((await list(requester, 'limit=100')).items)).toEqual(RECENT_ORDER);
    const counts = ticketCountsSchema.parse(
      (await apiAs(ctx, requester).get('/tickets/counts')).json(),
    );
    expect(counts).toEqual({ kind: 'client', tabs: { all: 13, active: 11, solved: 2 } });
    // Staff-only filters are ignored for clients (visibility still applies).
    expect(keysOf((await list(w.clientY, `teamId=${teamT.id}&view=open&scope=org`)).items)).toEqual(
      [],
    );
  });
});
