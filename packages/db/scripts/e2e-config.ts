// Config rows the Playwright admin spec creates (apps/web/e2e/admin.spec.ts) and the teardown
// removes again: categories (with their sub-types and field links) and custom fields whose key is
// exactly what the spec generates — `e2e-<Date.now()>` and `e2e-<Date.now()>-panel`. A plain
// `e2e-` prefix is not enough: admin keys are generated from English labels, so "E2E encryption"
// becomes `e2e-encryption` (review api-setup-1). The spec creates no macros, so none are removed.
// Their audit rows go too. The config cache is busted afterwards so no API instance keeps serving
// them (packages/db cannot import the API: the caller passes the Redis helper).
import type { Prisma, PrismaClient } from '../src/index.ts';

export const E2E_CONFIG_KEY_PREFIX = 'e2e-';

/** `e2e-` + a 13-digit millisecond timestamp, optionally `-panel` (the spec's custom field). */
const E2E_CONFIG_KEY = /^e2e-\d{13}(?:-panel)?$/;

/** A key the admin spec generates: `e2e-<Date.now()>` or `e2e-<Date.now()>-panel`. */
export function isE2eConfigKey(key: string): boolean {
  return E2E_CONFIG_KEY.test(key);
}

/** Prisma pre-filter on a `key` column (narrow the rows with `isE2eConfigKey` afterwards). */
export function e2eConfigKeyWhere(): { key: { startsWith: string } } {
  return { key: { startsWith: E2E_CONFIG_KEY_PREFIX } };
}

export interface E2eConfigRemoval {
  categories: number;
  fields: number;
  /** Categories kept because a ticket that is not the suite's still uses them. */
  keptCategories: string[];
  /** Custom fields kept because a ticket that is not the suite's still holds a value for them. */
  keptFields: string[];
}

export interface RemoveE2eConfigOptions {
  /**
   * Which spec-shaped keys to remove (default: every one, `isE2eConfigKey`). A test passes only
   * the keys it created, so it never removes rows a Playwright run is using at the same moment.
   */
  isKey?: (key: string) => boolean;
}

/**
 * Deletes the admin spec's config rows in one transaction. Run it after the suite's tickets are
 * gone: a category or custom field another ticket still uses is kept and reported.
 */
export async function removeE2eConfig(
  db: PrismaClient,
  options: RemoveE2eConfigOptions = {},
): Promise<E2eConfigRemoval> {
  const isKey = (key: string) => isE2eConfigKey(key) && (options.isKey?.(key) ?? true);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const categories = (
      await tx.category.findMany({
        where: e2eConfigKeyWhere(),
        select: { id: true, key: true, _count: { select: { tickets: true } } },
      })
    ).filter((c) => isKey(c.key));
    const kept = categories.filter((c) => c._count.tickets > 0);
    const categoryIds = categories.filter((c) => c._count.tickets === 0).map((c) => c.id);
    const fields = (
      await tx.customField.findMany({ where: e2eConfigKeyWhere(), select: { id: true, key: true } })
    ).filter((f) => isKey(f.key));
    // Ticket values are keyed by CustomField.key.
    const fieldKeys = fields.map((f) => f.key);
    const keptFields = fieldKeys.length
      ? (
          await tx.$queryRaw<Array<{ key: string }>>`
            SELECT k AS key FROM unnest(${fieldKeys}::text[]) AS k
            WHERE EXISTS (SELECT 1 FROM "Ticket" t WHERE jsonb_exists(t."customFields", k))`
        ).map((r) => r.key)
      : [];
    const fieldIds = fields.filter((f) => !keptFields.includes(f.key)).map((f) => f.id);
    const subtypeIds = categoryIds.length
      ? (
          await tx.subtype.findMany({
            where: { categoryId: { in: categoryIds } },
            select: { id: true },
          })
        ).map((s) => s.id)
      : [];

    // Their audit rows (CategoryField rows are keyed "<categoryId>:<fieldId>").
    const entityIds = [...categoryIds, ...subtypeIds, ...fieldIds];
    if (entityIds.length) {
      await tx.adminAuditLog.deleteMany({
        where: {
          OR: [
            { entityId: { in: entityIds } },
            ...categoryIds.map((id) => ({ entityId: { startsWith: `${id}:` } })),
          ],
        },
      });
    }
    // Field links cascade with either side; sub-types restrict the category delete.
    if (categoryIds.length) {
      await tx.subtype.deleteMany({ where: { categoryId: { in: categoryIds } } });
      await tx.category.deleteMany({ where: { id: { in: categoryIds } } });
    }
    if (fieldIds.length) await tx.customField.deleteMany({ where: { id: { in: fieldIds } } });
    return {
      categories: categoryIds.length,
      fields: fieldIds.length,
      keptCategories: kept.map((c) => c.key),
      keptFields,
    };
  });
}

/** Redis commands the cache bust needs (an ioredis client fits). */
export interface ConfigCacheRedis {
  multi(): {
    incr(key: string): unknown;
    del(...keys: string[]): unknown;
    exec(): Promise<unknown>;
  };
}

/**
 * Busts the API's config cache the way an admin change does (E18): bump the generation first (a
 * loader that read the old one can't write back), then drop the cached form config and calendar.
 */
export async function bustConfigCache(redis: ConfigCacheRedis, prefix = 'loons:'): Promise<void> {
  const multi = redis.multi();
  multi.incr(`${prefix}config:gen`);
  multi.del(`${prefix}config:ticket-form`, `${prefix}config:sla-calendar`);
  await multi.exec();
}
