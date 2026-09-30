import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@loons/db';
import type { Actor } from '@loons/shared';
import { mapPrismaError } from '../src/lib/prisma-errors.ts';
import { createCategoriesAdminService } from '../src/services/admin/categories.ts';
import { lockRow } from '../src/services/admin/concurrency.ts';
import { createCustomFieldsAdminService } from '../src/services/admin/custom-fields.ts';
import { createEscalationAdminService } from '../src/services/admin/escalation.ts';
import { createTeamsAdminService } from '../src/services/admin/teams.ts';
import { createAdminWriter, type AdminContext } from '../src/services/admin/write.ts';
import type { AdminDeps } from '../src/services/admin/deps.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin writes that race each other on the shared rows (decisions E5, E19). Each test pauses one
// transaction at a known point (a gated Prisma client), starts the other write, waits until that
// write is either finished or waiting for a row lock (pg_locks), then lets the first one commit.
// Without the locks both sides pass their checks and the invariant breaks (write skew), or the two
// sides deadlock (500).

interface Gate {
  /** Resolves when the gated statement is reached (the transaction holds its locks). */
  reached: Promise<void>;
  release: () => void;
}

function gate(): Gate & { arrive: () => Promise<void> } {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    arrive: async () => {
      arrived();
      await released;
    },
  };
}

describe('admin concurrency (write skew and lock order)', () => {
  let ctx: TestContext;
  let admin: Persona;
  let sa: AdminContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    const user = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      role: 'SUPER_ADMIN',
    });
    admin = await persona(ctx, user);
    const actor: Actor = {
      id: user.id,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      orgId: null,
      teamIds: [],
      leadTeamIds: [],
      emailVerified: true,
    };
    sa = { actor, requestId: `req-${rand()}` };
  });
  afterAll(async () => {
    await ctx?.close();
  });

  /** A Prisma client whose matching operation waits at the gate (once), and a writer on it. */
  function gated(match: (model: string, operation: string, args: unknown) => boolean) {
    const g = gate();
    let armed = true;
    const prisma = ctx.prisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (armed && match(model, operation, args)) {
              armed = false;
              await g.arrive();
            }
            return query(args);
          },
        },
      },
    }) as unknown as AdminDeps['prisma'];
    const writer = createAdminWriter({
      prisma,
      principals: { invalidate: async () => {} },
      sessions: { sessionsRevoked: async () => {} },
      configChanges: { afterConfigChange: async () => 0 },
      logger: ctx.app.log as AdminDeps['logger'],
    });
    return { prisma, writer, gate: g };
  }

  /**
   * Waits until `pending` settles or some statement waits for a lock, whichever comes first
   * (polled; the other write needs the gated transaction's locks, or it doesn't).
   */
  async function settledOrBlocked(pending: Promise<unknown>): Promise<'settled' | 'blocked'> {
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 400; i += 1) {
      if (settled) return 'settled';
      const [row] = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      if ((row?.n ?? 0) > 0) return 'blocked';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the concurrent write neither finished nor waited for a lock');
  }

  /** Archives `teamId` through a teams service whose team UPDATE waits at the gate. */
  function pausedTeamArchive(teamId: string, updatedAt: Date) {
    const {
      prisma,
      writer,
      gate: g,
    } = gated(
      (model, operation, args) =>
        model === 'Team' &&
        operation === 'update' &&
        (args as { data?: { isActive?: boolean } }).data?.isActive === false,
    );
    const teams = createTeamsAdminService({
      prisma,
      writer,
      config: ctx.config,
    } as unknown as AdminDeps);
    const done = teams.archive(sa, teamId, { expectedUpdatedAt: updatedAt.toISOString() });
    return { done, gate: g };
  }

  it('a category created while its team is being archived is refused (E5)', async () => {
    const team = await ctx.fixtures.team();
    const archive = pausedTeamArchive(team.id, team.updatedAt);
    await archive.gate.reached; // the archive locked the team and counted 0 active categories
    const creating = apiAs(ctx, admin).post('/admin/categories', {
      labelEn: `Race ${rand()}`,
      teamId: team.id,
      firstSubtype: { labelEn: 'Race kind' },
    });
    await settledOrBlocked(creating);
    archive.gate.release();
    await expect(archive.done).resolves.toMatchObject({ isActive: false });
    const res = await creating;
    if (res.statusCode === 201) ctx.fixtures.trackCategory(res.json().item.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['teamId'], message: 'validation.teamArchived' }),
      ]),
    );
    expect(await ctx.prisma.category.count({ where: { teamId: team.id, isActive: true } })).toBe(0);
  });

  it('re-routing a category to a team being archived is refused; the form never offers it', async () => {
    const [home, target] = [await ctx.fixtures.team(), await ctx.fixtures.team()];
    const { category } = await ctx.fixtures.category({ teamId: home.id });
    const archive = pausedTeamArchive(target.id, target.updatedAt);
    await archive.gate.reached;
    const moving = apiAs(ctx, admin).patch(`/admin/categories/${category.id}`, {
      expectedUpdatedAt: category.updatedAt.toISOString(),
      teamId: target.id,
    });
    await settledOrBlocked(moving);
    archive.gate.release();
    await archive.done;
    const res = await moving;
    expect(res.statusCode, res.body).toBe(400);
    expect(
      (await ctx.prisma.category.findUniqueOrThrow({ where: { id: category.id } })).teamId,
    ).toBe(home.id);

    // Should a category still end up on an archived team, the form leaves it out.
    await ctx.prisma.team.update({ where: { id: home.id }, data: { isActive: false } });
    await ctx.app.services.ticketConfig.invalidate();
    const form = await ctx.app.services.ticketConfig.getFormConfig();
    expect(form.categories.some((c) => c.id === category.id)).toBe(false);
    await ctx.prisma.team.update({ where: { id: home.id }, data: { isActive: true } });
    await ctx.app.services.ticketConfig.invalidate();
  });

  it('a team escalation rule created while the team is being archived is refused (E5)', async () => {
    const team = await ctx.fixtures.team();
    const archive = pausedTeamArchive(team.id, team.updatedAt);
    await archive.gate.reached;
    const creating = apiAs(ctx, admin).post('/admin/escalation', {
      teamId: team.id,
      step: 1,
      targetType: 'ON_CALL',
      afterMins: 5,
      channels: ['EMAIL'],
    });
    await settledOrBlocked(creating);
    archive.gate.release();
    await archive.done;
    const res = await creating;
    expect(res.statusCode, res.body).toBe(400);
    expect(await ctx.prisma.escalationRule.count({ where: { teamId: team.id } })).toBe(0);
  });

  it('an archived rule of an archived team can’t be restored (409 guard)', async () => {
    const team = await ctx.fixtures.team();
    const rule = await ctx.prisma.escalationRule.create({
      data: {
        priority: 'P1',
        teamId: team.id,
        step: 1,
        targetType: 'ON_CALL',
        afterMins: 5,
        channels: ['EMAIL'],
        isActive: false,
      },
    });
    await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
    const res = await apiAs(ctx, admin).post(`/admin/escalation/${rule.id}/restore`, {
      expectedUpdatedAt: rule.updatedAt.toISOString(),
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details).toMatchObject({
      reason: 'guard',
      guard: 'escalation_team_archived',
    });
    expect(
      await ctx.prisma.escalationRule.count({ where: { teamId: team.id, isActive: true } }),
    ).toBe(0);
    // Restored team: the rule may come back.
    await ctx.prisma.team.update({ where: { id: team.id }, data: { isActive: true } });
    const ok = await apiAs(ctx, admin).post(`/admin/escalation/${rule.id}/restore`, {
      expectedUpdatedAt: rule.updatedAt.toISOString(),
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('archiving the last sub-type waits for General settings choosing its category (E5)', async () => {
    const team = await ctx.fixtures.team();
    const { category, subtypes } = await ctx.fixtures.category({ teamId: team.id });
    // A test copy of tickets.securityCategoryKey (the real one is shared with the dev stack).
    const settingKey = `test-${rand()}.securityCategoryKey`;
    await ctx.prisma.appSetting.create({ data: { key: settingKey, value: 'another-category' } });
    ctx.fixtures.onCleanup(() => ctx.prisma.appSetting.deleteMany({ where: { key: settingKey } }));
    const readKey = async (db: Prisma.TransactionClient) =>
      String((await db.appSetting.findUnique({ where: { key: settingKey } }))?.value ?? '');
    const categories = createCategoriesAdminService(
      { prisma: ctx.prisma, writer: ctx.app.services.admin.writer },
      { securityCategoryKey: readKey },
    );

    // What settings.update does, in its order: lock the setting and the category, check the
    // category has an active sub-type, store the key — and stay open.
    const g = gate();
    const settings = ctx.prisma.$transaction(
      async (tx) => {
        await lockRow(tx, 'AppSetting', settingKey, 'key');
        await lockRow(tx, 'Category', category.key, 'key');
        const active = await tx.subtype.count({
          where: { categoryId: category.id, isActive: true },
        });
        if (active === 0) throw new Error('validation.securityCategory');
        await tx.appSetting.update({ where: { key: settingKey }, data: { value: category.key } });
        await g.arrive();
      },
      { timeout: 20_000 },
    );
    await g.reached;
    const only = subtypes[0]!;
    const archiving = categories.archiveSubtype(sa, category.id, only.id, {
      expectedUpdatedAt: only.updatedAt.toISOString(),
    });
    await settledOrBlocked(archiving);
    g.release();
    await settings;
    await expect(archiving).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'guard', guard: 'security_category_last_subtype' },
    });
    expect(
      await ctx.prisma.subtype.count({ where: { categoryId: category.id, isActive: true } }),
    ).toBe(1);
  });

  it('linking a field from both sides at once never deadlocks (E19: never 500)', async () => {
    const team = await ctx.fixtures.team();
    const { category } = await ctx.fixtures.category({ teamId: team.id });
    const created = await apiAs(ctx, admin).post('/admin/custom-fields', {
      labelEn: `Race field ${rand()}`,
      type: 'TEXT',
    });
    expect(created.statusCode, created.body).toBe(201);
    const field = created.json().item as { id: string; updatedAt: string };
    ctx.fixtures.trackField(field.id);

    // PUT /admin/categories/:id/fields pauses after locking the category, before its link insert.
    const {
      prisma,
      writer,
      gate: g,
    } = gated((model, operation) => model === 'CategoryField' && operation === 'createMany');
    const categories = createCategoriesAdminService({ prisma, writer });
    const linking = categories.setFields(sa, category.id, {
      expectedUpdatedAt: category.updatedAt.toISOString(),
      fieldIds: [field.id],
    });
    await g.reached;
    const patching = apiAs(ctx, admin).patch(`/admin/custom-fields/${field.id}`, {
      expectedUpdatedAt: field.updatedAt,
      categoryIds: [category.id],
    });
    await settledOrBlocked(patching);
    g.release();
    await expect(linking).resolves.toMatchObject({ id: category.id });
    // The category side linked the field first and moved its updatedAt: the field edit, started
    // before, is stale (E19, review shared-db-1) — a 409, never a deadlock or a 500.
    const res = await patching;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details.reason).toBe('stale');
    expect(
      await ctx.prisma.categoryField.count({
        where: { categoryId: category.id, fieldId: field.id },
      }),
    ).toBe(1);
  });

  it('PUT /admin/categories/:id/fields locks the fields before the category (no deadlock)', async () => {
    // A field edit holds its field and then locks the categories; the category side now bumps the
    // fields it links (review shared-db-1), so it must take the fields first as well: otherwise
    // each holds what the other waits for.
    const team = await ctx.fixtures.team();
    const { category } = await ctx.fixtures.category({ teamId: team.id });
    const created = await apiAs(ctx, admin).post('/admin/custom-fields', {
      labelEn: `Race field ${rand()}`,
      type: 'TEXT',
    });
    expect(created.statusCode, created.body).toBe(201);
    const field = created.json().item as { id: string; updatedAt: string };
    ctx.fixtures.trackField(field.id);

    // The field edit pauses after locking its field, before it locks the categories.
    const {
      prisma,
      writer,
      gate: g,
    } = gated((model, operation) => model === 'Category' && operation === 'findMany');
    const fields = createCustomFieldsAdminService({ prisma, writer } as unknown as AdminDeps);
    const patching = fields.update(sa, field.id, {
      expectedUpdatedAt: field.updatedAt,
      categoryIds: [category.id],
    });
    await g.reached;
    const linking = apiAs(ctx, admin).put(`/admin/categories/${category.id}/fields`, {
      expectedUpdatedAt: category.updatedAt.toISOString(),
      fieldIds: [field.id],
    });
    expect(await settledOrBlocked(linking)).toBe('blocked');
    g.release();
    await expect(patching).resolves.toMatchObject({ id: field.id });
    // The field edit linked the category first: this save started before it, so it is stale — a
    // plain stale check (with the current updatedAt), not a deadlock victim.
    const res = await linking;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details).toMatchObject({
      reason: 'stale',
      currentUpdatedAt: expect.any(String),
    });
    expect(
      await ctx.prisma.categoryField.count({
        where: { categoryId: category.id, fieldId: field.id },
      }),
    ).toBe(1);
  });

  it('an escalation delay edit and an archive of the same rule queue, never deadlock', async () => {
    // Every escalation writer takes the chain lock before the rule row (review: setActive took
    // the row first, so a PATCH holding the chain lock and an archive holding the row deadlocked).
    const team = await ctx.fixtures.team();
    const rule = await ctx.prisma.escalationRule.create({
      data: {
        priority: 'P1',
        teamId: team.id,
        step: 1,
        targetType: 'ON_CALL',
        afterMins: 5,
        channels: ['EMAIL'],
      },
    });
    // The archive pauses after it locked the rule (its read of the locked row).
    const {
      prisma,
      writer,
      gate: g,
    } = gated(
      (model, operation) => model === 'EscalationRule' && operation === 'findUniqueOrThrow',
    );
    const escalation = createEscalationAdminService({ prisma, writer } as unknown as AdminDeps);
    const archiving = escalation.setActive(sa, rule.id, false, rule.updatedAt.toISOString());
    await g.reached;
    const patching = apiAs(ctx, admin).patch(`/admin/escalation/${rule.id}`, {
      expectedUpdatedAt: rule.updatedAt.toISOString(),
      afterMins: 10,
    });
    expect(await settledOrBlocked(patching)).toBe('blocked');
    g.release();
    await expect(archiving).resolves.toMatchObject({ id: rule.id, isActive: false });
    // The archive came first: the edit is stale — a plain stale check, not a deadlock victim.
    const res = await patching;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.details).toMatchObject({
      reason: 'stale',
      currentUpdatedAt: expect.any(String),
    });
    expect(
      await ctx.prisma.escalationRule.findUniqueOrThrow({ where: { id: rule.id } }),
    ).toMatchObject({ isActive: false, afterMins: 5 });
  });

  it('write conflicts and deadlocks map to 409 stale, not 500', () => {
    const known = (code: string, meta?: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code,
        clientVersion: 'test',
        ...(meta ? { meta } : {}),
      });
    for (const err of [
      known('P2034'),
      known('P2010', { driverAdapterError: { cause: { originalCode: '40P01' } } }),
      known('P2010', { driverAdapterError: { cause: { originalCode: '40001' } } }),
    ]) {
      expect(mapPrismaError(err)).toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
        details: { reason: 'stale' },
      });
    }
  });
});
