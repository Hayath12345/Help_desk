import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_QUEUE_CAPACITY,
  QUEUE_TAB_SORTS,
  QUEUE_TAB_VIEWS,
  QUEUE_TABS,
  queueCountsSchema,
  queueFilterOptionsSchema,
  ticketListSchema,
  workloadSchema,
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

// Phase 5 Team queue (decisions F2–F5): the staff filters of GET /tickets (priority, category,
// assignee incl. "none", organisation, requester) ANDed onto the Inbox visibility, the `priority`
// sort, the tab counts (each equal to the list length for the same filters and search), the agent
// workload cards and the Category filter's options. Assertions use this file's own teams and
// categories only (a super admin sees the whole shared dev database).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Key = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'u';

describe('Team queue: filters, priority sort, tab counts, workload, filter options', () => {
  let ctx: TestContext;
  let w: World;
  let teamT: { id: string };
  let teamU: { id: string };
  let agentT: Persona;
  let agentT2: Persona;
  let leadT: Persona;
  let agentU: Persona;
  let cat1: string;
  let cat2: string;
  let catArch: string;
  const ids = {} as Record<Key, string>;
  const tag = rand(4);

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    teamT = await f.team();
    teamU = await f.team();
    const subtypes = [
      { defaultPriority: 'P1' as const },
      { defaultPriority: 'P2' as const },
      { defaultPriority: 'P3' as const },
      { defaultPriority: 'P4' as const },
    ];
    const c1 = await f.category({ teamId: teamT.id, subtypes });
    const c2 = await f.category({ teamId: teamT.id, subtypes });
    const cA = await f.category({ teamId: teamT.id, subtypes });
    const cU = await f.category({ teamId: teamU.id, subtypes });
    cat1 = c1.category.id;
    cat2 = c2.category.id;
    catArch = cA.category.id;
    await ctx.app.services.ticketConfig.invalidate();

    const staff = async (name: string, teamId: string, role: 'AGENT' | 'TEAM_LEAD' = 'AGENT') => {
      const user = await f.staff({ staffDomain, name, role });
      await f.member(teamId, user.id, role === 'TEAM_LEAD' ? 'LEAD' : 'MEMBER');
      return persona(ctx, user);
    };
    agentT = await staff(`Tess ${tag}`, teamT.id);
    agentT2 = await staff(`Tom ${tag}`, teamT.id);
    leadT = await staff(`Tia Lead ${tag}`, teamT.id, 'TEAM_LEAD');
    agentU = await staff(`Uma ${tag}`, teamU.id);
    // Not a card: a disabled member.
    const disabled = await f.staff({ staffDomain, name: `Dora ${tag}`, status: 'DISABLED' });
    await f.member(teamT.id, disabled.id);

    const now = Date.now();
    const at = (ms: number) => new Date(now + ms);
    const byP = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    // [category, priority, status, assignee, requester, replied, first-reply due, its at-risk
    //  instant, resolution due]
    type Spec = [
      { category: { id: string }; subtypes: Array<{ id: string }> },
      keyof typeof byP,
      string,
      Persona | null,
      Persona,
      boolean,
      number,
      number,
      number,
    ];
    const specs: Record<Key, Spec> = {
      a: [c1, 'P1', 'NEW', null, w.clientX, false, 10 * MIN, -1 * MIN, DAY], // at risk
      b: [c1, 'P2', 'OPEN', agentT, w.clientX, false, 2 * HOUR, HOUR, DAY],
      c: [c2, 'P3', 'PENDING', agentT2, w.clientY, true, -HOUR, -2 * HOUR, 3 * DAY], // paused
      d: [c2, 'P1', 'OPEN', agentT, w.clientY, false, -5 * MIN, -10 * MIN, DAY], // overdue
      e: [c1, 'P4', 'SOLVED', agentT, w.clientX, true, -DAY, -DAY, -HOUR],
      f: [cA, 'P3', 'CLOSED', null, w.clientX, true, -3 * DAY, -3 * DAY, -2 * DAY],
      g: [cA, 'P2', 'OPEN', null, w.clientX, false, 5 * HOUR, 4 * HOUR, 2 * DAY],
      h: [c1, 'P3', 'NEW', null, w.clientX, false, 6 * HOUR, 5 * HOUR, 2 * DAY],
      // Team U, assigned to agentT (visible to agentT through the assignment only).
      u: [cU, 'P1', 'OPEN', agentT, w.clientX, false, DAY, 20 * HOUR, 2 * DAY],
    };
    for (const [key, spec] of Object.entries(specs) as Array<[Key, Spec]>) {
      const [cat, priority, status, assignee, requester, replied, firstDue, firstRisk, resolve] =
        spec;
      const t = await createTicket(
        ctx,
        requester,
        ticketBody(w, {
          subject: `Queue ${tag} ${key.toUpperCase()} sample`,
          categoryId: cat.category.id,
          subtypeId: cat.subtypes[byP[priority]]!.id,
          siteId: requester.id === w.clientY.id ? w.siteY1.id : w.siteX1.id,
        }),
      );
      ids[key] = t.id;
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          status: status as never,
          assigneeId: assignee?.id ?? null,
          firstRepliedAt: replied ? at(-2 * DAY) : null,
          firstReplyDueAt: at(firstDue),
          firstReplyAtRiskAt: at(firstRisk),
          resolveDueAt: at(resolve),
          resolveAtRiskAt: at(resolve - HOUR),
          slaPausedAt: status === 'PENDING' ? at(-HOUR) : null,
          solvedAt: status === 'SOLVED' || status === 'CLOSED' ? at(-HOUR) : null,
        },
      });
    }
    // The archived category still has tickets (f, g): it stays in the Category filter.
    await ctx.prisma.category.update({ where: { id: catArch }, data: { isActive: false } });
    await ctx.app.services.ticketConfig.invalidate();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const keysOf = (items: Array<{ id: string }>) =>
    items.map((t) => (Object.keys(ids) as Key[]).find((k) => ids[k] === t.id) ?? t.id);

  async function allPages(as: Persona, query: string, limit = 100) {
    const items: TicketSummaryDto[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await apiAs(ctx, as).get(
        `/tickets?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = ticketListSchema.parse(res.json());
      items.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 100);
    return items;
  }

  const list = async (as: Persona, query: string) => keysOf(await allPages(as, query)).sort();
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

  async function counts(as: Persona, query: string) {
    const res = await apiAs(ctx, as).get(`/tickets/queue-counts?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return queueCountsSchema.parse(res.json()).tabs;
  }

  describe('GET /tickets filters (ANDed onto the Inbox visibility)', () => {
    it('priority, category, assignee (a person or none), organisation and requester', async () => {
      expect(await list(agentT, q({ search: tag }))).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
        'h',
        'u',
      ]);
      expect(await list(agentT, q({ priority: 'P1' }))).toEqual(['a', 'd', 'u']);
      expect(await list(agentT, q({ categoryId: cat1 }))).toEqual(['a', 'b', 'e', 'h']);
      expect(await list(agentT, q({ categoryId: catArch }))).toEqual(['f', 'g']);
      expect(await list(agentT, q({ assigneeId: 'none' }))).toEqual(['a', 'f', 'g', 'h']);
      expect(await list(agentT, q({ assigneeId: agentT.id }))).toEqual(['b', 'd', 'e', 'u']);
      expect(await list(agentT, q({ orgId: w.orgY.id }))).toEqual(['c', 'd']);
      expect(await list(agentT, q({ requesterId: w.clientY.id }))).toEqual(['c', 'd']);
      // Combined with a view, the team and the search.
      expect(
        await list(agentT, q({ view: 'open', priority: 'P1', teamId: teamT.id, search: tag })),
      ).toEqual(['a', 'd']);
      expect(await list(agentT, q({ view: 'unassigned', categoryId: cat1 }))).toEqual(['a', 'h']);
      expect(await list(agentT, q({ view: 'solved', assigneeId: 'none' }))).toEqual(['f']);
    });

    it('never widens what the caller sees', async () => {
      // Agent T2 is on team T only: the ticket assigned to agent T on team U stays hidden.
      expect(await list(agentT2, q({ assigneeId: agentT.id }))).toEqual(['b', 'd', 'e']);
      // Agent U sees team U only: filtering on team T or its categories finds nothing.
      expect(await list(agentU, q({ teamId: teamT.id }))).toEqual([]);
      expect(await list(agentU, q({ categoryId: cat1 }))).toEqual([]);
      expect(await list(agentU, q({ search: tag }))).toEqual(['u']);
      expect(await list(agentU, q({ orgId: w.orgX.id }))).toEqual(['u']);
      // Clients: the staff filters are ignored; still only their organisation's tickets.
      const client = keysOf(
        await allPages(w.clientY, q({ tab: 'all', orgId: w.orgX.id, priority: 'P3' })),
      ).sort();
      expect(client).toEqual(['c', 'd']);
    });

    it('400 for a malformed filter', async () => {
      for (const query of ['assigneeId=nobody', 'priority=P5', 'categoryId=1', 'sort=queue']) {
        const res = await apiAs(ctx, agentT).get(`/tickets?${query}`);
        expect(res.statusCode, query).toBe(400);
      }
    });
  });

  describe('sort=priority (F3)', () => {
    // Done last; P1 → P4; then the next SLA due date (the first reply while unanswered, else the
    // resolution): d (−5 min) before a (+10 min) before u (+1 day); b (+2 h) before g (+5 h); h
    // (+6 h) before c (replied: resolution +3 days); the done ones last, f (P3) before e (P4).
    const ORDER: Key[] = ['d', 'a', 'u', 'b', 'g', 'h', 'c', 'f', 'e'];

    it('orders P1 → P4, then by the next due date, done last', async () => {
      const items = await allPages(agentT, q({ search: tag, sort: 'priority' }));
      expect(keysOf(items)).toEqual(ORDER);
    });

    it.each([1, 2, 4])('cursor pagination is stable (page size %i)', async (limit) => {
      const items = await allPages(agentT, q({ search: tag, sort: 'priority' }), limit);
      expect(keysOf(items)).toEqual(ORDER);
    });

    it('paused tickets (waiting on the client) come after running ones within a priority', async () => {
      // Own team, so the other tests' lists stay as they are. A PENDING ticket already answered
      // keeps a stale resolution due date in the past: it must not jump ahead of an at-risk one.
      const f = ctx.fixtures;
      const tag3 = rand(4);
      const teamV = await f.team();
      const cV = await f.category({ teamId: teamV.id, subtypes: [{ defaultPriority: 'P2' }] });
      await ctx.app.services.ticketConfig.invalidate();
      const userV = await f.staff({ staffDomain: ctx.config.staffEmailDomain, name: `Val ${tag}` });
      await f.member(teamV.id, userV.id);
      const agentV = await persona(ctx, userV);
      const now = Date.now();
      const at = (ms: number) => new Date(now + ms);
      const make = async (name: string, data: Record<string, unknown>) => {
        const t = await createTicket(
          ctx,
          w.clientX,
          ticketBody(w, {
            subject: `Paused ${tag3} ${name}`,
            categoryId: cV.category.id,
            subtypeId: cV.subtypes[0]!.id,
            siteId: w.siteX1.id,
          }),
        );
        await ctx.prisma.ticket.update({ where: { id: t.id }, data });
        return t.id;
      };
      const paused = await make('paused', {
        status: 'PENDING',
        firstRepliedAt: at(-2 * DAY),
        firstReplyDueAt: at(-2 * DAY - HOUR),
        firstReplyAtRiskAt: at(-2 * DAY - 2 * HOUR),
        resolveDueAt: at(-HOUR),
        resolveAtRiskAt: at(-2 * HOUR),
        slaPausedAt: at(-3 * HOUR),
      });
      const atRisk = await make('at risk', {
        status: 'OPEN',
        firstReplyDueAt: at(30 * MIN),
        firstReplyAtRiskAt: at(-MIN),
        resolveDueAt: at(DAY),
        resolveAtRiskAt: at(DAY - HOUR),
      });
      const later = await make('later', {
        status: 'NEW',
        firstReplyDueAt: at(3 * HOUR),
        firstReplyAtRiskAt: at(2 * HOUR),
        resolveDueAt: at(2 * DAY),
        resolveAtRiskAt: at(2 * DAY - HOUR),
      });
      for (const limit of [100, 1, 2]) {
        const items = await allPages(
          agentV,
          q({ search: tag3, view: 'open', sort: 'priority' }),
          limit,
        );
        expect(
          items.map((t) => t.id),
          `page size ${limit}`,
        ).toEqual([atRisk, later, paused]);
      }
    });

    it('a cursor of another sort, or a malformed one, is 400', async () => {
      const first = ticketListSchema.parse(
        (
          await apiAs(ctx, agentT).get(`/tickets?${q({ search: tag, sort: 'sla', limit: '1' })}`)
        ).json(),
      );
      const res = await apiAs(ctx, agentT).get(
        `/tickets?sort=priority&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(res.statusCode).toBe(400);
      for (const k of [
        [0, 'P9', 0, null, 1, ids.a],
        [0, 'P1', 2, null, 1, ids.a],
        // The shape before the paused key was added.
        [0, 'P1', null, 1, ids.a],
      ]) {
        const bad = Buffer.from(JSON.stringify({ s: 'priority', k })).toString('base64url');
        expect(
          (await apiAs(ctx, agentT).get(`/tickets?sort=priority&cursor=${bad}`)).statusCode,
          JSON.stringify(k),
        ).toBe(400);
      }
    });
  });

  describe('GET /tickets/queue-counts', () => {
    it('counts the tabs for the caller, the filters and the search', async () => {
      expect(await counts(agentT, q({ search: tag }))).toEqual({
        open: 7, // a b c d g h u
        unassigned: 3, // a g h
        breaching: 2, // a (at risk) d (overdue)
        solved: 2, // e f
      });
      expect(await counts(agentT, q({ priority: 'P1' }))).toEqual({
        open: 3,
        unassigned: 1,
        breaching: 2,
        solved: 0,
      });
      expect(await counts(agentT2, q({ search: tag }))).toEqual({
        open: 6,
        unassigned: 3,
        breaching: 2,
        solved: 2,
      });
      expect(await counts(agentU, q({ teamId: teamT.id }))).toEqual({
        open: 0,
        unassigned: 0,
        breaching: 0,
        solved: 0,
      });
    });

    it('each tab count equals the length of its list, for every filter combination', async () => {
      const combos: Array<Record<string, string>> = [
        {},
        { priority: 'P1' },
        { priority: 'P2' },
        { categoryId: cat1 },
        { categoryId: catArch },
        { assigneeId: 'none' },
        { assigneeId: agentT.id },
        { orgId: w.orgY.id },
        { requesterId: w.clientX.id },
        { teamId: teamT.id },
        { search: `${tag} a sample` },
        { priority: 'P1', assigneeId: agentT.id, search: tag },
        { categoryId: cat2, orgId: w.orgY.id, teamId: teamT.id },
      ];
      const personas: Array<[Persona, Record<string, string>]> = [
        [agentT, {}],
        [agentT2, {}],
        [leadT, {}],
        [agentU, {}],
        // A super admin sees the whole dev database: keep to this file's tickets.
        [w.admin, { search: tag }],
      ];
      for (const [who, scope] of personas) {
        for (const combo of combos) {
          const filters = { ...combo, ...scope, ...(combo.search ? { search: combo.search } : {}) };
          const tabs = await counts(who, q(filters));
          for (const tab of QUEUE_TABS) {
            const items = await allPages(
              who,
              q({ ...filters, view: QUEUE_TAB_VIEWS[tab], sort: QUEUE_TAB_SORTS[tab] }),
            );
            expect(tabs[tab], `${who.name} ${JSON.stringify(filters)} ${tab}`).toBe(items.length);
          }
        }
      }
    });

    it('clients get 403; no token 401; malformed filters 400', async () => {
      expect((await apiAs(ctx, w.clientX).get('/tickets/queue-counts')).statusCode).toBe(403);
      expect((await apiAs(ctx).get('/tickets/queue-counts')).statusCode).toBe(401);
      expect((await apiAs(ctx, agentT).get('/tickets/queue-counts?assigneeId=x')).statusCode).toBe(
        400,
      );
    });
  });

  describe('GET /tickets/workload (agent cards, F5)', () => {
    async function workload(as: Persona) {
      const res = await apiAs(ctx, as).get('/tickets/workload');
      expect(res.statusCode, res.body).toBe(200);
      return workloadSchema.parse(res.json());
    }
    const card = (id: string, body: Awaited<ReturnType<typeof workload>>) =>
      body.agents.find((a) => a.id === id);

    it('one card per active member of the visible teams, open and at-risk counts, busiest first', async () => {
      const body = await workload(agentT);
      expect(body.capacity).toBe(AGENT_QUEUE_CAPACITY);
      expect(body.capacity).toBe(6);
      // Agent T: b, d and the team U ticket (visible to them); d is overdue.
      expect(body.agents.map((a) => [a.name, a.open, a.atRisk])).toEqual([
        [agentT.name, 3, 1],
        [agentT2.name, 1, 0],
        [leadT.name, 0, 0],
      ]);
      expect(card(agentT.id, body)?.teams.map((t) => t.id)).toEqual([teamT.id]);
    });

    it('counts only tickets the viewer can see; other teams’ members are not cards', async () => {
      // Agent T2 can't see the team U ticket assigned to agent T.
      expect(card(agentT.id, await workload(agentT2))).toMatchObject({ open: 2, atRisk: 1 });
      const u = await workload(agentU);
      expect(u.agents.map((a) => a.id)).toEqual([agentU.id]);
      expect(u.agents[0]).toMatchObject({ open: 0, atRisk: 0 });
      // A super admin sees every active team's members.
      const admin = await workload(w.admin);
      expect(card(agentT.id, admin)).toMatchObject({ open: 3, atRisk: 1 });
      expect(card(agentU.id, admin)).toMatchObject({ open: 0 });
      expect(admin.agents.some((a) => a.name === `Dora ${tag}`)).toBe(false);
    });

    it('clients get 403', async () => {
      expect((await apiAs(ctx, w.clientX).get('/tickets/workload')).statusCode).toBe(403);
      expect((await apiAs(ctx).get('/tickets/workload')).statusCode).toBe(401);
    });
  });

  describe('GET /tickets/filter-options (Category filter, F4)', () => {
    async function categories(as: Persona) {
      const res = await apiAs(ctx, as).get('/tickets/filter-options');
      expect(res.statusCode, res.body).toBe(200);
      return queueFilterOptionsSchema.parse(res.json()).categories;
    }

    it('active categories, then archived ones with tickets the caller can see', async () => {
      const t = await categories(agentT);
      const idsOf = t.map((c) => c.id);
      expect(idsOf).toEqual(expect.arrayContaining([cat1, cat2, catArch]));
      expect(t.find((c) => c.id === catArch)?.isActive).toBe(false);
      // Archived ones come after every active one.
      const firstArchived = t.findIndex((c) => !c.isActive);
      expect(t.slice(firstArchived).every((c) => !c.isActive)).toBe(true);
      // The world's archived category has no tickets: never offered.
      expect(idsOf).not.toContain(w.catArchived.category.id);
      // Agent U sees none of the archived category's tickets.
      const u = await categories(agentU);
      expect(u.map((c) => c.id)).not.toContain(catArch);
      expect(u.map((c) => c.id)).toEqual(expect.arrayContaining([cat1, cat2]));
      expect((await categories(w.admin)).map((c) => c.id)).toContain(catArch);
    });

    it('clients get 403', async () => {
      expect((await apiAs(ctx, w.clientX).get('/tickets/filter-options')).statusCode).toBe(403);
    });
  });
});
