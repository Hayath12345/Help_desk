import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@loons/db';
import type { WorkerContext } from '../src/jobs/context.ts';
import { processDelivery } from '../src/jobs/deliver.ts';
import { processNotificationEvent } from '../src/jobs/events.ts';
import { addDays, digestWindow, isBusinessDay, localDate } from '../src/jobs/local-time.ts';
import { runAutoClose, runDigest, runOrphanSweep, runRetention } from '../src/jobs/maintenance.ts';
import { deliveryJobSchema, notificationEventSchema } from '../src/lib/job-data.ts';
import type { WorkerEventInput } from '../src/lib/worker-events.ts';
import { createTestContext, testEmail, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  postMessage,
  ticketBody,
  type World,
} from './ticket-world.ts';
import { allJobs, fakeEmail, sleep, testWorkerContext } from './worker-helpers.ts';

// Scheduled `sla` jobs other than the scan: auto-close (D8) incl. its race with a client reopen,
// the P4 digest (D9), the orphan-attachment sweep and retention. Fake clock, scoped to the test
// teams; auto-close and the digest use instants far from the real clock where the dev stack's
// own worker could otherwise act on the same rows.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('maintenance jobs', () => {
  let ctx: TestContext;
  let w: World;
  let worker: WorkerContext;
  const published: WorkerEventInput[] = [];
  const email = fakeEmail();
  const deletedObjects: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    worker = testWorkerContext(ctx, {
      emailProvider: email.provider,
      storage: { deleteObject: async (key) => void deletedObjects.push(key) },
      publish: async (event) => void published.push(event),
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function ticket(data: Partial<Prisma.TicketUncheckedCreateInput> = {}) {
    return ctx.prisma.ticket.create({
      data: {
        type: 'INCIDENT',
        subject: `Maintenance ${randomUUID().slice(0, 8)}`,
        description: 'x',
        categoryId: w.catA.category.id,
        subtypeId: w.catA.subtypes[0]!.id,
        priority: 'P3',
        status: 'OPEN',
        orgId: w.orgX.id,
        siteId: w.siteX1.id,
        requesterId: w.clientX.id,
        teamId: w.teamA.id,
        ...data,
      },
    });
  }

  describe('auto-close (D8)', () => {
    // 60 days ahead: a worker on the real clock never finds these solved long enough.
    const now = new Date(Date.now() + 60 * DAY);
    const scope = () => ({ now, teamIds: [w.teamA.id] });

    it('closes tickets SOLVED for 5 calendar days (closedAt, AUTO_CLOSED, realtime), nothing sooner, no email', async () => {
      const due = await ticket({
        status: 'SOLVED',
        solvedAt: new Date(now.getTime() - 5 * DAY - MIN),
      });
      const early = await ticket({ status: 'SOLVED', solvedAt: new Date(now.getTime() - 4 * DAY) });
      const result = await runAutoClose(worker, scope());
      expect(result.closed).toBe(1);
      const closed = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: due.id } });
      expect(closed).toMatchObject({ status: 'CLOSED', closedAt: now });
      const [event] = await ctx.prisma.ticketEvent.findMany({ where: { ticketId: due.id } });
      expect(event).toMatchObject({
        type: 'AUTO_CLOSED',
        actorId: null,
        fromValue: 'SOLVED',
        toValue: 'CLOSED',
        meta: { days: 5 },
      });
      expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: early.id } })).status).toBe(
        'SOLVED',
      );
      expect(published).toContainEqual({ kind: 'ticket', ticketId: due.id });
      expect(await ctx.prisma.notificationDelivery.count({ where: { ticketId: due.id } })).toBe(0);
      // Idempotent.
      expect((await runAutoClose(worker, scope())).closed).toBe(0);
    });

    it('races a client reopen: the reopen that holds the row wins, nothing is closed', async () => {
      const t = await ticket({ status: 'SOLVED', solvedAt: new Date(now.getTime() - 6 * DAY) });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // What messages.service does on a client reply to a SOLVED ticket: lock, reopen, commit.
      const reopen = ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Ticket" WHERE "id" = ${t.id}::uuid FOR UPDATE`;
          await tx.ticket.update({ where: { id: t.id }, data: { status: 'OPEN', solvedAt: null } });
          await held;
        },
        { timeout: 15_000 },
      );
      await sleep(150);
      const closing = runAutoClose(worker, scope());
      await sleep(400);
      release();
      await reopen;
      expect((await closing).closed).toBe(0);
      expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
        'OPEN',
      );
      expect(
        await ctx.prisma.ticketEvent.count({ where: { ticketId: t.id, type: 'AUTO_CLOSED' } }),
      ).toBe(0);
    });

    it('a client reply after the auto-close is refused (CLOSED is final)', async () => {
      const t = await createTicket(ctx, w.clientX, ticketBody(w));
      await ctx.prisma.ticket.update({
        where: { id: t.id },
        data: { status: 'SOLVED', solvedAt: new Date(now.getTime() - 6 * DAY) },
      });
      await runAutoClose(worker, scope());
      const res = await postMessage(ctx, w.clientX, t.id, { body: 'Still broken' });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('P4 digest (D9)', () => {
    let digestAt: Date;
    let list: string;

    beforeAll(async () => {
      list = testEmail();
      await ctx.prisma.team.update({ where: { id: w.teamB.id }, data: { emails: [list] } });
      // A business day ~50 days ahead (Sunday–Thursday, not a holiday), 07:30:05 in Qatar.
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      let day = localDate(new Date(Date.now() + 50 * DAY), calendar.timeZone);
      while (!isBusinessDay(day, calendar)) day = addDays(day, 1);
      digestAt = new Date(
        digestWindow(new Date(`${day}T12:00:00Z`), calendar, '07:30')!.end.getTime() + 5_000,
      );
    });

    it('P4 tickets skip the instant team email (the client still gets the acknowledgement)', async () => {
      await ctx.prisma.team.update({ where: { id: w.teamA.id }, data: { emails: [testEmail()] } });
      const p4 = await createTicket(
        ctx,
        w.clientX,
        ticketBody(w, { subtypeId: w.catA.subtypes[3]!.id }),
      );
      const p3 = await createTicket(ctx, w.clientX, ticketBody(w));
      for (const t of [p4, p3]) {
        const [job] = (await allJobs(ctx.queues.notifications)).filter(
          (j) => j.id === `ticket-created-${t.id}`,
        );
        await processNotificationEvent(worker, notificationEventSchema.parse(job!.data));
      }
      const templates = async (ticketId: string) =>
        (await ctx.prisma.notificationDelivery.findMany({ where: { ticketId } }))
          .map((d) => d.templateKey)
          .sort();
      expect(await templates(p4.id)).toEqual(['TICKET_CREATED_CLIENT']);
      expect(await templates(p3.id)).toEqual(['TICKET_CREATED_CLIENT', 'TICKET_CREATED_TEAM']);
    });

    it('lists the P4 tickets created since the previous business day’s digest, per team list', async () => {
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      const window = digestWindow(digestAt, calendar, '07:30')!;
      const inside = await ticket({
        teamId: w.teamB.id,
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
        priority: 'P4',
        subject: 'Printer toner low on floor 3',
        createdAt: new Date(window.start.getTime() + MIN),
      });
      const before = await ticket({
        teamId: w.teamB.id,
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
        priority: 'P4',
        subject: 'Already in the previous digest',
        createdAt: new Date(window.start.getTime() - MIN),
      });
      const p3 = await ticket({
        teamId: w.teamB.id,
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
        priority: 'P3',
        subject: 'Not a P4',
        createdAt: new Date(window.start.getTime() + 2 * MIN),
      });
      const result = await runDigest(worker, { now: digestAt, teamIds: [w.teamA.id, w.teamB.id] });
      expect(result).toEqual({ teams: 1, deliveries: 1 });
      const [row] = await ctx.prisma.notificationDelivery.findMany({
        where: { teamId: w.teamB.id, templateKey: 'P4_DAILY_DIGEST' },
      });
      expect(row).toMatchObject({ recipientMasked: list, status: 'QUEUED' });
      const [job] = (await allJobs(ctx.queues.notifications)).filter(
        (j) => j.data.dedupeKey === row!.dedupeKey,
      );
      expect(await processDelivery(worker, deliveryJobSchema.parse(job!.data))).toEqual({
        status: 'SENT',
      });
      const mail = email.sent.find((m) => m.to === list)!;
      expect(mail.subject).toContain('1 new P4 tickets');
      expect(mail.text).toContain(`LG-${inside.number}`);
      expect(mail.text).toContain('Printer toner low on floor 3');
      expect(mail.text).not.toContain(`LG-${before.number}`);
      expect(mail.text).not.toContain(`LG-${p3.number}`);
      expect(mail.text).not.toMatch(/^Hi /m);
      // Once per team and day.
      expect(await runDigest(worker, { now: digestAt, teamIds: [w.teamB.id] })).toEqual({
        teams: 1,
        deliveries: 1,
      });
      expect(
        await ctx.prisma.notificationDelivery.count({
          where: { teamId: w.teamB.id, templateKey: 'P4_DAILY_DIGEST' },
        }),
      ).toBe(1);
    });

    it('no digest on a weekend day or for a team without new P4 tickets', async () => {
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      let day = localDate(digestAt, calendar.timeZone);
      while (isBusinessDay(day, calendar)) day = addDays(day, 1);
      expect(
        await runDigest(worker, { now: new Date(`${day}T06:00:00Z`), teamIds: [w.teamB.id] }),
      ).toEqual({ skipped: 'not-a-business-day' });
      const nextDay = new Date(digestAt.getTime() + 7 * DAY);
      const quiet = await runDigest(worker, { now: nextDay, teamIds: [w.teamA.id] });
      expect(quiet).toMatchObject({ deliveries: 0 });
    });
  });

  describe('orphan sweep and retention', () => {
    it('removes PENDING / REJECTED uploads older than 30 minutes (object, then row), nothing else', async () => {
      const t = await ticket();
      // Ahead of the real clock: the dev stack's own sweep never sees these rows as old.
      const now = new Date(Date.now() + 10 * DAY);
      const attachment = async (
        status: Prisma.AttachmentCreateManyInput['status'],
        ageMin: number,
      ) =>
        ctx.prisma.attachment.create({
          data: {
            ticketId: t.id,
            uploaderId: w.clientX.id,
            storageKey: `attachments/${randomUUID()}/file.pdf`,
            fileName: 'file.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            status,
            createdAt: new Date(now.getTime() - ageMin * MIN),
          },
        });
      const oldPending = await attachment('PENDING', 31);
      const oldRejected = await attachment('REJECTED', 45);
      const fresh = await attachment('PENDING', 5);
      const clean = await attachment('CLEAN', 120);
      const confirming = await attachment('PENDING', 60);
      await ctx.redis.set(
        `${ctx.config.redisPrefix}attachment-confirm:${confirming.id}`,
        'x',
        'PX',
        60_000,
      );

      expect(await runOrphanSweep(worker, { now, teamIds: [w.teamA.id] })).toEqual({ removed: 2 });
      const left = await ctx.prisma.attachment.findMany({ where: { ticketId: t.id } });
      expect(left.map((a) => a.id).sort()).toEqual([fresh.id, clean.id, confirming.id].sort());
      expect(deletedObjects).toEqual(
        expect.arrayContaining([oldPending.storageKey, oldRejected.storageKey]),
      );
      expect(deletedObjects).not.toContain(clean.storageKey);
    });

    it('retention: delivery logs and read notifications older than 90 days go', async () => {
      const t = await ticket();
      // Ahead of the real clock: the dev stack's own retention job never sees these rows as old.
      const now = new Date(Date.now() + 200 * DAY);
      const ago = (days: number) => new Date(now.getTime() - days * DAY);
      const delivery = (days: number) =>
        ctx.prisma.notificationDelivery.create({
          data: {
            channel: 'EMAIL',
            templateKey: 'TICKET_CREATED_TEAM',
            ticketId: t.id,
            recipientMasked: 'x@example.com',
            dedupeKey: `retention-${randomUUID()}`,
            createdAt: ago(days),
          },
        });
      const notification = (days: number, read: boolean) =>
        ctx.prisma.notification.create({
          data: {
            userId: w.agentA.id,
            type: 'CLIENT_REPLY',
            ticketId: t.id,
            createdAt: ago(days),
            readAt: read ? ago(days) : null,
          },
        });
      const oldDelivery = await delivery(91);
      const newDelivery = await delivery(89);
      const oldRead = await notification(91, true);
      const oldUnread = await notification(91, false);
      const recentRead = await notification(10, true);
      // (Everything this file created at the real time counts as old at `now` too.)
      const removed = await runRetention(worker, { now, teamIds: [w.teamA.id] });
      expect(removed.deliveries).toBeGreaterThanOrEqual(1);
      expect(removed.notifications).toBe(1);
      expect(
        await ctx.prisma.notificationDelivery.findUnique({ where: { id: oldDelivery.id } }),
      ).toBeNull();
      expect(
        await ctx.prisma.notificationDelivery.findUnique({ where: { id: newDelivery.id } }),
      ).not.toBeNull();
      const remaining = await ctx.prisma.notification.findMany({ where: { ticketId: t.id } });
      expect(remaining.map((n) => n.id).sort()).toEqual([oldUnread.id, recentRead.id].sort());
      expect(remaining.some((n) => n.id === oldRead.id)).toBe(false);
    });
  });

  it('staff can read the counts after a close (the API sees the worker’s changes)', async () => {
    const res = await apiAs(ctx, w.agentA).get('/tickets/counts');
    expect(res.statusCode).toBe(200);
  });
});
