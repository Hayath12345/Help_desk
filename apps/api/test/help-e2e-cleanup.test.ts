import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeE2eHelpArticles } from '../../../packages/db/scripts/e2e-config.ts';
import { acquireTestLock, createTestContext, rand, type TestContext } from './helpers.ts';

// The Playwright teardown's Phase 5 part (packages/db/scripts/e2e-config.ts): the help article the
// done-when spec publishes — key exactly `e2e-<Date.now()>` — goes with its audit rows; articles
// whose key merely starts with `e2e-` (made from an admin's English title) or has another shape
// are never touched.

describe('e2e help-article cleanup', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    // The help-center suites share the global article list: one file at a time.
    ctx.fixtures.onCleanup(await acquireTestLock(ctx.redis, 'help-center'));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('removes the suite’s article (published or not) and its audit rows only', async () => {
    const db = ctx.prisma;
    const stamp = Date.now();
    const suffix = rand(3);
    const keys = {
      suite: `e2e-${stamp}`,
      admin: `e2e-encryption-${suffix}`,
      panel: `e2e-${stamp}-panel`,
      other: `test-e2e-${suffix}`,
    };
    const created = await Promise.all(
      Object.values(keys).map((key, i) =>
        db.helpArticle.create({
          data: { key, titleEn: 'E2E article', bodyEn: 'Text.', sortOrder: 200_000 + i },
        }),
      ),
    );
    const ids = created.map((a) => a.id);
    ctx.fixtures.onCleanup(async () => {
      await db.adminAuditLog.deleteMany({ where: { entityId: { in: ids } } });
      await db.helpArticle.deleteMany({ where: { id: { in: ids } } });
    });
    await db.adminAuditLog.createMany({
      data: created.map((a) => ({ action: 'CREATE', entity: 'HelpArticle', entityId: a.id })),
    });

    // Only this test's keys (a Playwright run may be using its own at the same moment).
    const mine = new Set(Object.values(keys));
    expect(await removeE2eHelpArticles(db, { isKey: (key) => mine.has(key) })).toBe(1);
    const left = await db.helpArticle.findMany({
      where: { id: { in: ids } },
      select: { key: true },
      orderBy: { sortOrder: 'asc' },
    });
    expect(left.map((a) => a.key)).toEqual([keys.admin, keys.panel, keys.other]);
    const audit = await db.adminAuditLog.findMany({
      where: { entityId: { in: ids } },
      select: { entityId: true },
    });
    expect(audit.map((a) => a.entityId).sort()).toEqual(
      created
        .filter((a) => a.key !== keys.suite)
        .map((a) => a.id)
        .sort(),
    );
    // Again: nothing left to remove.
    expect(await removeE2eHelpArticles(db, { isKey: (key) => mine.has(key) })).toBe(0);
  });
});
