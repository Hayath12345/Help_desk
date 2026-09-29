import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@loons/db';
import { registerSchedulers } from '../src/jobs/schedulers.ts';
import type { Workers } from '../src/jobs/workers.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { createWorld, type World } from './ticket-world.ts';
import {
  allJobs,
  fakeEmail,
  fakeSms,
  fakeTeams,
  startTestWorkers,
  testChain,
  testPhone,
  waitFor,
} from './worker-helpers.ts';

// Decision D10: a worker started against a database full of old, long-overdue tickets (like the
// seeded demo data: no at-risk instants, an unacknowledged P1 without a P1 period, a ticket
// solved a week ago) flags every crossed threshold and closes what is due, but sends nothing:
// no email, text, Teams post, in-app notification or escalation. The real schedulers run here
// (scoped to the test team through their job data).

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('historical safety (D10)', () => {
  let ctx: TestContext;
  let w: World;
  let workers: Workers;
  const email = fakeEmail();
  const sms = fakeSms();
  const teams = fakeTeams();

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    // Everything a page would need is in place: on-call, list, phones, a chain.
    await ctx.prisma.user.update({ where: { id: w.agentA.id }, data: { phone: testPhone() } });
    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { emails: ['t-hist@test-hist.example'], onCallUserId: w.agentA.id },
    });
    await testChain(ctx, w.teamA.id, w.admin.id);
  });
  afterAll(async () => {
    await workers?.close();
    await ctx.close();
  });

  async function oldTicket(daysAgo: number, data: Partial<Prisma.TicketUncheckedCreateInput>) {
    const createdAt = new Date(Date.now() - daysAgo * DAY);
    const plus = (m: number) => new Date(createdAt.getTime() + m * MIN);
    return ctx.prisma.ticket.create({
      data: {
        type: 'INCIDENT',
        subject: 'Historical ticket',
        description: 'x',
        categoryId: w.catA.category.id,
        subtypeId: w.catA.subtypes[1]!.id,
        priority: 'P1',
        status: 'OPEN',
        orgId: w.orgX.id,
        siteId: w.siteX1.id,
        requesterId: w.clientX.id,
        teamId: w.teamA.id,
        assigneeId: w.agentA.id,
        createdAt,
        // Seeded style: due dates, no at-risk instants, no P1 period.
        firstReplyDueAt: plus(15),
        resolveDueAt: plus(240),
        ...data,
      },
    });
  }

  it('flags old crossings and closes what is due, but pages, emails and notifies nobody', async () => {
    const p1 = await oldTicket(2, {});
    const p3 = await oldTicket(3, {
      priority: 'P3',
      subtypeId: w.catA.subtypes[0]!.id,
      status: 'NEW',
      assigneeId: null,
      firstReplyDueAt: new Date(Date.now() - 3 * DAY + 240 * MIN),
      resolveDueAt: new Date(Date.now() - DAY),
    });
    const solved = await oldTicket(9, {
      priority: 'P4',
      subtypeId: w.catA.subtypes[3]!.id,
      status: 'SOLVED',
      firstRepliedAt: new Date(Date.now() - 8 * DAY),
      solvedAt: new Date(Date.now() - 7 * DAY),
    });
    const ids = [p1.id, p3.id, solved.id];

    workers = await startTestWorkers(ctx, {
      emailProvider: email.provider,
      smsProvider: sms.provider,
      teamsProvider: teams.provider,
    });
    await registerSchedulers(ctx.queues.sla, {
      timeZone: 'Asia/Qatar',
      digestTime: '07:30',
      data: { teamIds: [w.teamA.id] },
    });

    // The first scan and auto-close run right away.
    await waitFor(
      async () => {
        const [signals, closed] = await Promise.all([
          ctx.prisma.ticketSlaSignal.count({ where: { ticketId: { in: [p1.id, p3.id] } } }),
          ctx.prisma.ticket.count({ where: { id: solved.id, status: 'CLOSED' } }),
        ]);
        return signals >= 4 && closed === 1;
      },
      { what: 'the first scan and auto-close', timeout: 20_000 },
    );

    const rows = await ctx.prisma.ticket.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Flagged (and backfilled) …
    for (const id of [p1.id, p3.id]) {
      expect(byId.get(id)).toMatchObject({ slaBreached: true });
      expect(byId.get(id)!.firstReplyAtRiskAt).not.toBeNull();
      expect(byId.get(id)!.slaAtRiskAt).not.toBeNull();
    }
    expect(
      await ctx.prisma.ticketEvent.count({
        where: { ticketId: { in: [p1.id, p3.id] }, type: 'SLA_BREACHED', actorId: null },
      }),
    ).toBeGreaterThanOrEqual(2);
    // … closed silently …
    expect(byId.get(solved.id)).toMatchObject({ status: 'CLOSED' });
    expect(byId.get(solved.id)!.closedAt).not.toBeNull();
    expect(
      await ctx.prisma.ticketEvent.count({ where: { ticketId: solved.id, type: 'AUTO_CLOSED' } }),
    ).toBe(1);
    // … and the P1 without a P1 period is never escalated.
    expect(byId.get(p1.id)).toMatchObject({ p1EscalationStep: 0, p1Since: null });

    // Nothing was sent or queued to be sent.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await ctx.prisma.notificationDelivery.count({ where: { ticketId: { in: ids } } })).toBe(
      0,
    );
    expect(await ctx.prisma.notification.count({ where: { ticketId: { in: ids } } })).toBe(0);
    expect(await allJobs(ctx.queues.notifications)).toHaveLength(0);
    expect(await allJobs(ctx.queues.escalation)).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
    expect(teams.posts).toHaveLength(0);
  });
});
