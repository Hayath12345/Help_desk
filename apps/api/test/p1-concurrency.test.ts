import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryJob } from '../src/lib/job-data.ts';
import { DeliveryBusyError, processDelivery } from '../src/jobs/deliver.ts';
import { processEscalationStep } from '../src/jobs/escalation.ts';
import type { Workers } from '../src/jobs/workers.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';
import {
  fakeEmail,
  fakeSms,
  fakeTeams,
  startTestWorkers,
  testChain,
  testPhone,
  testWorkerContext,
  waitFor,
} from './worker-helpers.ts';

// Two workers on the same queues never send anything twice (D15): BullMQ hands each job to one
// worker, the escalation step is claimed with a conditional update, deliveries are unique rows
// with a per-delivery lock, and in-app notifications have a dedupe key.

const MINUTE_MS = 100;

describe('two concurrent workers', () => {
  let ctx: TestContext;
  let w: World;
  const email = fakeEmail();
  const sms = fakeSms();
  const teams = fakeTeams();
  let one: Workers;
  let two: Workers;
  const phones = new Map<string, string>();

  beforeAll(async () => {
    ctx = await createTestContext({ deps: { escalationMinuteMs: MINUTE_MS } });
    w = await createWorld(ctx);
    for (const persona of [w.agentA, w.leadA, w.admin]) {
      const phone = testPhone();
      phones.set(persona.id, phone);
      await ctx.prisma.user.update({ where: { id: persona.id }, data: { phone } });
    }
    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { emails: [`t-list-${w.teamA.key}@test-list.example`], onCallUserId: w.agentA.id },
    });
    await testChain(ctx, w.teamA.id, w.admin.id);
    const options = {
      emailProvider: email.provider,
      smsProvider: sms.provider,
      teamsProvider: teams.provider,
      escalationMinuteMs: MINUTE_MS,
      concurrency: { notifications: 10, escalation: 10 },
    };
    one = await startTestWorkers(ctx, options);
    two = await startTestWorkers(ctx, options);
  });

  afterAll(async () => {
    await one?.close();
    await two?.close();
    await ctx.close();
  });

  it('a full P1 chain through two workers sends every email / text / card exactly once', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    const rows = await waitFor(
      async () => {
        const all = await ctx.prisma.notificationDelivery.findMany({ where: { ticketId: t.id } });
        const pending = all.filter((d) => d.status !== 'SENT');
        const step3 = all.filter(
          (d) => d.userId === w.admin.id && d.templateKey === 'P1_ESCALATION',
        );
        return step3.length === 2 && pending.length === 0 ? all : null;
      },
      { what: 'the whole chain', timeout: 20_000 },
    );
    // 2 created emails + card + step 1 (email, SMS) + step 2 (email, SMS, card) + step 3 (email, SMS).
    expect(rows).toHaveLength(10);
    expect(rows.every((d) => d.attempts === 1)).toBe(true);
    const sentTo = (address: string) => email.sent.filter((m) => m.to === address).length;
    for (const d of rows.filter((r) => r.channel === 'EMAIL')) {
      expect(sentTo(d.recipientMasked), d.templateKey).toBe(
        rows.filter((r) => r.channel === 'EMAIL' && r.recipientMasked === d.recipientMasked).length,
      );
    }
    const ticketTexts = sms.sent.filter((m) => m.body.includes(`LG-${t.number} `));
    expect(ticketTexts).toHaveLength(3);
    const cards = teams.posts.filter((p) => JSON.stringify(p.message).includes(`LG-${t.number}`));
    expect(cards).toHaveLength(2);
    const events = await ctx.prisma.ticketEvent.findMany({
      where: { ticketId: t.id, type: 'ESCALATED' },
    });
    expect(events.map((e) => e.toValue).sort()).toEqual(['1', '2', '3']);
    const inApp = await ctx.prisma.notification.findMany({ where: { ticketId: t.id } });
    expect(inApp.map((n) => `${n.type}:${n.userId}`).sort()).toEqual(
      [
        `P1_CREATED:${w.agentA.id}`,
        `P1_ESCALATED:${w.leadA.id}`,
        `P1_ESCALATED:${w.admin.id}`,
      ].sort(),
    );
  });

  it('the same step or delivery run by two workers at once is done once', async () => {
    // A P3 made P1 behind the API's back: no job was scheduled, the test runs the step itself.
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const p1Since = new Date();
    await ctx.prisma.ticket.update({ where: { id: t.id }, data: { priority: 'P1', p1Since } });
    const c1 = testWorkerContext(ctx, { emailProvider: email.provider, smsProvider: sms.provider });
    const c2 = testWorkerContext(ctx, { emailProvider: email.provider, smsProvider: sms.provider });
    const job = { ticketId: t.id, p1Since: p1Since.toISOString(), step: 1 };
    const results = await Promise.all([
      processEscalationStep(c1, job),
      processEscalationStep(c2, job),
    ]);
    expect(results.filter((r) => 'step' in r).length).toBeGreaterThanOrEqual(1);
    const events = await ctx.prisma.ticketEvent.findMany({
      where: { ticketId: t.id, type: 'ESCALATED' },
    });
    expect(events).toHaveLength(1);

    const row = await waitFor(() =>
      ctx.prisma.notificationDelivery.findFirst({
        where: { ticketId: t.id, channel: 'SMS', userId: w.agentA.id },
      }),
    );
    const delivery: DeliveryJob = {
      dedupeKey: row.dedupeKey,
      channel: 'SMS',
      template: 'P1_ALERT',
      ticketId: t.id,
      userId: w.agentA.id,
      context: { p1Since: p1Since.toISOString(), step: 1 },
    };
    const settled = await Promise.allSettled([
      processDelivery(c1, delivery),
      processDelivery(c2, delivery),
      processDelivery(c1, delivery),
    ]);
    // A run that finds the delivery locked fails retryably (BullMQ retries it later).
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(DeliveryBusyError);
    }
    const outcomes = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    // Either this call or the running workers sent it — once in all.
    await waitFor(async () => {
      const r = await ctx.prisma.notificationDelivery.findUnique({ where: { id: row.id } });
      return r?.status === 'SENT';
    });
    expect(outcomes.filter((o) => 'status' in o && o.status === 'SENT').length).toBeLessThanOrEqual(
      1,
    );
    const texts = sms.sent.filter(
      (m) => m.to === phones.get(w.agentA.id) && m.body.includes(`LG-${t.number} `),
    );
    expect(texts).toHaveLength(1);
  });
});
