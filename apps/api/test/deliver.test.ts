import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerContext } from '../src/jobs/context.ts';
import { queueDeliveries } from '../src/jobs/context.ts';
import { DeliveryBusyError, processDelivery } from '../src/jobs/deliver.ts';
import { processNotificationEvent } from '../src/jobs/events.ts';
import type { DeliveryJobInput } from '../src/lib/job-data.ts';
import { deliveryJobSchema } from '../src/lib/job-data.ts';
import { createSmsCap } from '../src/lib/sms-cap.ts';
import { createWebhookTeamsProvider } from '../src/lib/teams/webhook.ts';
import { createTestContext, testEmail, type TestContext } from './helpers.ts';
import { createTicket, createWorld, postMessage, ticketBody, type World } from './ticket-world.ts';
import { fakeEmail, fakeSms, testPhone, testWorkerContext } from './worker-helpers.ts';

// One delivery per channel × recipient (D15), its NotificationDelivery log and the reasons to
// skip one: no usable address / number, the SMS cap (D11), a Teams webhook that is missing or
// not allowed (D12), a P1 that was acknowledged meanwhile — and never an internal note.

describe('deliveries', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;
  const email = fakeEmail();
  const sms = fakeSms();

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    worker = testWorkerContext(ctx, {
      emailProvider: email.provider,
      smsProvider: sms.provider,
      smsCap: createSmsCap({
        redis: ctx.redis,
        prefix: ctx.config.redisPrefix,
        max: 2,
        perScopeMax: 2,
      }),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Records the row (QUEUED) and runs the delivery once. */
  async function deliver(job: DeliveryJobInput, recipientMasked = 'x') {
    await queueDeliveries(worker, [{ job, recipientMasked }]);
    return processDelivery(worker, deliveryJobSchema.parse(job));
  }
  const row = (dedupeKey: string) =>
    ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { dedupeKey } });
  const key = () => `test-${randomUUID()}`;

  it('agent reply → the requester, in their language, with the message kept as written', async () => {
    await ctx.prisma.user.update({ where: { id: w.clientX.id }, data: { locale: 'ar' } });
    try {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      const reply = await postMessage(ctx, w.agentA, t.id, {
        body: 'First paragraph.\n\nSee https://evil.example/x — second paragraph.',
      });
      const messageId = reply.json().message.id;
      const [job] = (await ctx.queues.notifications.getJobs(['waiting'])).filter(
        (j) => j.id === `agent-reply-${messageId}`,
      );
      await processNotificationEvent(worker, job!.data as never);
      const delivery = await ctx.prisma.notificationDelivery.findFirstOrThrow({
        where: { ticketId: t.id, templateKey: 'AGENT_REPLY_CLIENT' },
      });
      const result = await processDelivery(
        worker,
        deliveryJobSchema.parse({
          dedupeKey: delivery.dedupeKey,
          channel: 'EMAIL',
          template: 'AGENT_REPLY_CLIENT',
          ticketId: t.id,
          userId: w.clientX.id,
          context: { messageId },
        }),
      );
      expect(result).toEqual({ status: 'SENT' });
      const mail = email.sent.find((m) => m.to === w.clientX.email)!;
      expect(mail.subject).toContain('رد جديد من دعم لونز');
      expect(mail.html).toContain('dir="rtl"');
      expect(mail.text).toContain('First paragraph.');
      expect(mail.text).toContain('second paragraph.');
      // Written links are never made clickable; the button goes to the portal.
      expect(mail.html).not.toContain('href="https://evil.example');
      expect(mail.html).toContain(`/tickets/LG-${t.number}`);
      expect(await row(delivery.dedupeKey)).toMatchObject({ status: 'SENT', attempts: 1 });
      expect((await row(delivery.dedupeKey)).sentAt).not.toBeNull();
      // Done is done.
      expect(
        await processDelivery(
          worker,
          deliveryJobSchema.parse({
            dedupeKey: delivery.dedupeKey,
            channel: 'EMAIL',
            template: 'AGENT_REPLY_CLIENT',
            ticketId: t.id,
            userId: w.clientX.id,
            context: { messageId },
          }),
        ),
      ).toEqual({ skipped: 'already-done' });
    } finally {
      await ctx.prisma.user.update({ where: { id: w.clientX.id }, data: { locale: 'en' } });
    }
  });

  it('an internal note is never emailed, even through a crafted job', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const note = await postMessage(ctx, w.agentA, t.id, {
      type: 'INTERNAL',
      body: 'INTERNAL SECRET',
    });
    const messageId = note.json().message.id;
    // The fan-out refuses it …
    expect(
      await processNotificationEvent(worker, { event: 'agent-reply', ticketId: t.id, messageId }),
    ).toEqual({ skipped: 'not-a-staff-public-reply' });
    // … and so does the delivery.
    const k = key();
    const before = email.sent.length;
    expect(
      await deliver({
        dedupeKey: k,
        channel: 'EMAIL',
        template: 'AGENT_REPLY_CLIENT',
        ticketId: t.id,
        userId: w.clientX.id,
        context: { messageId },
      }),
    ).toMatchObject({ status: 'SKIPPED' });
    expect(email.sent.length).toBe(before);
    expect(JSON.stringify(email.sent)).not.toContain('INTERNAL SECRET');
    expect((await row(k)).status).toBe('SKIPPED');
  });

  it('SMS: E.164 from the stored number, masked in the log, capped per number per hour (D11)', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    const phone = testPhone();
    await ctx.prisma.user.update({
      where: { id: w.agentA2.id },
      data: { phone: `${phone.slice(0, 4)} ${phone.slice(4, 8)} ${phone.slice(8)}` },
    });
    const sms1 = {
      channel: 'SMS',
      template: 'P1_ALERT',
      ticketId: t.id,
      userId: w.agentA2.id,
    } as const;
    const outcomes = [];
    const keys = [key(), key(), key()];
    for (const k of keys) outcomes.push(await deliver({ dedupeKey: k, ...sms1 }));
    expect(outcomes.map((o) => ('status' in o ? o.status : o.skipped))).toEqual([
      'SENT',
      'SENT',
      'SKIPPED',
    ]);
    expect(sms.sent.filter((m) => m.to === phone)).toHaveLength(2);
    expect((await row(keys[2]!)).error).toMatch(/SMS cap/);
    // A retry of a delivery that already counted is not counted twice.
    await ctx.prisma.notificationDelivery.update({
      where: { dedupeKey: keys[0]! },
      data: { status: 'FAILED' },
    });
    expect(
      await processDelivery(worker, deliveryJobSchema.parse({ dedupeKey: keys[0]!, ...sms1 })),
    ).toEqual({
      status: 'SENT',
    });

    // No international number: skipped (the email still goes on its own delivery).
    await ctx.prisma.user.update({ where: { id: w.leadA.id }, data: { phone: '5550 1234' } });
    const k = key();
    expect(await deliver({ dedupeKey: k, ...sms1, userId: w.leadA.id })).toMatchObject({
      status: 'SKIPPED',
    });
    expect((await row(k)).error).toMatch(/E\.164/);
  });

  it("one organisation's P1s use at most their share of a number's texts; another org still pages", async () => {
    const orgCap = testWorkerContext(ctx, {
      smsProvider: sms.provider,
      smsCap: createSmsCap({
        redis: ctx.redis,
        prefix: ctx.config.redisPrefix,
        max: 3,
        perScopeMax: 2,
      }),
    });
    const phone = testPhone();
    await ctx.prisma.user.update({ where: { id: w.agentB.id }, data: { phone } });
    const flood = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    const page = (ticketId: string) => {
      const job = {
        dedupeKey: key(),
        channel: 'SMS',
        template: 'P1_ALERT',
        ticketId,
        userId: w.agentB.id,
      } as const;
      return queueDeliveries(orgCap, [{ job, recipientMasked: 'x' }]).then(async () => ({
        key: job.dedupeKey,
        result: await processDelivery(orgCap, deliveryJobSchema.parse(job)),
      }));
    };
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push(await page(flood.id));
    expect(outcomes.map((o) => ('status' in o.result ? o.result.status : ''))).toEqual([
      'SENT',
      'SENT',
      'SKIPPED',
    ]);
    expect((await row(outcomes[2]!.key)).error).toMatch(/organisation/);
    // A P1 from another organisation still reaches the same number.
    const other = await ctx.prisma.ticket.update({
      where: { id: (await createTicket(ctx, w.clientX, ticketBody(w))).id },
      data: { orgId: w.orgY.id, priority: 'P1', p1Since: new Date() },
    });
    expect((await page(other.id)).result).toEqual({ status: 'SENT' });
    // The number's own cap (3) still holds for everyone.
    const fourth = await page(other.id);
    expect(fourth.result).toMatchObject({ status: 'SKIPPED' });
    expect((await row(fourth.key)).error).toMatch(/SMS_MAX_PER_RECIPIENT_PER_HOUR/);
    expect(sms.sent.filter((m) => m.to === phone)).toHaveLength(3);
  });

  it('P1 emails give durations in the reader’s language (built-in wording)', async () => {
    // The built-in defaults (no stored template row): the dev database keeps its seeded rows.
    const builtIn: WorkerContext = {
      ...worker,
      prisma: new Proxy(ctx.prisma, {
        get: (target, prop) =>
          prop === 'emailTemplate' ? { findUnique: async () => null } : Reflect.get(target, prop),
      }),
    };
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { p1Since: new Date(Date.now() - 7 * 60_000) },
    });
    await ctx.prisma.user.update({ where: { id: w.agentA2.id }, data: { locale: 'ar' } });
    try {
      const alert = {
        dedupeKey: key(),
        channel: 'EMAIL',
        template: 'P1_ALERT',
        ticketId: t.id,
        userId: w.agentA2.id,
        context: { step: 1, escalationMins: 5 },
      } as const;
      await queueDeliveries(builtIn, [{ job: alert, recipientMasked: 'x' }]);
      expect(await processDelivery(builtIn, deliveryJobSchema.parse(alert))).toEqual({
        status: 'SENT',
      });
      const ar = email.sent.find((m) => m.to === w.agentA2.email && m.subject.includes('P1'))!;
      expect(ar.text).toContain('خلال 5 دقائق،');
      const escalation = {
        dedupeKey: key(),
        channel: 'EMAIL',
        template: 'P1_ESCALATION',
        ticketId: t.id,
        userId: w.leadA.id,
        context: { step: 2 },
      } as const;
      await queueDeliveries(builtIn, [{ job: escalation, recipientMasked: 'x' }]);
      await processDelivery(builtIn, deliveryJobSchema.parse(escalation));
      const en = email.sent.find(
        (m) => m.to === w.leadA.email && m.subject.includes('ESCALATION'),
      )!;
      expect(en.subject).toContain('unacknowledged for 7 minutes');
    } finally {
      await ctx.prisma.user.update({ where: { id: w.agentA2.id }, data: { locale: 'en' } });
    }
  });

  it('the same delivery run three times at once is sent once (per-delivery lock)', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    const phone = testPhone();
    await ctx.prisma.user.update({ where: { id: w.admin.id }, data: { phone } });
    let sends = 0;
    const slow = testWorkerContext(ctx, {
      smsProvider: {
        name: 'console',
        async send() {
          sends += 1;
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { messageId: 'slow' };
        },
        async close() {},
      },
    });
    const job = {
      dedupeKey: key(),
      channel: 'SMS',
      template: 'P1_ALERT',
      ticketId: t.id,
      userId: w.admin.id,
    } as const;
    await queueDeliveries(slow, [{ job, recipientMasked: 'x' }]);
    const parsed = deliveryJobSchema.parse(job);
    const results = await Promise.allSettled([1, 2, 3].map(() => processDelivery(slow, parsed)));
    expect(sends).toBe(1);
    expect(
      results.filter(
        (r) => r.status === 'fulfilled' && 'status' in r.value && r.value.status === 'SENT',
      ),
    ).toHaveLength(1);
    // The others found the lock taken: a retryable failure (BullMQ backs off), never "done".
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason).toBeInstanceOf(DeliveryBusyError);
    expect((await row(job.dedupeKey)).attempts).toBe(1);
    // Their retry, once the holder is done, finds it sent.
    expect(await processDelivery(slow, parsed)).toEqual({ skipped: 'already-done' });
  });

  it('a lock left by a worker that died mid-send makes the job retry, not complete (sent once the lock expires)', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const job = {
      dedupeKey: key(),
      channel: 'EMAIL',
      template: 'TICKET_CREATED_CLIENT',
      ticketId: t.id,
      userId: w.clientX.id,
    } as const;
    await queueDeliveries(worker, [{ job, recipientMasked: 'x' }]);
    // The dead worker's lock (its TTL is still running).
    const lockKey = `${ctx.config.redisPrefix}delivery-lock:${job.dedupeKey}`;
    await ctx.redis.set(lockKey, 'dead-worker', 'PX', 120_000);
    const before = email.sent.length;
    const parsed = deliveryJobSchema.parse(job);
    await expect(processDelivery(worker, parsed)).rejects.toBeInstanceOf(DeliveryBusyError);
    expect(email.sent.length).toBe(before);
    expect((await row(job.dedupeKey)).status).toBe('QUEUED');
    // The lock expires; the next retry sends it.
    await ctx.redis.del(lockKey);
    expect(await processDelivery(worker, parsed)).toEqual({ status: 'SENT' });
    expect(email.sent.length).toBe(before + 1);
  });

  it('a failed send is FAILED with a redacted error and retried; an inactive recipient is skipped', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const k = key();
    email.failNext(1, `550 mailbox ${w.clientX.email} unavailable, call +974 5550 1234`);
    const job = {
      dedupeKey: k,
      channel: 'EMAIL',
      template: 'TICKET_CREATED_CLIENT',
      ticketId: t.id,
      userId: w.clientX.id,
    } as const;
    await expect(deliver(job)).rejects.toThrow();
    const failed = await row(k);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(failed.error).toContain('[email]');
    expect(failed.error).not.toContain(w.clientX.email);
    expect(failed.error).not.toContain('5550');
    expect(await processDelivery(worker, deliveryJobSchema.parse(job))).toEqual({ status: 'SENT' });
    expect(await row(k)).toMatchObject({ status: 'SENT', attempts: 2, error: null });

    const disabled = w.disabledAgent;
    const k2 = key();
    expect(
      await deliver({ ...job, dedupeKey: k2, template: 'SLA_AT_RISK', userId: disabled.id }),
    ).toMatchObject({ status: 'SKIPPED' });
  });

  it('a P1 alert still queued when the P1 is acknowledged is skipped', async () => {
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    await ctx.prisma.ticket.update({
      where: { id: t.id },
      data: { p1AckedAt: new Date(), p1AckedById: w.agentA.id },
    });
    const k = key();
    expect(
      await deliver({
        dedupeKey: k,
        channel: 'EMAIL',
        template: 'P1_ALERT',
        ticketId: t.id,
        userId: w.agentA.id,
        context: { p1Since: t.p1Since as string, step: 1 },
      }),
    ).toMatchObject({ status: 'SKIPPED' });
    expect((await row(k)).error).toMatch(/acknowledged/);
  });

  it('Teams (webhook provider): no webhook → SKIPPED; a host off the allow-list → FAILED, not retried', async () => {
    const posted: string[] = [];
    const teamsWorker = testWorkerContext(ctx, {
      teamsProvider: createWebhookTeamsProvider(
        { teams: { provider: 'webhook', webhookHosts: ['*.webhook.office.com'], timeoutMs: 1000 } },
        async (url) => {
          posted.push(String(url));
          return new Response('1', { status: 200 });
        },
      ),
    });
    const t = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
    );
    const card = {
      channel: 'TEAMS',
      template: 'P1_CREATED',
      ticketId: t.id,
      teamId: w.teamA.id,
      context: { p1Since: t.p1Since as string, step: 1 },
    } as const;
    const run = async (dedupeKey: string) => {
      await queueDeliveries(teamsWorker, [{ job: { ...card, dedupeKey }, recipientMasked: 'x' }]);
      return processDelivery(teamsWorker, deliveryJobSchema.parse({ ...card, dedupeKey }));
    };
    const k1 = key();
    expect(await run(k1)).toMatchObject({ status: 'SKIPPED' });

    const secret = 'https://intranet.example.com/hook/SECRET-TOKEN';
    await ctx.prisma.team.update({ where: { id: w.teamA.id }, data: { teamsWebhookUrl: secret } });
    const k2 = key();
    await expect(run(k2)).rejects.toBeInstanceOf(UnrecoverableError);
    const failed = await row(k2);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).not.toContain('SECRET-TOKEN');
    expect(posted).toHaveLength(0);

    await ctx.prisma.team.update({
      where: { id: w.teamA.id },
      data: { teamsWebhookUrl: 'https://tenant.webhook.office.com/webhookb2/SECRET' },
    });
    const k3 = key();
    expect(await run(k3)).toEqual({ status: 'SENT' });
    expect(posted).toHaveLength(1);
    await ctx.prisma.team.update({ where: { id: w.teamA.id }, data: { teamsWebhookUrl: null } });
  });

  it('client reply (D6): the assignee in-app + email; unassigned → the leads in-app + the team list', async () => {
    const list = testEmail();
    await ctx.prisma.team.update({ where: { id: w.teamA.id }, data: { emails: [list] } });
    const assigned = await createTicket(ctx, w.clientX, ticketBody(w));
    await ctx.prisma.ticket.update({
      where: { id: assigned.id },
      data: { assigneeId: w.agentA2.id },
    });
    const unassigned = await createTicket(ctx, w.clientX, ticketBody(w));
    for (const [t, inApp, emails] of [
      [assigned, [w.agentA2.id], [`CLIENT_REPLY_ASSIGNEE:${w.agentA2.email}`]],
      [unassigned, [w.leadA.id], [`CLIENT_REPLY_ASSIGNEE:${list}`]],
    ] as const) {
      const reply = await postMessage(ctx, w.clientX, t.id, { body: 'Any news?' });
      const messageId = reply.json().message.id;
      expect(
        await processNotificationEvent(worker, {
          event: 'client-reply',
          ticketId: t.id,
          messageId,
        }),
      ).toMatchObject({ inApp: inApp.length });
      const notes = await ctx.prisma.notification.findMany({ where: { ticketId: t.id } });
      expect(notes.map((n) => `${n.type}:${n.userId}`)).toEqual(
        inApp.map((id) => `CLIENT_REPLY:${id}`),
      );
      expect(notes[0]!.data).toMatchObject({ actor: { id: w.clientX.id, name: 'Xena Client' } });
      const rows = await ctx.prisma.notificationDelivery.findMany({
        where: { ticketId: t.id, templateKey: 'CLIENT_REPLY_ASSIGNEE' },
      });
      expect(rows.map((d) => `${d.templateKey}:${d.recipientMasked}`)).toEqual([...emails]);
    }
  });

  it('a team distribution list is written to in English without a personal greeting (D7)', async () => {
    const t = await createTicket(ctx, w.clientX, ticketBody(w));
    const address = testEmail();
    expect(
      await deliver({
        dedupeKey: key(),
        channel: 'EMAIL',
        template: 'TICKET_CREATED_TEAM',
        ticketId: t.id,
        teamId: w.teamA.id,
        address,
      }),
    ).toEqual({ status: 'SENT' });
    const mail = email.sent.find((m) => m.to === address)!;
    expect(mail.subject).toContain(`[LG-${t.number}] New P3 Medium ticket`);
    expect(mail.text).not.toMatch(/^Hi /m);
    expect(mail.text).toContain(`/console/inbox?ticket=LG-${t.number}`);
  });
});
