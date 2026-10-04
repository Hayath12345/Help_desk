import type { Prisma } from '@loons/db';
import { errors } from '../../lib/errors.ts';
import { adminErrors } from './errors.ts';

// Lost-update protection for admin edits (decision E19): every edit sends the `updatedAt` it
// started from (`expectedUpdatedAt`). Inside the write transaction the row is locked
// (SELECT … FOR NO KEY UPDATE) and compared, so of two concurrent saves from the same starting
// point the second waits for the first to commit, then sees the new `updatedAt` and gets 409
// `stale`. NO KEY UPDATE (the lock an UPDATE of non-key columns takes anyway) still lets other
// transactions insert rows that reference the locked one (their foreign-key check takes KEY SHARE):
// a FOR UPDATE here deadlocked the two sides of a category ↔ custom-field link.
//
// Guards that read another row's `isActive` ("the team must be active") read it with
// `shareActive` (FOR SHARE), which waits for a concurrent archive holding the row lock and then
// sees its committed value — otherwise both sides pass their checks (write skew).

type Tx = Prisma.TransactionClient;

/** Tables with an `updatedAt` column that admin edits lock (table name = Prisma model name). */
export const LOCKABLE_TABLES = [
  'Organization',
  'Site',
  'User',
  'Team',
  'Category',
  'Subtype',
  'CustomField',
  'SlaPolicy',
  'BusinessHours',
  'Holiday',
  'EscalationRule',
  'Macro',
  'Skill',
  'EmailTemplate',
  'HelpArticle',
  'AppSetting',
] as const;
export type LockableTable = (typeof LOCKABLE_TABLES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Locks one row until the transaction ends and returns its `updatedAt`, or null when it does not
 * exist. Rows are found by `id` (uuid), or by `key` (AppSetting's primary key; EmailTemplate and
 * the other keyed tables by their unique key).
 */
export async function lockRow(
  tx: Tx,
  table: LockableTable,
  value: string,
  by: 'id' | 'key' = table === 'AppSetting' ? 'key' : 'id',
): Promise<{ updatedAt: Date } | null> {
  if (!(LOCKABLE_TABLES as readonly string[]).includes(table)) {
    throw new TypeError(`lockRow: unknown table ${table}`);
  }
  if (by === 'id' && !UUID.test(value)) return null;
  const column = by === 'id' ? '"id" = $1::uuid' : '"key" = $1';
  const rows = await tx.$queryRawUnsafe<Array<{ updatedAt: Date }>>(
    `SELECT "updatedAt" FROM "${table}" WHERE ${column} FOR NO KEY UPDATE`,
    value,
  );
  return rows[0] ?? null;
}

/** Tables with an `isActive` column whose state a guard in another table depends on. */
export type ShareableTable = 'Team' | 'Category' | 'Organization' | 'CustomField';

/**
 * Reads `isActive` of one row with SELECT … FOR SHARE (null when it does not exist): the read
 * waits for a transaction holding the row lock (an archive) and returns its committed state, and
 * an archive started after it waits until this transaction ends and then sees what it wrote.
 */
export async function shareActive(
  tx: Tx,
  table: ShareableTable,
  value: string,
  by: 'id' | 'key' = 'id',
): Promise<{ isActive: boolean } | null> {
  if (by === 'id' && !UUID.test(value)) return null;
  const column = by === 'id' ? '"id" = $1::uuid' : '"key" = $1';
  const rows = await tx.$queryRawUnsafe<Array<{ isActive: boolean }>>(
    `SELECT "isActive" FROM "${table}" WHERE ${column} FOR SHARE`,
    value,
  );
  return rows[0] ?? null;
}

/**
 * Locks several rows of one table (FOR NO KEY UPDATE) in id order, so two writers that lock
 * overlapping sets can't deadlock. Unknown ids are skipped.
 */
export async function lockRows(
  tx: Tx,
  table: LockableTable,
  ids: readonly string[],
): Promise<void> {
  if (!(LOCKABLE_TABLES as readonly string[]).includes(table)) {
    throw new TypeError(`lockRows: unknown table ${table}`);
  }
  const valid = [...new Set(ids)].filter((id) => UUID.test(id)).sort();
  if (valid.length === 0) return;
  await tx.$queryRawUnsafe(
    `SELECT 1 FROM "${table}" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`,
    valid,
  );
}

/** True when `expected` (ISO string or Date) is exactly `current` (millisecond precision). */
export function sameInstant(current: Date, expected: string | Date): boolean {
  const time = expected instanceof Date ? expected.getTime() : Date.parse(expected);
  return Number.isFinite(time) && current.getTime() === time;
}

/** Throws 409 `stale` unless `current.updatedAt` is `expectedUpdatedAt`. */
export function assertFresh(current: { updatedAt: Date }, expectedUpdatedAt: string | Date): void {
  if (!sameInstant(current.updatedAt, expectedUpdatedAt))
    throw adminErrors.stale(current.updatedAt);
}

/**
 * Locks the row and checks `expectedUpdatedAt` (E19): 404 when the row does not exist, 409 `stale`
 * when someone saved it since. Call it first in the write transaction, then update the row (Prisma
 * sets the new `updatedAt`). Returns the current `updatedAt`.
 */
export async function lockFresh(
  tx: Tx,
  table: LockableTable,
  id: string,
  expectedUpdatedAt: string | Date,
  by?: 'id' | 'key',
): Promise<Date> {
  const row = await lockRow(tx, table, id, by);
  if (!row) throw errors.notFound();
  assertFresh(row, expectedUpdatedAt);
  return row.updatedAt;
}

/**
 * Serialises writers on `name` until the transaction ends (pg_advisory_xact_lock): for checks that
 * span rows — "the last active super admin", "email domains unique across organisations", key
 * generation, reorder.
 */
export async function advisoryLock(tx: Tx, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}
