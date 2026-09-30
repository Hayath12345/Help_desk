import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@loons/db';
import {
  configUpdatedPayloadSchema,
  ticketFormConfigSchema,
  type Actor,
  type ConfigUpdatedPayload,
} from '@loons/shared';
import { lockFresh } from '../src/services/admin/concurrency.ts';
import { applyReorder, renumberUnique, writeSortOrder } from '../src/services/admin/reorder.ts';
import type { AdminContext } from '../src/services/admin/write.ts';
import { createTicketConfigService } from '../src/services/ticket-config.service.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona } from './ticket-world.ts';
import { sleep, waitFor } from './worker-helpers.ts';

// Admin write plumbing (decisions E3, E17, E18, E19): one transaction with its audit rows, the
// config version bump and `config:updated` broadcast after commit, the generation-guarded form
// config cache, `expectedUpdatedAt` concurrency and the reorder helpers.

describe('admin writes', () => {
  let ctx: TestContext;
  let admin: AdminContext;
  let clientSocket: Socket;
  const events: ConfigUpdatedPayload[] = [];

  const actor = (id: string): Actor => ({
    id,
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    orgId: null,
    teamIds: [],
    leadTeamIds: [],
    emailVerified: true,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    const sa = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      role: 'SUPER_ADMIN',
    });
    admin = { actor: actor(sa.id), requestId: `req-${rand()}` };
    // A client's socket: config:updated reaches every socket, portal users included (E18).
    const { user } = await ctx.fixtures.client();
    const client = await persona(ctx, user);
    clientSocket = connect(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: client.token },
    });
    clientSocket.on('config:updated', (payload: unknown) => {
      events.push(configUpdatedPayloadSchema.parse(payload));
    });
    await new Promise<void>((resolve, reject) => {
      clientSocket.once('connect', () => resolve());
      clientSocket.once('connect_error', reject);
    });
  });
  afterAll(async () => {
    clientSocket?.disconnect();
    await ctx?.close();
  });

  const writer = () => ctx.app.services.admin.writer;
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  describe('transaction + audit (E17)', () => {
    it('writes the change and its audit row together, then announces the scope', async () => {
      const team = await ctx.fixtures.team();
      const seen = events.length;
      const updated = await writer().write(admin, { scopes: 'teams' }, async ({ tx, audit }) => {
        const before = await tx.team.findUniqueOrThrow({ where: { id: team.id } });
        const after = await tx.team.update({
          where: { id: team.id },
          data: {
            nameEn: 'Renamed team',
            teamsWebhookUrl: 'https://contoso.webhook.office.com/webhookb2/SECRET',
          },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Team',
          entityId: team.id,
          entityLabel: after.nameEn,
          before,
          after,
        });
        return after;
      });
      expect(updated.nameEn).toBe('Renamed team');
      const [row, ...more] = await auditRows(team.id);
      expect(more).toEqual([]);
      expect(row).toMatchObject({
        actorId: admin.actor.id,
        action: 'UPDATE',
        entity: 'Team',
        entityLabel: 'Renamed team',
        requestId: admin.requestId,
        before: { nameEn: team.nameEn, teamsWebhookHost: null },
        after: { nameEn: 'Renamed team', teamsWebhookHost: 'contoso.webhook.office.com' },
      });
      expect(JSON.stringify(row)).not.toContain('SECRET');
      const event = await waitFor(async () => events.slice(seen).find((e) => e.scope === 'teams'));
      expect(event.version).toBeGreaterThan(0);
    });

    it('a failed change leaves no audit row, no change and no announcement', async () => {
      const team = await ctx.fixtures.team();
      const seen = events.length;
      await expect(
        writer().write(admin, { scopes: 'teams' }, async ({ tx, audit }) => {
          const after = await tx.team.update({ where: { id: team.id }, data: { nameEn: 'Nope' } });
          await audit.record({
            action: 'UPDATE',
            entity: 'Team',
            entityId: team.id,
            before: team,
            after,
          });
          // The change fails after the audit row was written: both roll back.
          await tx.team.create({ data: { key: team.key, nameEn: 'dup', nameAr: 'dup' } });
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(await auditRows(team.id)).toEqual([]);
      expect((await ctx.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).nameEn).toBe(
        team.nameEn,
      );
      await sleep(300);
      expect(events.slice(seen)).toEqual([]);
    });

    it('a failed audit insert undoes the change', async () => {
      const team = await ctx.fixtures.team();
      const ghost: AdminContext = { actor: actor(crypto.randomUUID()), requestId: 'req-ghost-1' };
      await expect(
        writer().write(ghost, { scopes: [] }, async ({ tx, audit }) => {
          const after = await tx.team.update({ where: { id: team.id }, data: { nameEn: 'Ghost' } });
          // actorId references no user: the audit insert fails on its foreign key.
          await audit.record({
            action: 'UPDATE',
            entity: 'Team',
            entityId: team.id,
            before: team,
            after,
          });
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      expect((await ctx.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).nameEn).toBe(
        team.nameEn,
      );
    });

    it('an update that changes nothing writes no audit row', async () => {
      const team = await ctx.fixtures.team();
      const written = await writer().write(admin, { scopes: [] }, async ({ tx, audit }) => {
        const after = await tx.team.update({
          where: { id: team.id },
          data: { nameEn: team.nameEn },
        });
        return audit.record({
          action: 'UPDATE',
          entity: 'Team',
          entityId: team.id,
          before: team,
          after,
        });
      });
      expect(written).toBe(false);
      expect(await auditRows(team.id)).toEqual([]);
    });

    it('after-commit effects run once the change is saved; their failures are only logged', async () => {
      const team = await ctx.fixtures.team();
      const order: string[] = [];
      await writer().write(admin, { scopes: [] }, async ({ tx, after }) => {
        await tx.team.update({ where: { id: team.id }, data: { nameEn: 'After' } });
        after.run('check', async () => {
          // Another connection sees the committed change.
          const row = await ctx.prisma.team.findUniqueOrThrow({ where: { id: team.id } });
          order.push(row.nameEn);
        });
        after.run('boom', () => {
          throw new Error('effect failed');
        });
        after.run('still runs', () => void order.push('next'));
        order.push('in-tx');
      });
      expect(order).toEqual(['in-tx', 'After', 'next']);
    });
  });

  describe('live refresh (E18)', () => {
    it('config:updated is sent after commit, and the form config then has that version', async () => {
      const team = await ctx.fixtures.team();
      const seen = events.length;
      let eventDuringTx = false;
      await writer().write(admin, { scopes: ['ticket-form', 'teams'] }, async ({ tx }) => {
        await ctx.fixtures.category({ teamId: team.id }); // outside the tx: visible either way
        await tx.team.update({ where: { id: team.id }, data: { nameEn: 'Committed name' } });
        await sleep(250);
        eventDuringTx = events.length > seen;
      });
      expect(eventDuringTx).toBe(false);
      const event = await waitFor(async () =>
        events.slice(seen).find((e) => e.scope === 'ticket-form'),
      );
      expect(
        events
          .slice(seen)
          .map((e) => e.scope)
          .sort(),
      ).toEqual(['teams', 'ticket-form']);
      expect(new Set(events.slice(seen).map((e) => e.version)).size).toBe(1);
      // The browser refetches: the config carries a version at least the announced one, and the
      // committed change.
      const staff = await persona(
        ctx,
        await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain }),
      );
      const res = await apiAs(ctx, staff).get('/config/ticket-form');
      const config = ticketFormConfigSchema.parse(res.json());
      expect(config.version).toBeGreaterThanOrEqual(event.version);
      expect(config.categories.find((c) => c.team.id === team.id)?.team.nameEn).toBe(
        'Committed name',
      );
    });

    it('announces version 0 when the version cannot be bumped (clients refetch once)', async () => {
      const { createConfigChanges } = await import('../src/services/admin/config-changes.ts');
      const sent: unknown[] = [];
      const changes = createConfigChanges({
        ticketConfig: { invalidate: async () => null },
        broadcast: (event, payload) => sent.push([event, payload]),
        logger: ctx.app.log,
      });
      expect(await changes.afterConfigChange(['macros', 'macros', 'staff'])).toBe(0);
      expect(sent).toEqual([
        ['config:updated', { scope: 'macros', version: 0 }],
        ['config:updated', { scope: 'staff', version: 0 }],
      ]);
    });
  });

  describe('form config cache generation (E18)', () => {
    /** A Prisma client whose category reads return, then wait for `gate` (a slow request). */
    function gatedPrisma(prisma: PrismaClient, gate: Promise<void>): PrismaClient {
      return new Proxy(prisma, {
        get(target, prop) {
          if (prop === 'category') {
            return {
              findMany: async (args: Parameters<PrismaClient['category']['findMany']>[0]) => {
                const rows = await target.category.findMany(args);
                await gate;
                return rows;
              },
            };
          }
          return Reflect.get(target, prop, target) as unknown;
        },
      });
    }

    it('a read that started before an invalidation never re-fills the cache with old config', async () => {
      const prefix = `${ctx.config.redisPrefix}race-${rand(3)}:`;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const slow = createTicketConfigService({
        prisma: gatedPrisma(ctx.prisma, gate),
        redis: ctx.redis,
        prefix,
        logger: ctx.app.log,
      });
      const other = createTicketConfigService({
        prisma: ctx.prisma,
        redis: ctx.redis,
        prefix,
        logger: ctx.app.log,
      });

      const reading = slow.getFormConfig(); // reads the DB now, finishes later
      await sleep(200);
      const team = await ctx.fixtures.team();
      const added = await ctx.fixtures.category({ teamId: team.id }); // the admin change
      const version = await other.invalidate(); // after its commit
      expect(version).toBe(1);
      open();
      const stale = await reading;
      expect(stale.version).toBe(0);
      expect(stale.categories.some((c) => c.id === added.category.id)).toBe(false);
      // The old config was not written back…
      expect(await ctx.redis.exists(`${prefix}config:ticket-form`)).toBe(0);
      // …so every instance now reads the new one, tagged with the new version.
      const fresh = await other.getFormConfig();
      expect(fresh.version).toBe(1);
      expect(fresh.categories.some((c) => c.id === added.category.id)).toBe(true);
      expect(await ctx.redis.exists(`${prefix}config:ticket-form`)).toBe(1);
      expect((await slow.getFormConfig()).version).toBe(1);
    });

    it('an entry cached under an older generation is ignored', async () => {
      const prefix = `${ctx.config.redisPrefix}gen-${rand(3)}:`;
      const svc = createTicketConfigService({
        prisma: ctx.prisma,
        redis: ctx.redis,
        prefix,
        logger: ctx.app.log,
      });
      const first = await svc.getFormConfig();
      expect(first.version).toBe(0);
      const team = await ctx.fixtures.team();
      const added = await ctx.fixtures.category({ teamId: team.id });
      // The generation moved but the entry survived (e.g. its DEL was lost).
      await ctx.redis.incr(`${prefix}config:gen`);
      const next = await svc.getFormConfig();
      expect(next.version).toBe(1);
      expect(next.categories.some((c) => c.id === added.category.id)).toBe(true);
      expect(await svc.currentVersion()).toBe(1);
    });
  });

  describe('expectedUpdatedAt (E19)', () => {
    const rename = (teamId: string, expected: string | Date, name: string, holdMs = 0) =>
      writer().write(admin, { scopes: [] }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Team', teamId, expected);
        const before = await tx.team.findUniqueOrThrow({ where: { id: teamId } });
        await sleep(holdMs);
        const after = await tx.team.update({ where: { id: teamId }, data: { nameEn: name } });
        await audit.record({ action: 'UPDATE', entity: 'Team', entityId: teamId, before, after });
        return after;
      });

    it('a stale expectedUpdatedAt is 409 stale with the current updatedAt', async () => {
      const team = await ctx.fixtures.team();
      const saved = await rename(team.id, team.updatedAt, 'First');
      const err = await rename(team.id, team.updatedAt, 'Second').catch((e: unknown) => e);
      expect(err).toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
        details: { reason: 'stale', currentUpdatedAt: saved.updatedAt.toISOString() },
      });
      expect((await ctx.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).nameEn).toBe(
        'First',
      );
    });

    it('two concurrent saves from the same version: one wins, the other is stale', async () => {
      const team = await ctx.fixtures.team();
      const first = rename(team.id, team.updatedAt.toISOString(), 'A', 300);
      await sleep(50);
      const second = rename(team.id, team.updatedAt.toISOString(), 'B');
      const results = await Promise.allSettled([first, second]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
        details: { reason: 'stale' },
      });
      expect((await ctx.prisma.team.findUniqueOrThrow({ where: { id: team.id } })).nameEn).toBe(
        'A',
      );
      expect(await auditRows(team.id)).toHaveLength(1);
    });

    it('a missing row is 404', async () => {
      await expect(rename(crypto.randomUUID(), new Date(), 'x')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(rename('not-a-uuid', new Date(), 'x')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('locks AppSetting rows by key', async () => {
      const row = await ctx.prisma.appSetting.findUniqueOrThrow({
        where: { key: 'tickets.autoCloseDays' },
      });
      const current = await ctx.prisma.$transaction((tx) =>
        lockFresh(tx, 'AppSetting', row.key, row.updatedAt.toISOString()),
      );
      expect(current.getTime()).toBe(row.updatedAt.getTime());
    });
  });

  describe('reorder (E3)', () => {
    async function threeCategories() {
      const team = await ctx.fixtures.team();
      const cats: Array<{ id: string }> = [];
      for (let i = 0; i < 3; i++)
        cats.push((await ctx.fixtures.category({ teamId: team.id })).category);
      const list = `Category:${team.id}`;
      const currentIds = async () =>
        (
          await ctx.prisma.category.findMany({
            where: { teamId: team.id },
            orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
            select: { id: true },
          })
        ).map((c) => c.id);
      await ctx.prisma.$transaction((tx) =>
        writeSortOrder(
          tx,
          'Category',
          cats.map((c) => c.id),
          { start: 10_000 },
        ),
      );
      return { team, cats, list, currentIds };
    }

    it('writes the new order without touching updatedAt; returns before / after', async () => {
      const { cats, list, currentIds } = await threeCategories();
      const [a, b, c] = cats.map((x) => x.id) as [string, string, string];
      const updatedBefore = await ctx.prisma.category.findMany({
        where: { id: { in: [a, b, c] } },
        select: { id: true, updatedAt: true },
      });
      const result = await ctx.prisma.$transaction((tx) =>
        applyReorder(tx, {
          list,
          body: { expectedIds: [a, b, c], ids: [c, a, b] },
          currentIds,
          write: (ids) => writeSortOrder(tx, 'Category', ids, { start: 10_000 }),
        }),
      );
      expect(result).toEqual({ before: [a, b, c], after: [c, a, b] });
      expect(await currentIds()).toEqual([c, a, b]);
      const sortOrders = await ctx.prisma.category.findMany({
        where: { id: { in: [a, b, c] } },
        select: { id: true, sortOrder: true, updatedAt: true },
      });
      expect(Object.fromEntries(sortOrders.map((s) => [s.id, s.sortOrder]))).toEqual({
        [c]: 10_000,
        [a]: 10_001,
        [b]: 10_002,
      });
      for (const row of sortOrders) {
        expect(row.updatedAt).toEqual(updatedBefore.find((u) => u.id === row.id)?.updatedAt);
      }
      // Same order again: nothing to do.
      const none = await ctx.prisma.$transaction((tx) =>
        applyReorder(tx, {
          list,
          body: { expectedIds: [c, a, b], ids: [c, a, b] },
          currentIds,
          write: () => Promise.reject(new Error('must not write')),
        }),
      );
      expect(none).toBe(null);
    });

    it('409 order_changed when the list is not the expected one any more', async () => {
      const { cats, list, currentIds } = await threeCategories();
      const [a, b, c] = cats.map((x) => x.id) as [string, string, string];
      const reorder = (expectedIds: string[], ids: string[], holdMs = 0) =>
        ctx.prisma.$transaction(async (tx) =>
          applyReorder(tx, {
            list,
            body: { expectedIds, ids },
            currentIds,
            write: async (next) => {
              await sleep(holdMs);
              await writeSortOrder(tx, 'Category', next, { start: 10_000 });
            },
          }),
        );
      await expect(reorder([b, a, c], [c, b, a])).rejects.toMatchObject({
        statusCode: 409,
        details: { reason: 'order_changed' },
      });
      // Two drops from the same starting order: the list lock makes the second one see the first.
      const results = await Promise.allSettled([
        reorder([a, b, c], [b, a, c], 300),
        sleep(50).then(() => reorder([a, b, c], [c, b, a])),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(await currentIds()).toEqual([b, a, c]);
    });

    it('renumbers unique escalation steps without colliding (two phases)', async () => {
      const team = await ctx.fixtures.team();
      const rules: Array<{ id: string }> = [];
      for (const step of [1, 2, 3]) {
        rules.push(
          await ctx.prisma.escalationRule.create({
            data: {
              priority: 'P1',
              teamId: team.id,
              step,
              targetType: 'ON_CALL',
              afterMins: step * 5,
              channels: ['EMAIL'],
            },
          }),
        );
      }
      const ids = rules.map((r) => r.id).reverse();
      await ctx.prisma.$transaction((tx) => renumberUnique(tx, 'EscalationRule', ids));
      const after = await ctx.prisma.escalationRule.findMany({
        where: { teamId: team.id },
        orderBy: { step: 'asc' },
        select: { id: true, step: true },
      });
      expect(after).toEqual(ids.map((id, i) => ({ id, step: i + 1 })));
    });
  });

  describe('GET /config/ticket-form (E6, E12, E18)', () => {
    it('carries the numeric version, the business-day length and the Arabic placeholder', async () => {
      const team = await ctx.fixtures.team();
      const { category } = await ctx.fixtures.category({ teamId: team.id });
      await ctx.prisma.category.update({
        where: { id: category.id },
        data: { assetPlaceholderAr: 'مثال: TST-01' },
      });
      const version = await ctx.app.services.admin.configChanges.afterConfigChange('ticket-form');
      const staff = await persona(
        ctx,
        await ctx.fixtures.staff({ staffDomain: ctx.config.staffEmailDomain }),
      );
      const config = ticketFormConfigSchema.parse(
        (await apiAs(ctx, staff).get('/config/ticket-form')).json(),
      );
      expect(config.version).toBe(version);
      expect(config.businessDayMinutes).toBeGreaterThan(0);
      expect(config.categories.find((c) => c.id === category.id)?.assetPlaceholderAr).toBe(
        'مثال: TST-01',
      );
    });

    it('offers only active dropdown options', async () => {
      const team = await ctx.fixtures.team();
      const { category, fields } = await ctx.fixtures.category({
        teamId: team.id,
        fields: [{ type: 'DROPDOWN', options: ['red', 'green'] }],
      });
      const field = fields[0]!;
      await ctx.prisma.customField.update({
        where: { id: field.id },
        data: {
          options: [
            { value: 'red', labelEn: 'Red', labelAr: 'أحمر' },
            { value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false },
          ],
        },
      });
      await ctx.app.services.ticketConfig.invalidate();
      const config = await ctx.app.services.ticketConfig.getFormConfig();
      const options = config.categories
        .find((c) => c.id === category.id)
        ?.fields.find((f) => f.id === field.id)?.options;
      expect(options).toEqual([{ value: 'red', labelEn: 'Red', labelAr: 'أحمر' }]);
    });
  });
});
