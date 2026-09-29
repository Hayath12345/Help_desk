import { z } from 'zod';
import { Prisma, type PrismaClient } from '@loons/db';
import {
  ACTIVE_STATUSES,
  DONE_STATUSES,
  isActive,
  parseTicketNumber,
  type Actor,
  type ListTicketsQuery,
  type StaffView,
  type TicketSort,
  type TicketStatus,
} from '@loons/shared';
import { errors } from '../lib/errors.ts';

// Ticket lists and counts in SQL. Visibility is the same rule as `canViewTicket` (permissions.ts):
// clients see their organisation, agents / team leads their teams plus tickets assigned to them,
// super admins everything. Sorting and the "SLA at risk" predicate need computed expressions, so
// ids are selected with raw SQL (keyset pagination) and the rows hydrated with Prisma.
//
// Timestamps are `timestamp(3)` in UTC; parameters are passed as UTC "YYYY-MM-DD HH:MM:SS.mmm"
// literals cast to `timestamp`, so the session time zone never matters.

type Sql = Prisma.Sql;
const sql = Prisma.sql;

/** A JS instant as a `timestamp` (UTC) SQL value. */
export function sqlTimestamp(value: Date | number): Sql {
  const iso = new Date(value).toISOString().replace('T', ' ').replace('Z', '');
  return sql`${iso}::timestamp`;
}

function statusList(statuses: readonly TicketStatus[]): Sql {
  return Prisma.join(statuses.map((s) => sql`${s}::"TicketStatus"`));
}

export const ACTIVE_SQL = sql`t."status" IN (${statusList(ACTIVE_STATUSES)})`;
export const DONE_SQL = sql`t."status" IN (${statusList(DONE_STATUSES)})`;

/** SQL twin of `canViewTicket` for the ticket alias `t`. */
export function visibleSql(actor: Actor): Sql {
  if (!isActive(actor)) return sql`FALSE`;
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return sql`TRUE`;
    case 'AGENT':
    case 'TEAM_LEAD': {
      const teams = actor.teamIds.length
        ? sql`t."teamId" = ANY(${[...actor.teamIds]}::uuid[])`
        : sql`FALSE`;
      return sql`(${teams} OR t."assigneeId" = ${actor.id}::uuid)`;
    }
    case 'CLIENT':
      return actor.orgId ? sql`t."orgId" = ${actor.orgId}::uuid` : sql`FALSE`;
  }
}

/** The first-reply clock is running: no first reply yet and a target exists (any active status). */
const FIRST_REPLY_RUNNING = sql`(t."firstRepliedAt" IS NULL AND t."firstReplyDueAt" IS NOT NULL)`;

/**
 * SQL twin of `isSlaAtRiskOrBreached` (decisions D1/D2): the running clock (first reply while
 * unanswered — also while PENDING, which only pauses the resolution clock — else resolution) has
 * reached its stored at-risk instant, or its due date has passed. A NULL instant (a ticket from
 * before Phase 3, until the SLA scan backfills it) never matches as "at risk"; overdue still
 * does. Done tickets, and PENDING ones whose first reply was sent, are never at risk.
 */
export function atRiskSql(now: Date): Sql {
  const nowTs = sqlTimestamp(now);
  const clock = (due: Sql, atRiskAt: Sql) =>
    sql`(${due} < ${nowTs} OR COALESCE(${atRiskAt} <= ${nowTs}, FALSE))`;
  return sql`(${ACTIVE_SQL} AND (CASE
    WHEN ${FIRST_REPLY_RUNNING} THEN ${clock(sql`t."firstReplyDueAt"`, sql`t."firstReplyAtRiskAt"`)}
    WHEN t."status" = 'PENDING'::"TicketStatus" THEN FALSE
    ELSE (t."resolveDueAt" IS NOT NULL AND ${clock(sql`t."resolveDueAt"`, sql`t."resolveAtRiskAt"`)})
  END))`;
}

export function staffViewSql(view: StaffView, actor: Actor, now: Date): Sql {
  switch (view) {
    case 'mine':
      return sql`(${ACTIVE_SQL} AND t."assigneeId" = ${actor.id}::uuid)`;
    case 'unassigned':
      return sql`(${ACTIVE_SQL} AND t."assigneeId" IS NULL)`;
    case 'risk':
      return atRiskSql(now);
    case 'p1':
      return sql`(${ACTIVE_SQL} AND t."priority" = 'P1'::"Priority")`;
    case 'open':
      return ACTIVE_SQL;
    case 'solved':
      return DONE_SQL;
  }
}

/** `%term%` for ILIKE with the wildcard characters of the term escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Subject, LG number, requester name / email (the requester is joined as `r`). */
export function searchSql(term: string): Sql {
  const pattern = likePattern(term);
  const number = parseTicketNumber(term);
  const numberMatch =
    number !== null && number <= 2_147_483_647
      ? sql` OR t."number" = ${number}::int`
      : Prisma.empty;
  return sql`(t."subject" ILIKE ${pattern} OR r."name" ILIKE ${pattern} OR r."email" ILIKE ${pattern}${numberMatch})`;
}

// ───────────── Sorting + keyset cursors ─────────────

/**
 * sla: done last; unanswered first; paused (PENDING with no clock running — an unanswered PENDING
 * ticket's first-reply clock still runs) after running; next due date; created.
 */
const SLA_KEYS = {
  done: sql`(${DONE_SQL})::int`,
  replied: sql`(t."firstRepliedAt" IS NOT NULL)::int`,
  paused: sql`(t."status" = 'PENDING'::"TicketStatus" AND NOT ${FIRST_REPLY_RUNNING})::int`,
  due: sql`COALESCE(CASE WHEN t."firstRepliedAt" IS NULL THEN t."firstReplyDueAt" END, t."resolveDueAt")`,
};
const SLA_DUE_SORT = sql`COALESCE(${SLA_KEYS.due}, 'infinity'::timestamp)`;

/**
 * Cursor instants `sqlTimestamp` can write as a literal Postgres accepts (0001-01-01 …
 * 9999-12-31 UTC): anything else in a crafted cursor is a 400, never a 500 (review SEC-API-1).
 */
export const CURSOR_EPOCH_MS = { min: -62_135_596_800_000, max: 253_402_300_799_999 } as const;
const epochMsSchema = z.number().int().min(CURSOR_EPOCH_MS.min).max(CURSOR_EPOCH_MS.max);

const cursorSchema = z.discriminatedUnion('s', [
  z.object({
    s: z.literal('sla'),
    k: z.tuple([
      z.number().int().min(0).max(1),
      z.number().int().min(0).max(1),
      z.number().int().min(0).max(1),
      epochMsSchema.nullable(),
      epochMsSchema,
      z.uuid(),
    ]),
  }),
  z.object({ s: z.literal('recent'), k: z.tuple([epochMsSchema, z.uuid()]) }),
]);
type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string, sort: TicketSort): Cursor {
  let parsed: ReturnType<typeof cursorSchema.safeParse> | null = null;
  try {
    parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    parsed = null;
  }
  if (!parsed?.success || parsed.data.s !== sort) {
    throw errors.validation([
      { location: 'querystring', path: ['cursor'], message: 'validation.invalid', code: 'cursor' },
    ]);
  }
  return parsed.data;
}

interface SlaKeyRow {
  id: string;
  k_done: number;
  k_replied: number;
  k_paused: number;
  k_due: number | null;
  k_created: number;
}
interface RecentKeyRow {
  id: string;
  k_updated: number;
}

const epochMs = (expr: Sql) => sql`(EXTRACT(EPOCH FROM ${expr}) * 1000)::float8`;

export interface ListFilterInput {
  actor: Actor;
  query: ListTicketsQuery;
  now: Date;
}

/** The WHERE conditions of GET /tickets for the caller (without the cursor). */
export function listConditions({ actor, query, now }: ListFilterInput): Sql[] {
  const conditions: Sql[] = [visibleSql(actor)];
  if (actor.role === 'CLIENT') {
    // Clients: tickets they requested by default, or their whole organisation.
    if ((query.scope ?? 'mine') === 'mine')
      conditions.push(sql`t."requesterId" = ${actor.id}::uuid`);
    if (query.tab === 'active') conditions.push(ACTIVE_SQL);
    if (query.tab === 'solved') conditions.push(DONE_SQL);
  } else {
    if (query.view) conditions.push(staffViewSql(query.view, actor, now));
    if (query.teamId) conditions.push(sql`t."teamId" = ${query.teamId}::uuid`);
  }
  if (query.search) conditions.push(searchSql(query.search));
  return conditions;
}

/** Ids of one page of GET /tickets, in order, and the cursor of the next page. */
export async function listTicketIds(
  db: PrismaClient,
  input: ListFilterInput,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const { actor, query } = input;
  const sort: TicketSort = query.sort ?? (actor.role === 'CLIENT' ? 'recent' : 'sla');
  const conditions = listConditions(input);
  const limit = query.limit;
  const from = sql`FROM "Ticket" t JOIN "User" r ON r."id" = t."requesterId"`;

  if (sort === 'sla') {
    if (query.cursor) {
      const [done, replied, paused, due, created, id] = decodeCursor(query.cursor, 'sla').k as [
        number,
        number,
        number,
        number | null,
        number,
        string,
      ];
      const dueSql = due === null ? sql`'infinity'::timestamp` : sqlTimestamp(due);
      conditions.push(
        sql`(${SLA_KEYS.done}, ${SLA_KEYS.replied}, ${SLA_KEYS.paused}, ${SLA_DUE_SORT}, t."createdAt", t."id") > (${done}::int, ${replied}::int, ${paused}::int, ${dueSql}, ${sqlTimestamp(created)}, ${id}::uuid)`,
      );
    }
    const rows = await db.$queryRaw<SlaKeyRow[]>`
      SELECT t."id",
        ${SLA_KEYS.done} AS k_done,
        ${SLA_KEYS.replied} AS k_replied,
        ${SLA_KEYS.paused} AS k_paused,
        ${epochMs(SLA_KEYS.due)} AS k_due,
        ${epochMs(sql`t."createdAt"`)} AS k_created
      ${from}
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${SLA_KEYS.done} ASC, ${SLA_KEYS.replied} ASC, ${SLA_KEYS.paused} ASC,
        ${SLA_DUE_SORT} ASC, t."createdAt" ASC, t."id" ASC
      LIMIT ${limit + 1}::int`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ids: page.map((r) => r.id),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              s: 'sla',
              k: [
                last.k_done,
                last.k_replied,
                last.k_paused,
                last.k_due === null ? null : Math.round(last.k_due),
                Math.round(last.k_created),
                last.id,
              ],
            })
          : null,
    };
  }

  if (query.cursor) {
    const [updated, id] = decodeCursor(query.cursor, 'recent').k as [number, string];
    conditions.push(sql`(t."updatedAt", t."id") < (${sqlTimestamp(updated)}, ${id}::uuid)`);
  }
  const rows = await db.$queryRaw<RecentKeyRow[]>`
    SELECT t."id", ${epochMs(sql`t."updatedAt"`)} AS k_updated
    ${from}
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY t."updatedAt" DESC, t."id" DESC
    LIMIT ${limit + 1}::int`;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    ids: page.map((r) => r.id),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ s: 'recent', k: [Math.round(last.k_updated), last.id] })
        : null,
  };
}

// ───────────── Counts ─────────────

export interface StaffViewCounts {
  mine: number;
  unassigned: number;
  risk: number;
  p1: number;
  open: number;
  solved: number;
}

export async function staffViewCounts(
  db: PrismaClient,
  actor: Actor,
  now: Date,
): Promise<StaffViewCounts> {
  const count = (view: StaffView) =>
    sql`count(*) FILTER (WHERE ${staffViewSql(view, actor, now)})::int`;
  const [row] = await db.$queryRaw<StaffViewCounts[]>`
    SELECT ${count('mine')} AS mine, ${count('unassigned')} AS unassigned, ${count('risk')} AS risk,
      ${count('p1')} AS p1, ${count('open')} AS open, ${count('solved')} AS solved
    FROM "Ticket" t
    WHERE ${visibleSql(actor)}`;
  return row ?? { mine: 0, unassigned: 0, risk: 0, p1: 0, open: 0, solved: 0 };
}

/** Active tickets per team, within what the caller can see. */
export async function activeCountsByTeam(
  db: PrismaClient,
  actor: Actor,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<Array<{ teamId: string; n: number }>>`
    SELECT t."teamId" AS "teamId", count(*)::int AS n
    FROM "Ticket" t
    WHERE ${visibleSql(actor)} AND ${ACTIVE_SQL}
    GROUP BY t."teamId"`;
  return new Map(rows.map((r) => [r.teamId, r.n]));
}

export async function clientTabCounts(
  db: PrismaClient,
  actor: Actor,
): Promise<{ all: number; active: number; solved: number }> {
  const [row] = await db.$queryRaw<Array<{ all: number; active: number; solved: number }>>`
    SELECT count(*)::int AS "all",
      count(*) FILTER (WHERE ${ACTIVE_SQL})::int AS active,
      count(*) FILTER (WHERE ${DONE_SQL})::int AS solved
    FROM "Ticket" t
    WHERE ${visibleSql(actor)} AND t."requesterId" = ${actor.id}::uuid`;
  return row ?? { all: 0, active: 0, solved: 0 };
}
