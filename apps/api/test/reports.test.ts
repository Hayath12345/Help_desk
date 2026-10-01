import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  hasBreachedSla,
  reportsSummarySchema,
  slaMinutesBetween,
  type BusinessCalendar,
  type ReportsSummary,
} from '@loons/shared';
import { zonedInstant } from '../src/jobs/local-time.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Phase 5 Reports (decisions F10–F12) on a known set of tickets, with exact expected numbers:
// snapshot tiles (open, P1 open, SLA breached by flag and by due date, unassigned), period tiles
// (solved in the period — its first day starts at local midnight in business.timezone —, average
// first reply on the SLA clock: calendar minutes for 24/7 policies, business minutes with holidays
// for business-hours ones) and open tickets by category (active in admin order incl. zeros, then
// archived ones with open tickets). Numbers are scoped like the Inbox: assertions use this file's
// teams (a super admin sees the whole dev database).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ZONE = 'Asia/Qatar';

/** "YYYY-MM-DD" in Asia/Qatar. */
const qatarDate = (instant: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(instant));
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** Local Qatar time (UTC+3 all year) as an instant. */
const qatar = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

type Key = 't1' | 't2' | 't3' | 't4' | 't5' | 't6' | 't7' | 't8' | 't9' | 't11' | 't12' | 't13';

describe('GET /reports/summary', () => {
  let ctx: TestContext;
  let w: World;
  let agentR: Persona;
  let agentZ: Persona;
  let cat: Record<'r1' | 'r2' | 'r3' | 'r4' | 'z', string>;
  let from: number;
  let calendar: BusinessCalendar;
  const ids = {} as Record<Key, string>;
  const tag = rand(4);

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const teamR = await f.team();
    const teamZ = await f.team();
    const subtypes = (['P1', 'P2', 'P3', 'P4'] as const).map((p) => ({ defaultPriority: p }));
    const cats = {
      r1: await f.category({ teamId: teamR.id, subtypes }),
      r2: await f.category({ teamId: teamR.id, subtypes }),
      r3: await f.category({ teamId: teamR.id, subtypes }),
      r4: await f.category({ teamId: teamR.id, subtypes }),
      z: await f.category({ teamId: teamZ.id, subtypes }),
    };
    cat = {
      r1: cats.r1.category.id,
      r2: cats.r2.category.id,
      r3: cats.r3.category.id,
      r4: cats.r4.category.id,
      z: cats.z.category.id,
    };
    await ctx.app.services.ticketConfig.invalidate();
    const r = await f.staff({ staffDomain, name: `Rana ${tag}` });
    await f.member(teamR.id, r.id);
    agentR = await persona(ctx, r);
    const z = await f.staff({ staffDomain, name: `Zaid ${tag}` });
    await f.member(teamZ.id, z.id);
    agentZ = await persona(ctx, z);

    // A known calendar and known policies, whatever the dev database holds (other suites edit
    // them): Sunday–Thursday 07:30–16:30 in Asia/Qatar; P1 / P2 24/7, P3 / P4 business hours.
    const now = Date.now();
    const today = qatarDate(now);
    // The Sunday of last week (7–13 days ago) and the Thursday before it; the Monday after it is
    // a holiday.
    let sunday = addDays(today, -7);
    while (weekday(sunday) !== 0) sunday = addDays(sunday, -1);
    const thursday = addDays(sunday, -3);
    const monday = addDays(sunday, 1);
    calendar = {
      timeZone: ZONE,
      hours: [0, 1, 2, 3, 4, 5, 6].map((d) => (d <= 4 ? { open: '07:30', close: '16:30' } : null)),
      holidays: [monday],
    };
    const config = ctx.app.services.ticketConfig;
    const realFormConfig = config.getFormConfig.bind(config);
    vi.spyOn(config, 'getCalendar').mockResolvedValue(calendar);
    vi.spyOn(config, 'getFormConfig').mockImplementation(async () => {
      const real = await realFormConfig();
      return {
        ...real,
        slaPolicies: real.slaPolicies.map((p) => ({
          ...p,
          businessHoursOnly: p.priority === 'P3' || p.priority === 'P4',
        })),
      };
    });
    // The 30-day period starts at local midnight 29 days before today.
    from = Date.parse(`${addDays(today, -29)}T00:00:00+03:00`);

    const at = (ms: number) => new Date(now + ms);
    const byP = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    interface Spec {
      cat: keyof typeof cats;
      priority: keyof typeof byP;
      status: string;
      assigned?: Persona;
      breachedFlag?: boolean;
      createdAt?: Date;
      repliedAt?: Date;
      /** First-reply due, relative to now (default: an hour after the reply, i.e. on time). */
      firstDue?: number;
      firstDueAt?: Date;
      resolveDue?: number;
      /** PENDING: when the resolution clock was paused (default: 3 hours ago). */
      pausedAt?: Date;
      solvedAt?: Date;
    }
    const specs: Record<Key, Spec> = {
      // Open, P1, on time.
      t1: { cat: 'r1', priority: 'P1', status: 'OPEN', assigned: agentR, firstDue: HOUR },
      // Open, P1, unassigned, first reply overdue → breached (due date).
      t2: { cat: 'r1', priority: 'P1', status: 'NEW', firstDue: -10 * MIN },
      // Open, replied and on time, but the stored flag says a target was breached.
      t3: {
        cat: 'r2',
        priority: 'P3',
        status: 'OPEN',
        assigned: agentR,
        breachedFlag: true,
        createdAt: qatar(sunday, '08:00'),
        repliedAt: qatar(sunday, '10:00'), // 120 business minutes
        resolveDue: DAY,
      },
      // PENDING after the reply: the resolution clock is paused, its old due date doesn't count.
      t4: {
        cat: 'r2',
        priority: 'P2',
        status: 'PENDING',
        assigned: agentR,
        createdAt: qatar(sunday, '12:00'),
        repliedAt: qatar(sunday, '13:02'), // 62 calendar minutes
        resolveDue: -HOUR,
      },
      // PENDING but never answered: the first-reply clock still runs, and it is overdue.
      t5: { cat: 'r2', priority: 'P3', status: 'PENDING', assigned: agentR, firstDue: -HOUR },
      // Replied, resolution overdue, unassigned; its category is archived below.
      t6: {
        cat: 'r3',
        priority: 'P4',
        status: 'OPEN',
        createdAt: qatar(thursday, '15:30'),
        repliedAt: qatar(sunday, '08:30'), // 60 + 60 business minutes over the weekend
        resolveDue: -2 * HOUR,
      },
      // Solved in the period (flagged, but done tickets are never "breached").
      t7: {
        cat: 'r1',
        priority: 'P3',
        status: 'SOLVED',
        assigned: agentR,
        breachedFlag: true,
        createdAt: qatar(sunday, '16:00'),
        repliedAt: qatar(monday, '07:45'), // 30 business minutes (Monday is a holiday)
        solvedAt: at(-DAY),
      },
      // Closed a millisecond before the period (archived category with no open ticket).
      t8: { cat: 'r4', priority: 'P3', status: 'CLOSED', solvedAt: new Date(from - 1) },
      // Closed at the first instant of the period; first replied before it.
      t9: {
        cat: 'r1',
        priority: 'P2',
        status: 'CLOSED',
        createdAt: new Date(from - 2 * HOUR),
        repliedAt: new Date(from - MIN),
        solvedAt: new Date(from),
      },
      // Team Z, assigned to agent R: visible to both agents.
      t11: { cat: 'z', priority: 'P4', status: 'OPEN', assigned: agentR, firstDue: 5 * HOUR },
      // Breaches the SLA scan never flagged (replied long before every period): the first reply
      // sent two hours after its due date …
      t12: {
        cat: 'r1',
        priority: 'P2',
        status: 'OPEN',
        assigned: agentR,
        createdAt: at(-100 * DAY),
        firstDueAt: at(-100 * DAY + HOUR),
        repliedAt: at(-100 * DAY + 3 * HOUR),
      },
      // … and a PENDING pause that began after the resolution due date had passed.
      t13: {
        cat: 'r1',
        priority: 'P2',
        status: 'PENDING',
        assigned: agentR,
        createdAt: at(-100 * DAY),
        repliedAt: at(-100 * DAY + 30 * MIN),
        resolveDue: -2 * HOUR,
        pausedAt: at(-HOUR),
      },
    };
    for (const [key, s] of Object.entries(specs) as Array<[Key, Spec]>) {
      const c = cats[s.cat];
      const t = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, {
          subject: `Reports ${tag} ${key}`,
          categoryId: c.category.id,
          subtypeId: c.subtypes[byP[s.priority]]!.id,
        }),
      );
      ids[key] = t.id;
      const firstDue =
        s.firstDueAt ??
        (s.firstDue !== undefined
          ? at(s.firstDue)
          : s.repliedAt
            ? new Date(s.repliedAt.getTime() + HOUR)
            : at(-30 * DAY));
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: {
          status: s.status as never,
          assigneeId: s.assigned?.id ?? null,
          slaBreached: s.breachedFlag ?? false,
          ...(s.createdAt ? { createdAt: s.createdAt } : {}),
          firstRepliedAt: s.repliedAt ?? null,
          firstReplyDueAt: firstDue,
          firstReplyAtRiskAt: new Date(firstDue.getTime() - 30 * MIN),
          resolveDueAt: at(s.resolveDue ?? 2 * DAY),
          resolveAtRiskAt: at((s.resolveDue ?? 2 * DAY) - HOUR),
          slaPausedAt: s.status === 'PENDING' ? (s.pausedAt ?? at(-3 * HOUR)) : null,
          solvedAt: s.solvedAt ?? null,
        },
      });
    }
    await ctx.prisma.category.updateMany({
      where: { id: { in: [cat.r3, cat.r4] } },
      data: { isActive: false },
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  async function summary(as: Persona, query = ''): Promise<ReportsSummary> {
    const res = await apiAs(ctx, as).get(`/reports/summary${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return reportsSummarySchema.parse(res.json());
  }
  const row = (body: ReportsSummary, id: string) =>
    body.byCategory.find((r) => r.category.id === id);

  it('tiles on the known tickets, exactly (agent of team R)', async () => {
    const body = await summary(agentR);
    expect(body.period).toBe('30d');
    expect(body.timeZone).toBe(ZONE);
    expect(Date.parse(body.from)).toBe(from);
    expect(body.tiles).toEqual({
      open: 9, // t1 t2 t3 t4 t5 t6 t11 t12 t13
      p1Open: 2, // t1 t2
      // t2 (first reply overdue), t3 (flag), t5 (overdue while PENDING), t6 (resolution), t12
      // (first reply sent late, never flagged), t13 (paused after the resolution due date)
      breached: 6,
      unassigned: 2, // t2 t6
      solved: 2, // t7, t9 (at the period's first instant); not t8
      // t3 120 + t4 62 + t6 120 + t7 30 = 332 SLA minutes over 4 tickets (t9 was replied before).
      firstReply: { averageMinutes: 83, tickets: 4 },
    });
  });

  it('the breached tile matches hasBreachedSla from @loons/shared on the same tickets', async () => {
    const res = await apiAs(ctx, agentR).get(
      `/tickets?search=${encodeURIComponent(`Reports ${tag}`)}&limit=100`,
    );
    const items = (res.json() as { items: Parameters<typeof hasBreachedSla>[0][] }).items;
    expect(items).toHaveLength(12);
    expect(items.filter((t) => hasBreachedSla(t)).length).toBe(
      (await summary(agentR)).tiles.breached,
    );
  });

  it('open tickets by category: active ones in admin order with zeros, then archived ones with open tickets', async () => {
    const body = await summary(agentR);
    expect(row(body, cat.r1)).toMatchObject({ open: 4, category: { isActive: true } });
    expect(row(body, cat.r2)).toMatchObject({ open: 3 });
    expect(row(body, cat.r3)).toMatchObject({ open: 1, category: { isActive: false } });
    expect(row(body, cat.r4)).toBeUndefined(); // archived, nothing open
    expect(row(body, cat.z)).toMatchObject({ open: 1 }); // t11, assigned to agent R
    // Every active category is listed (zeros included), archived ones after them.
    const firstArchived = body.byCategory.findIndex((r) => !r.category.isActive);
    expect(body.byCategory.slice(0, firstArchived).every((r) => r.category.isActive)).toBe(true);
    expect(body.byCategory.slice(firstArchived).every((r) => !r.category.isActive)).toBe(true);
    const active = await ctx.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { labelEn: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(body.byCategory.slice(0, firstArchived).map((r) => r.category.id)).toEqual(
      active.map((c) => c.id),
    );
    expect(row(body, w.catB.category.id)).toMatchObject({ open: 0 });
  });

  it('numbers are scoped like the Inbox: another team sees only what it can open', async () => {
    const body = await summary(agentZ);
    expect(body.tiles).toEqual({
      open: 1, // t11 (team Z)
      p1Open: 0,
      breached: 0,
      unassigned: 0,
      solved: 0,
      firstReply: { averageMinutes: null, tickets: 0 },
    });
    expect(row(body, cat.r1)).toMatchObject({ open: 0 });
    expect(row(body, cat.r3)).toBeUndefined();
    expect(row(body, cat.z)).toMatchObject({ open: 1 });
    // A super admin sees every ticket: this file's categories count all of their tickets.
    const admin = await summary(w.admin);
    expect(row(admin, cat.r1)?.open).toBe(4);
    expect(row(admin, cat.r2)?.open).toBe(3);
    expect(row(admin, cat.r3)).toMatchObject({ open: 1, category: { isActive: false } });
    expect(admin.tiles.open).toBeGreaterThanOrEqual(9);
    expect(admin.tiles.firstReply.tickets).toBeGreaterThanOrEqual(4);
  });

  it('the period picker: 7 days starts 6 local days before today; t9 and t8 fall outside', async () => {
    const body = await summary(agentR, '?period=7d');
    const today = qatarDate(Date.now());
    expect(body.from).toBe(zonedInstant(addDays(today, -6), '00:00', ZONE).toISOString());
    expect(Date.parse(body.from)).toBe(Date.parse(`${addDays(today, -6)}T00:00:00+03:00`));
    // t7 was solved yesterday; t9 on the 30-day period's first instant.
    expect(body.tiles.solved).toBe(1);
    const ninety = await summary(agentR, '?period=90d');
    expect(ninety.tiles.solved).toBe(3); // t7 t8 t9
    expect(ninety.tiles.firstReply.tickets).toBe(5); // + t9
  });

  it('clients get 403; no token 401; an unknown period 400', async () => {
    expect((await apiAs(ctx, w.clientX).get('/reports/summary')).statusCode).toBe(403);
    expect((await apiAs(ctx).get('/reports/summary')).statusCode).toBe(401);
    expect((await apiAs(ctx, agentR).get('/reports/summary?period=1y')).statusCode).toBe(400);
  });
});

describe('GET /reports/summary: a first reply keeps the SLA clock it was sent on', () => {
  // Authz gap #9: the average first reply used the ticket's current priority and calendar, so a
  // ticket answered as P3 (business hours) and later raised to P1 (24/7) was re-measured in
  // calendar minutes. The FIRST_REPLY event now stores the SLA-clock minutes at the reply.
  let ctx: TestContext;
  let w: World;
  let agent: Persona;
  let category: { category: { id: string }; subtypes: Array<{ id: string }> };
  const tag = rand(4);
  const calendar: BusinessCalendar = {
    timeZone: ZONE,
    hours: [0, 1, 2, 3, 4, 5, 6].map((d) => (d <= 4 ? { open: '07:30', close: '16:30' } : null)),
    holidays: [],
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    const team = await f.team();
    category = await f.category({ teamId: team.id, subtypes: [{ defaultPriority: 'P3' }] });
    await ctx.app.services.ticketConfig.invalidate();
    const user = await f.staff({ staffDomain: ctx.config.staffEmailDomain, name: `Sara ${tag}` });
    await f.member(team.id, user.id);
    agent = await persona(ctx, user);
    const config = ctx.app.services.ticketConfig;
    const realFormConfig = config.getFormConfig.bind(config);
    vi.spyOn(config, 'getCalendar').mockResolvedValue(calendar);
    vi.spyOn(config, 'getFormConfig').mockImplementation(async () => {
      const real = await realFormConfig();
      return {
        ...real,
        slaPolicies: real.slaPolicies.map((p) => ({
          ...p,
          businessHoursOnly: p.priority === 'P3' || p.priority === 'P4',
        })),
      };
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  it('answered as P3 (business minutes), raised to P1 later: still averaged in business minutes', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, {
        subject: `Clock ${tag}`,
        categoryId: category.category.id,
        subtypeId: category.subtypes[0]!.id,
      }),
    );
    const createdAt = new Date(Date.now() - 7 * DAY);
    await ctx.prisma.ticket.update({ where: { id: t.id }, data: { createdAt } });
    const res = await postMessage(ctx, agent, t.id, { body: 'Looking into it now.' });
    expect(res.statusCode, res.body).toBe(201);
    const row = await ctx.prisma.ticket.findUniqueOrThrow({
      where: { id: t.id },
      select: { firstRepliedAt: true, priority: true },
    });
    expect(row.priority).toBe('P3');
    const business = slaMinutesBetween(createdAt, row.firstRepliedAt!, calendar, true);
    const wallClock = slaMinutesBetween(createdAt, row.firstRepliedAt!, calendar, false);
    expect(business).toBeLessThan(wallClock);
    const event = await ctx.prisma.ticketEvent.findFirstOrThrow({
      where: { ticketId: t.id, type: 'FIRST_REPLY' },
    });
    expect(event.meta).toMatchObject({ slaMinutesToFirstReply: business });

    // Raised to P1 (a 24/7 policy) after the reply.
    await ctx.prisma.ticket.update({ where: { id: t.id }, data: { priority: 'P1' } });
    const summary = await apiAs(ctx, agent).get('/reports/summary');
    expect(summary.statusCode, summary.body).toBe(200);
    expect(reportsSummarySchema.parse(summary.json()).tiles.firstReply).toEqual({
      averageMinutes: business,
      tickets: 1,
    });
  });
});
