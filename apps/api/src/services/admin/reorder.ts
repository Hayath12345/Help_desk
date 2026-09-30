import type { Prisma } from '@loons/db';
import type { ReorderBody } from '@loons/shared';
import { advisoryLock } from './concurrency.ts';
import { adminErrors } from './errors.ts';

// Reordering (decision E3): one request per drop with the order the client started from
// (`expectedIds`) and the new order (`ids`). Under a lock per list, the current order must still be
// `expectedIds` (else 409 `order_changed`); the new positions are written in one statement. Sort
// columns are not the rows' content, so `updatedAt` does not move (an open edit sheet of a row
// that was only moved still saves).

type Tx = Prisma.TransactionClient;

/** Tables ordered by a `sortOrder` column. */
export const SORTABLE_TABLES = [
  'Category',
  'Subtype',
  'Team',
  'Site',
  'Macro',
  'HelpArticle',
] as const;
export type SortableTable = (typeof SORTABLE_TABLES)[number];

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export interface ReorderInput {
  /** Names the list (e.g. `Category`, `Subtype:<categoryId>`, `Macro:global`): its lock. */
  list: string;
  body: ReorderBody;
  /** The list's ids in their current order, read under the lock. */
  currentIds: () => Promise<string[]>;
  /** Writes the new order (e.g. `writeSortOrder`). */
  write: (ids: string[]) => Promise<void>;
}

/**
 * Applies a reorder inside the caller's transaction. Returns the old and new order for the audit
 * log, or null when the order did not change. 409 `order_changed` when the list is not
 * `expectedIds` any more.
 */
export async function applyReorder(
  tx: Tx,
  input: ReorderInput,
): Promise<{ before: string[]; after: string[] } | null> {
  await advisoryLock(tx, `reorder:${input.list}`);
  const current = await input.currentIds();
  if (!sameSequence(current, input.body.expectedIds)) throw adminErrors.orderChanged();
  if (sameSequence(current, input.body.ids)) return null;
  await input.write(input.body.ids);
  return { before: current, after: [...input.body.ids] };
}

/** `sortOrder` = position × step + start for the given ids (other rows untouched). */
export async function writeSortOrder(
  tx: Tx,
  table: SortableTable,
  ids: readonly string[],
  options: { start?: number; step?: number } = {},
): Promise<void> {
  if (!(SORTABLE_TABLES as readonly string[]).includes(table)) {
    throw new TypeError(`writeSortOrder: unknown table ${table}`);
  }
  const start = options.start ?? 0;
  const step = options.step ?? 1;
  await tx.$executeRawUnsafe(
    `UPDATE "${table}" AS t SET "sortOrder" = ((v.ord - 1) * $2::int) + $3::int
     FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, ord) WHERE t.id = v.id`,
    [...ids],
    step,
    start,
  );
}

/** The custom fields of one category in form order (CategoryField.sortOrder = 0…n-1). */
export async function writeCategoryFieldOrder(
  tx: Tx,
  categoryId: string,
  fieldIds: readonly string[],
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE "CategoryField" AS t SET "sortOrder" = v.ord - 1
     FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, ord)
     WHERE t."categoryId" = $1::uuid AND t."fieldId" = v.id`,
    categoryId,
    [...fieldIds],
  );
}

/** Columns numbered under a unique constraint (renumbered in two phases). */
export const RENUMBERABLE = { EscalationRule: 'step' } as const;
/** Added in the first phase: above every real value (steps are 1…20), within CHECK step >= 1. */
export const RENUMBER_TEMP_OFFSET = 100_000;

/**
 * Numbers rows `start`, `start + 1`… in `ids` order when the column is unique within a scope
 * (EscalationRule.step: unique per (priority, teamId), archived rows included). First every row
 * moves above RENUMBER_TEMP_OFFSET, then to its final number, so no intermediate state collides
 * with a row being renumbered. Rows not in `ids` keep their numbers; the caller includes every row
 * of the scope whose number could collide (archived ones too, usually after the active ones).
 */
export async function renumberUnique(
  tx: Tx,
  table: keyof typeof RENUMBERABLE,
  ids: readonly string[],
  start = 1,
): Promise<void> {
  const column = RENUMBERABLE[table];
  if (!column) throw new TypeError(`renumberUnique: unknown table ${String(table)}`);
  const update = (expression: string) =>
    tx.$executeRawUnsafe(
      `UPDATE "${table}" AS t SET "${column}" = ${expression}
       FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, ord) WHERE t.id = v.id`,
      [...ids],
    );
  const first = Math.trunc(start);
  await update(`v.ord + ${RENUMBER_TEMP_OFFSET}`);
  await update(`v.ord - 1 + ${first}`);
}
