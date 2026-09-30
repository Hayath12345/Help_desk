import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bustConfigCache, removeE2eConfig } from '../../../packages/db/scripts/e2e-config.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { createTicket, createWorld, ticketBody, type World } from './ticket-world.ts';

// The Playwright teardown's Phase 4 part (packages/db/scripts/e2e-config.ts): config rows whose key
// is exactly what the admin spec generates (`e2e-<Date.now()>`, `e2e-<Date.now()>-panel`) go
// (categories with sub-types and field links, custom fields, their audit rows); a category a real
// ticket still uses stays, and so does a field a real ticket holds a value for; admin-made rows
// whose key merely starts with `e2e-` ("E2E encryption" → `e2e-encryption`) and macros are never
// touched (review api-setup-1); and the config cache is busted.

describe('e2e config cleanup', () => {
  let ctx: TestContext;
  let w: World;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('removes the suite’s categories, sub-types, links, fields and their audit rows only', async () => {
    const stamp = Date.now();
    const db = ctx.prisma;
    const category = await db.category.create({
      data: { key: `e2e-${stamp}`, labelEn: 'E2E cat', teamId: w.teamA.id, sortOrder: 10_000 },
    });
    ctx.fixtures.trackCategory(category.id);
    const subtype = await db.subtype.create({
      data: { categoryId: category.id, key: 'kind', labelEn: 'Kind' },
    });
    const field = await db.customField.create({
      data: { key: `e2e-${stamp}-panel`, labelEn: 'E2E field', type: 'TEXT' },
    });
    ctx.fixtures.trackField(field.id);
    await db.categoryField.create({ data: { categoryId: category.id, fieldId: field.id } });
    await db.adminAuditLog.createMany({
      data: [
        { action: 'CREATE', entity: 'Category', entityId: category.id },
        { action: 'CREATE', entity: 'CategoryField', entityId: `${category.id}:${field.id}` },
      ],
    });
    // Removed by the cleanup under test — and by the fixtures if it fails.
    ctx.fixtures.onCleanup(() =>
      db.adminAuditLog.deleteMany({
        where: { entityId: { in: [category.id, `${category.id}:${field.id}`] } },
      }),
    );

    // Not the suite's: admin-made rows whose generated key starts with `e2e-`, a macro with the
    // suite's key shape (the spec creates none), a key that merely contains "e2e".
    const suffix = rand(3);
    const adminCategory = await db.category.create({
      data: {
        key: `e2e-encryption-${suffix}`,
        labelEn: 'E2E Encryption',
        teamId: w.teamA.id,
        sortOrder: 10_000,
      },
    });
    ctx.fixtures.trackCategory(adminCategory.id);
    await db.subtype.create({
      data: { categoryId: adminCategory.id, key: 'kind', labelEn: 'Kind' },
    });
    const adminField = await db.customField.create({
      data: { key: `e2e-monitoring-${suffix}`, labelEn: 'E2E monitoring', type: 'TEXT' },
    });
    ctx.fixtures.trackField(adminField.id);
    await db.categoryField.create({
      data: { categoryId: adminCategory.id, fieldId: adminField.id },
    });
    const macros = await Promise.all(
      [`e2e-encryption-notice-${suffix}`, `e2e-${stamp}`, `test-e2e-${suffix}`].map((key) =>
        db.macro.create({ data: { key, titleEn: 'Keep me', bodyEn: 'Hi' } }),
      ),
    );
    const macroIds = macros.map((m) => m.id);
    ctx.fixtures.onCleanup(() => db.macro.deleteMany({ where: { id: { in: macroIds } } }));
    await db.adminAuditLog.createMany({
      data: [
        { action: 'CREATE', entity: 'Category', entityId: adminCategory.id },
        { action: 'CREATE', entity: 'Macro', entityId: macroIds[0]! },
      ],
    });
    ctx.fixtures.onCleanup(() =>
      db.adminAuditLog.deleteMany({
        where: { entityId: { in: [adminCategory.id, macroIds[0]!] } },
      }),
    );

    // A suite category that a real (non-suite) ticket uses is kept, and so is a suite field that
    // a real ticket holds a value for.
    const used = await db.category.create({
      data: {
        key: `e2e-${stamp + 1}`,
        labelEn: 'E2E used',
        teamId: w.teamA.id,
        sortOrder: 10_000,
      },
    });
    ctx.fixtures.trackCategory(used.id);
    const usedSubtype = await db.subtype.create({
      data: { categoryId: used.id, key: 'kind', labelEn: 'Kind' },
    });
    const usedField = await db.customField.create({
      data: { key: `e2e-${stamp + 1}-panel`, labelEn: 'E2E used field', type: 'TEXT' },
    });
    ctx.fixtures.trackField(usedField.id);
    await ctx.app.services.ticketConfig.invalidate();
    const ticket = await createTicket(
      ctx,
      w.clientX,
      ticketBody(w, { categoryId: used.id, subtypeId: usedSubtype.id }),
    );
    await db.ticket.update({
      where: { id: ticket.id },
      data: { customFields: { [usedField.key]: 'P-12' } },
    });

    // A Playwright run going on at the same moment: its spec-shaped rows are not this test's.
    const concurrent = await db.category.create({
      data: {
        key: `e2e-${stamp + 2}`,
        labelEn: 'E2E live run',
        teamId: w.teamA.id,
        sortOrder: 10_000,
      },
    });
    ctx.fixtures.trackCategory(concurrent.id);
    const concurrentField = await db.customField.create({
      data: { key: `e2e-${stamp + 2}-panel`, labelEn: 'E2E live run field', type: 'TEXT' },
    });
    ctx.fixtures.trackField(concurrentField.id);

    const ours = new Set([category.key, field.key, used.key, usedField.key]);
    const removed = await removeE2eConfig(db, { isKey: (key) => ours.has(key) });
    expect(await db.category.findUnique({ where: { id: concurrent.id } })).not.toBeNull();
    expect(await db.customField.findUnique({ where: { id: concurrentField.id } })).not.toBeNull();
    expect(removed.categories).toBeGreaterThanOrEqual(1);
    expect(removed.fields).toBeGreaterThanOrEqual(1);
    expect(removed.keptCategories).toContain(used.key);
    expect(removed.keptFields).toContain(usedField.key);
    expect(await db.category.findUnique({ where: { id: category.id } })).toBeNull();
    expect(await db.subtype.findUnique({ where: { id: subtype.id } })).toBeNull();
    expect(await db.customField.findUnique({ where: { id: field.id } })).toBeNull();
    expect(await db.categoryField.count({ where: { categoryId: category.id } })).toBe(0);
    expect(
      await db.adminAuditLog.count({
        where: {
          OR: [{ entityId: category.id }, { entityId: { startsWith: `${category.id}:` } }],
        },
      }),
    ).toBe(0);
    expect(await db.category.findUnique({ where: { id: used.id } })).not.toBeNull();
    expect(await db.customField.findUnique({ where: { id: usedField.id } })).not.toBeNull();
    // Admin-made rows and every macro survive, with their links and audit history.
    expect(await db.category.findUnique({ where: { id: adminCategory.id } })).not.toBeNull();
    expect(await db.customField.findUnique({ where: { id: adminField.id } })).not.toBeNull();
    expect(await db.categoryField.count({ where: { categoryId: adminCategory.id } })).toBe(1);
    expect(await db.macro.count({ where: { id: { in: macroIds } } })).toBe(3);
    expect(
      await db.adminAuditLog.count({
        where: { entityId: { in: [adminCategory.id, macroIds[0]!] } },
      }),
    ).toBe(2);
  });

  it('busts the config cache: the generation moves and the cached form config is gone', async () => {
    const prefix = ctx.config.redisPrefix;
    const config = ctx.app.services.ticketConfig;
    await config.getFormConfig(); // cached
    const before = (await config.currentVersion()) ?? 0;
    expect(await ctx.redis.exists(`${prefix}config:ticket-form`)).toBe(1);
    await bustConfigCache(ctx.redis, prefix);
    expect(await config.currentVersion()).toBe(before + 1);
    expect(await ctx.redis.exists(`${prefix}config:ticket-form`)).toBe(0);
  });
});
