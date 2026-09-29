import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTicketNumber } from '@loons/shared';
import type { Workers } from '../src/jobs/workers.ts';
import { createEmailProvider, type EmailProvider } from '../src/lib/email/index.ts';
import { escalationJobId } from '../src/lib/job-data.ts';
import { DEAD_LETTER_LIST } from '../src/lib/queues.ts';
import { createTestContext, testEmail, type TestContext } from './helpers.ts';
import { mailpitDeleteTo, mailpitMessage, mailpitTo } from './mailpit.ts';
import { apiAs, createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';
import {
  allJobs,
  fakeSms,
  fakeTeams,
  sleep,
  startTestWorkers,
  testChain,
  waitFor,
} from './worker-helpers.ts';

// The Phase 3 done-when (contract): a P1 produces the team list email, a Teams post and the
// on-call email + SMS, then escalates while nobody acknowledges; acknowledging stops the chain;
// upgrades and downgrades start and cancel it. Real Postgres, Redis and Mailpit (SMTP); SMS and
// Teams go to recording fakes (their NotificationDelivery rows are the evidence). Escalation
// "minutes" last MINUTE_MS here, so the 5- and 15-minute steps fire in seconds.

const MINUTE_MS = 300;

describe('P1 notifications and escalation', () => {
  let ctx: TestContext;
  let w: World;
  let workers: Workers;
  let smtp: EmailProvider;
  const sms = fakeSms();
  const teams = fakeTeams();
  const listA = testEmail();
  const listB = testEmail();
  const phones = { agentA: '', leadA: '', admin: '', agentB: '' };

  const deliveriesOf = (ticketId: string) =>
    ctx.prisma.notificationDelivery.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    const digits = () => String(Math.floor(1000 + Math.random() * 9000));
    // Stored with spaces like the demo data: the worker sends E.164.
    phones.agentA = `+974 5551 ${digits()}`;
    phones.leadA = `+974 5552 ${digits()}`;
    phones.admin = `00974 5553 ${digits()}`;
    phones.agentB = `+974 5554 ${digits()}`;
    for (const [persona, phone] of [
      [w.agentA, phones.agentA],
      [w.leadA, phones.leadA],
      [w.admin, phones.admin],
      [w.agentB, phones.agentB],
    ] as const) {
      await ctx.prisma.user.update({ where: { id: persona.id }, data: { phone } });
    }
    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { emails: [listA], onCallUserId: w.agentA.id },
    });
    await ctx.prisma.team.update({
      where: { id: w.teamB.id },
      data: { emails: [listB], onCallUserId: w.agentB.id },
    });
    // Team A: the seeded shape (0 / 5 / 15). Team B: a slower chain (0 / 30 / 60 = 9 s / 18 s),
    // so a test can act between step 1 and step 2 without racing the clock.
    await testChain(ctx, w.teamA.id, w.admin.id);
    await testChain(ctx, w.teamB.id, w.admin.id, [
      {},
      { targetType: 'USER', targetRole: null, targetUserId: w.admin.id, afterMins: 30 },
      { afterMins: 60 },
    ]);
    smtp = createEmailProvider(ctx.config); // SMTP → Mailpit
    workers = await startTestWorkers(ctx, {
      emailProvider: smtp,
      smsProvider: sms.provider,
      teamsProvider: teams.provider,
      escalationMinuteMs: MINUTE_MS,
    });
  });

  afterAll(async () => {
    await workers?.close();
    await smtp?.close();
    await mailpitDeleteTo([
      listA,
      listB,
      w.agentA.email,
      w.leadA.email,
      w.admin.email,
      w.agentB.email,
      w.clientX.email,
    ]).catch(() => undefined);
    await ctx.close();
  });

  it('a P1 ⇒ team list email, one Teams card, the on-call email + SMS; then steps 2 and 3 fire while unacknowledged', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    expect(t.priority).toBe('P1');
    const ref = formatTicketNumber(t.number);

    // Step 1 and the "created" fan-out.
    const first = await waitFor(
      async () => {
        const rows = await deliveriesOf(t.id);
        const sent = new Set(
          rows.filter((r) => r.status === 'SENT').map((r) => `${r.templateKey}/${r.channel}`),
        );
        const expected = [
          'TICKET_CREATED_CLIENT/EMAIL',
          'TICKET_CREATED_TEAM/EMAIL',
          'P1_CREATED/TEAMS',
          'P1_ALERT/EMAIL',
          'P1_ALERT/SMS',
        ];
        return expected.every((k) => sent.has(k)) ? rows : null;
      },
      { what: 'the P1 fan-out' },
    );
    const find = (template: string, channel: string, userId?: string) =>
      first.filter(
        (d) =>
          d.templateKey === template &&
          d.channel === channel &&
          (userId === undefined || d.userId === userId),
      );
    expect(find('TICKET_CREATED_CLIENT', 'EMAIL', w.clientX.id)).toHaveLength(1);
    const list = find('TICKET_CREATED_TEAM', 'EMAIL');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ recipientMasked: listA, teamId: w.teamA.id, status: 'SENT' });
    const card = find('P1_CREATED', 'TEAMS');
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({
      recipientMasked: 'console',
      status: 'SENT',
      teamId: w.teamA.id,
    });
    expect(find('P1_ALERT', 'EMAIL', w.agentA.id)).toHaveLength(1);
    const text = find('P1_ALERT', 'SMS', w.agentA.id);
    expect(text).toHaveLength(1);
    // The phone number is masked in the log.
    expect(text[0]!.recipientMasked).toMatch(/^\+974\*+\d{2}$/);
    expect(text[0]!.recipientMasked).not.toContain(phones.agentA.replace(/\s/g, '').slice(4, 10));

    // What went out: E.164, no subject or client name in the text, console links only.
    const sent = sms.sent.find((m) => m.to === phones.agentA.replace(/\s/g, ''));
    expect(sent?.body).toContain(ref);
    expect(sent?.body).toContain(`/console/inbox?ticket=${ref}`);
    expect(sent?.body).not.toContain(t.subject as string);
    const post = teams.posts.find((p) =>
      JSON.stringify(p.message).includes(`P1 critical ticket · ${ref}`),
    );
    expect(post?.webhookUrl).toBeNull();
    const actions = post!.message.attachments[0].content.actions.map((a) => a.url);
    expect(actions.every((u) => u.endsWith(`/console/inbox?ticket=${ref}`))).toBe(true);

    // Real email (Mailpit): the list and the on-call engineer.
    await expect
      .poll(async () => (await mailpitTo(listA)).map((m) => m.Subject), { timeout: 15_000 })
      .toContainEqual(expect.stringContaining(`[${ref}] New P1 Critical ticket`));
    const alerts = await waitFor(async () => {
      const found = (await mailpitTo(w.agentA.email)).filter((m) => m.Subject.includes(ref));
      return found.length ? found : null;
    });
    expect(alerts[0]!.Subject).toContain(`P1 CRITICAL [${ref}]`);
    const alert = await mailpitMessage(alerts[0]!.ID);
    expect(alert.HTML).toContain(`/console/inbox?ticket=${ref}`);
    expect(alert.HTML).not.toContain('/acknowledge');

    // In-app for the on-call engineer; the step is recorded once.
    const inApp = await ctx.prisma.notification.findMany({ where: { ticketId: t.id } });
    expect(inApp.filter((n) => n.userId === w.agentA.id && n.type === 'P1_CREATED')).toHaveLength(
      1,
    );

    // Not acknowledged: step 2 (team lead, "escalated" card) then step 3 (manager, no Teams).
    const all = await waitFor(
      async () => {
        const rows = await deliveriesOf(t.id);
        const done = rows.filter(
          (d) =>
            d.userId === w.admin.id && d.templateKey === 'P1_ESCALATION' && d.status === 'SENT',
        );
        return done.length === 2 ? rows : null;
      },
      { what: 'step 3', timeout: 20_000 },
    );
    const byStep = (userId: string) =>
      all.filter((d) => d.userId === userId && d.templateKey === 'P1_ESCALATION');
    expect(
      byStep(w.leadA.id)
        .map((d) => d.channel)
        .sort(),
    ).toEqual(['EMAIL', 'SMS']);
    expect(
      byStep(w.admin.id)
        .map((d) => d.channel)
        .sort(),
    ).toEqual(['EMAIL', 'SMS']);
    expect(
      all
        .filter((d) => d.channel === 'TEAMS')
        .map((d) => d.templateKey)
        .sort(),
    ).toEqual(['P1_CREATED', 'P1_ESCALATED']);
    // The manager's number was stored with the 00 prefix: sent as E.164.
    expect(sms.sent.some((m) => m.to === phones.admin.replace(/\s/g, '').replace(/^00/, '+'))).toBe(
      true,
    );
    const ticket = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(ticket.p1EscalationStep).toBe(3);
    const events = await ctx.prisma.ticketEvent.findMany({
      where: { ticketId: t.id, type: 'ESCALATED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.toValue)).toEqual(['1', '2', '3']);
    expect(events.every((e) => e.actorId === null)).toBe(true);
    const escalated = await ctx.prisma.notification.findMany({
      where: { ticketId: t.id, type: 'P1_ESCALATED' },
    });
    expect(escalated.map((n) => n.userId).sort()).toEqual([w.admin.id, w.leadA.id].sort());
    expect(await mailpitTo(w.leadA.email)).toContainEqual(
      expect.objectContaining({ Subject: expect.stringContaining(`ESCALATION (step 2)`) }),
    );
    // End of the chain: nothing left in the escalation queue for this ticket.
    const pending = (await allJobs(ctx.queues.escalation)).filter(
      (j) => j.data.ticketId === t.id && !j.finishedOn,
    );
    expect(pending).toHaveLength(0);
  });

  it('acknowledging stops the chain: later steps never fire, and those already paged are told', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, {
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
        priority: 'P1',
      }),
    );
    await waitFor(
      async () =>
        (await deliveriesOf(t.id)).some(
          (d) => d.channel === 'SMS' && d.userId === w.agentB.id && d.status === 'SENT',
        ),
      { what: 'step 1 SMS' },
    );
    const detail = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    const step2 = escalationJobId(t.id, detail.p1Since!, 2);
    // Step 1 scheduled step 2 (30 "minutes" after p1Since).
    await waitFor(async () => ctx.queues.escalation.getJob(step2), { what: 'the step 2 job' });

    const res = await apiAs(ctx, w.admin).post(`/tickets/${t.id}/acknowledge`);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyAcknowledged).toBe(false);
    // The pending step is cancelled right away (best effort) …
    expect(await ctx.queues.escalation.getJob(step2)).toBeUndefined();
    // … and a step job that fires anyway (e.g. enqueued twice) does nothing.
    await ctx.queues.scheduleEscalation(
      { ticketId: t.id, p1Since: detail.p1Since!.toISOString(), step: 2 },
      0,
    );
    const forced = await waitFor(async () => {
      const job = await ctx.queues.escalation.getJob(step2);
      return job?.finishedOn ? job : null;
    });
    expect(forced.returnvalue).toEqual({ skipped: 'acknowledged' });
    await sleep(500);
    const rows = await deliveriesOf(t.id);
    expect(rows.filter((d) => d.templateKey === 'P1_ESCALATION')).toHaveLength(0);
    const after = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.p1EscalationStep).toBe(1);
    expect(after.p1AckedById).toBe(w.admin.id);
    // The on-call engineer (paged at step 1) gets an in-app "acknowledged by …".
    const acked = await waitFor(async () => {
      const found = await ctx.prisma.notification.findMany({
        where: { ticketId: t.id, type: 'P1_ACKNOWLEDGED' },
      });
      return found.length ? found : null;
    });
    expect(acked.map((n) => n.userId)).toEqual([w.agentB.id]);
    expect(acked[0]!.data).toMatchObject({ actor: { id: w.admin.id, name: 'Ada Admin' } });
  });

  it('upgrade to P1 starts a period (list alert + card + step 1); downgrade cancels it; a new upgrade starts over', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { categoryId: w.catB.category.id, subtypeId: w.catB.subtypes[0]!.id }),
    );
    expect(t.priority).toBe('P2');
    await waitFor(async () =>
      (await deliveriesOf(t.id)).some((d) => d.templateKey === 'TICKET_CREATED_TEAM'),
    );
    const agent = apiAs(ctx, w.agentB);
    const up = await agent.patch(`/tickets/${t.id}`, { priority: 'P1' });
    expect(up.statusCode).toBe(200);
    const p1Since = up.json().ticket.p1Since as string;
    expect(p1Since).toBeTruthy();

    const rows = await waitFor(
      async () => {
        const all = await deliveriesOf(t.id);
        const sent = (template: string, channel: string) =>
          all.filter(
            (d) => d.templateKey === template && d.channel === channel && d.status === 'SENT',
          ).length;
        return sent('P1_ALERT', 'EMAIL') === 2 &&
          sent('P1_CREATED', 'TEAMS') === 1 &&
          sent('P1_ALERT', 'SMS') === 1
          ? all
          : null;
      },
      { what: 'the upgrade fan-out' },
    );
    // The list gets the P1 alert (greeting-less), the channel one card, the on-call the page.
    expect(
      rows
        .filter((d) => d.templateKey === 'P1_ALERT' && d.channel === 'EMAIL')
        .map((d) => d.recipientMasked)
        .sort(),
    ).toEqual([listB, w.agentB.email].sort());
    expect(rows.filter((d) => d.channel === 'TEAMS')).toHaveLength(1);
    expect(rows.filter((d) => d.channel === 'SMS' && d.userId === w.agentB.id)).toHaveLength(1);
    const listAlert = await waitFor(async () => {
      const found = (await mailpitTo(listB)).filter((m) => m.Subject.startsWith('P1 CRITICAL'));
      return found.length ? found[0] : null;
    });
    expect((await mailpitMessage(listAlert.ID)).Text).not.toMatch(/^Hi /m);

    // Downgrade: the pending step 2 job goes, and a step of that period that fires anyway does
    // nothing.
    const step2 = escalationJobId(t.id, p1Since, 2);
    await waitFor(async () => ctx.queues.escalation.getJob(step2), { what: 'the step 2 job' });
    const down = await agent.patch(`/tickets/${t.id}`, { priority: 'P2' });
    expect(down.statusCode).toBe(200);
    expect(down.json().ticket.p1Since).toBeNull();
    expect(await ctx.queues.escalation.getJob(step2)).toBeUndefined();
    await ctx.queues.scheduleEscalation({ ticketId: t.id, p1Since, step: 2 }, 0);
    const forced = await waitFor(async () => {
      const job = await ctx.queues.escalation.getJob(step2);
      return job?.finishedOn ? job : null;
    });
    expect(forced.returnvalue).toEqual({ skipped: 'not-p1' });
    await sleep(300);
    expect(
      (await deliveriesOf(t.id)).filter((d) => d.templateKey === 'P1_ESCALATION'),
    ).toHaveLength(0);

    // A new upgrade is a new period: step 1 pages again (new dedupe keys).
    const again = await agent.patch(`/tickets/${t.id}`, { priority: 'P1' });
    expect(again.json().ticket.p1Since).not.toBe(p1Since);
    await waitFor(
      async () =>
        (await deliveriesOf(t.id)).filter(
          (d) => d.channel === 'SMS' && d.userId === w.agentB.id && d.status === 'SENT',
        ).length === 2,
      { what: 'the second period step 1' },
    );
    expect((await deliveriesOf(t.id)).filter((d) => d.channel === 'TEAMS')).toHaveLength(2);
    // A step of the first period that fires now belongs to a period that is over.
    const stale = escalationJobId(t.id, p1Since, 3);
    await ctx.queues.scheduleEscalation({ ticketId: t.id, p1Since, step: 3 }, 0);
    const old = await waitFor(async () => {
      const job = await ctx.queues.escalation.getJob(stale);
      return job?.finishedOn ? job : null;
    });
    expect(old.returnvalue).toEqual({ skipped: 'p1-period-moved' });
    await apiAs(ctx, w.agentB).post(`/tickets/${t.id}/acknowledge`);
  });

  it('jobs for a ticket that no longer exists complete as no-ops (never dead-lettered)', async () => {
    const ticketId = randomUUID();
    const p1Since = new Date().toISOString();
    await ctx.queues.enqueueEvent({ event: 'ticket-created', ticketId });
    await ctx.queues.enqueueEvent({ event: 'client-reply', ticketId, messageId: randomUUID() });
    await ctx.queues.scheduleEscalation({ ticketId, p1Since, step: 1 }, 0);
    await ctx.queues.enqueueDelivery({
      dedupeKey: `test-${ticketId}`,
      channel: 'EMAIL',
      template: 'TICKET_CREATED_CLIENT',
      ticketId,
    });
    const done = await waitFor(async () => {
      const jobs = [
        ...(await allJobs(ctx.queues.notifications)),
        ...(await allJobs(ctx.queues.escalation)),
      ].filter((j) => JSON.stringify(j.data).includes(ticketId));
      return jobs.length === 4 && jobs.every((j) => j.finishedOn) ? jobs : null;
    });
    expect(done.every((j) => !j.failedReason)).toBe(true);
    expect(
      done
        .map((j) => j.returnvalue)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { skipped: 'delivery-gone' },
      { skipped: 'ticket-gone' },
      { skipped: 'ticket-gone' },
      { skipped: 'ticket-gone' },
    ]);
    expect(await ctx.redis.llen(`${ctx.queues.prefix}:${DEAD_LETTER_LIST}`)).toBe(0);
  });
});
