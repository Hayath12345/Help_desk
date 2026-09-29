import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@loons/db';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';

// Database constraints of the Phase 3 migration (docs/PHASE3_CONTRACT.md "Data model") that the
// SLA worker and the notification jobs rely on for exactly-once behaviour. Every write happens
// inside a transaction that is rolled back, so nothing is left behind.

class Rollback extends Error {}

describe('phase3_sla_notifications constraints', () => {
  let ctx: TestContext;
  let w: World;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Runs `fn` in a transaction and rolls it back; returns what `fn` returned. */
  async function inRollback<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        result = await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    return result as T;
  }

  /** The Prisma error code of a failing write inside its own savepoint-free transaction. */
  async function failureCode(fn: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    try {
      await ctx.prisma.$transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (err instanceof Rollback) return null;
      if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
      throw err;
    }
    return null;
  }

  const rule = (teamId: string | null, step: number) => ({
    priority: 'P4' as const,
    teamId,
    step,
    targetType: 'ON_CALL' as const,
    afterMins: 0,
    channels: ['EMAIL' as const],
  });

  it('EscalationRule: one rule per (priority, team, step), the global chain included (NULLS NOT DISTINCT)', async () => {
    // Two global (teamId NULL) rules for the same step: refused.
    expect(
      await failureCode(async (tx) => {
        await tx.escalationRule.create({ data: rule(null, 97) });
        await tx.escalationRule.create({ data: rule(null, 97) });
      }),
    ).toBe('P2002');
    // Same for a team chain.
    expect(
      await failureCode(async (tx) => {
        await tx.escalationRule.create({ data: rule(w.teamA.id, 97) });
        await tx.escalationRule.create({ data: rule(w.teamA.id, 97) });
      }),
    ).toBe('P2002');
    // Different steps, or a team rule next to the global one, are fine.
    const created = await inRollback(async (tx) => {
      await tx.escalationRule.create({ data: rule(null, 97) });
      await tx.escalationRule.create({ data: rule(null, 98) });
      await tx.escalationRule.create({ data: rule(w.teamA.id, 97) });
      await tx.escalationRule.create({ data: rule(w.teamB.id, 97) });
      return tx.escalationRule.count({ where: { priority: 'P4', step: { in: [97, 98] } } });
    });
    expect(created).toBe(4);
    const index = await ctx.prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'EscalationRule_priority_teamId_step_key'`;
    expect(index[0]?.indexdef).toMatch(/UNIQUE INDEX .*NULLS NOT DISTINCT/);
  });

  it('TicketSlaSignal: one signal per (ticket, target, kind, dueAt); a moved due date is new; deleted with the ticket', async () => {
    const ticket = await createTicket(ctx, w.clientX, ticketBody(w));
    const dueAt = new Date('2026-10-04T08:15:00Z');
    const signal = { ticketId: ticket.id, target: 'FIRST_REPLY', kind: 'AT_RISK', dueAt } as const;
    expect(
      await failureCode(async (tx) => {
        await tx.ticketSlaSignal.create({ data: signal });
        await tx.ticketSlaSignal.create({ data: signal });
      }),
    ).toBe('P2002');
    const counts = await inRollback(async (tx) => {
      await tx.ticketSlaSignal.createMany({
        data: [
          signal,
          { ...signal, kind: 'BREACHED' },
          { ...signal, target: 'RESOLUTION' },
          { ...signal, dueAt: new Date(dueAt.getTime() + 60_000) },
        ],
      });
      // createMany … skipDuplicates is how a second worker loses the race: nothing inserted.
      const again = await tx.ticketSlaSignal.createMany({ data: [signal], skipDuplicates: true });
      const before = await tx.ticketSlaSignal.count({ where: { ticketId: ticket.id } });
      await tx.ticket.delete({ where: { id: ticket.id } });
      const after = await tx.ticketSlaSignal.count({ where: { ticketId: ticket.id } });
      return { again: again.count, before, after };
    });
    expect(counts).toEqual({ again: 0, before: 4, after: 0 });
  });

  it('Notification: dedupeKey is unique, title optional; NotificationDelivery: dedupeKey unique, cascades', async () => {
    const ticket = await createTicket(ctx, w.clientX, ticketBody(w));
    const key = `test-${rand()}`;
    const notification = {
      userId: w.agentA.id,
      type: 'SLA_AT_RISK' as const,
      ticketId: ticket.id,
      data: { target: 'FIRST_REPLY' },
      dedupeKey: key,
    };
    expect(
      await failureCode(async (tx) => {
        await tx.notification.create({ data: notification });
        await tx.notification.create({ data: notification });
      }),
    ).toBe('P2002');
    const delivery = {
      channel: 'SMS' as const,
      templateKey: 'P1_ALERT',
      ticketId: ticket.id,
      userId: w.agentA.id,
      teamId: w.teamA.id,
      recipientMasked: '+974 •••• 1000',
      dedupeKey: key,
    };
    expect(
      await failureCode(async (tx) => {
        await tx.notificationDelivery.create({ data: delivery });
        await tx.notificationDelivery.create({ data: { ...delivery, channel: 'EMAIL' } });
      }),
    ).toBe('P2002');
    const result = await inRollback(async (tx) => {
      const n = await tx.notification.create({ data: notification });
      const d = await tx.notificationDelivery.create({ data: delivery });
      await tx.ticket.delete({ where: { id: ticket.id } });
      return {
        title: n.title,
        status: d.status,
        attempts: d.attempts,
        notifications: await tx.notification.count({ where: { dedupeKey: key } }),
        deliveries: await tx.notificationDelivery.count({ where: { dedupeKey: key } }),
      };
    });
    expect(result).toEqual({
      title: null,
      status: 'QUEUED',
      attempts: 0,
      notifications: 0,
      deliveries: 0,
    });
  });

  it('Ticket: new columns default to "unknown" (no instants, no P1 period, step 0)', async () => {
    const row = await inRollback((tx) =>
      tx.ticket.create({
        data: {
          type: 'INCIDENT',
          subject: 'Raw insert',
          description: 'Inserted without the API.',
          categoryId: w.catA.category.id,
          priority: 'P1',
          orgId: w.orgX.id,
          requesterId: w.clientX.id,
          teamId: w.teamA.id,
        },
      }),
    );
    expect(row).toMatchObject({
      firstReplyAtRiskAt: null,
      resolveAtRiskAt: null,
      p1Since: null,
      p1EscalationStep: 0,
    });
  });
});
