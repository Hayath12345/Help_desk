import { z } from 'zod';
import { Prisma, type PrismaClient } from '@loons/db';
import {
  ACTIVE_STATUSES,
  DONE_STATUSES,
  PRIORITIES,
  UNASSIGNED_FILTER,
  isActive,
  parseTicketNumber,
  type Actor,
  type ListTicketsQuery,
  type QueueCounts,
  type StaffView,
  type TicketListSort,
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

/**
 * SQL twin of `isSlaOverdue`: the running clock (first reply while unanswered — also while
 * PENDING —, else resolution unless PENDING) has passed its due date.
 */
export function overdueSql(now: Date): Sql {
  const nowTs = sqlTimestamp(now);
  return sql`(${ACTIVE_SQL} AND (CASE
    WHEN ${FIRST_REPLY_RUNNING} THEN t."firstReplyDueAt" < ${nowTs}
    WHEN t."status" = 'PENDING'::"TicketStatus" THEN FALSE
    ELSE COALESCE(t."resolveDueAt" < ${nowTs}, FALSE)
  END))`;
}

/**
 * SQL twin of `hasBreachedSla` (Reports "SLA breached", F10): an active ticket with the stored
 * (sticky) breach flag, overdue now on its running clock, or with a target met late — the first
 * reply sent after its due date, or a PENDING pause (resolution clock stopped) that began after
 * the resolution due date — even when the SLA scan never flagged it (a reply between two scans,
 * the worker down).
 */
export function breachedSql(now: Date): Sql {
  const lateFirstReply = sql`COALESCE(t."firstRepliedAt" > t."firstReplyDueAt", FALSE)`;
  const pausedLate = sql`(t."status" = 'PENDING'::"TicketStatus" AND COALESCE(t."slaPausedAt" > t."resolveDueAt", FALSE))`;
  return sql`(${ACTIVE_SQL} AND (t."slaBreached" OR ${overdueSql(now)} OR ${lateFirstReply} OR ${pausedLate}))`;
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
  z.object({
    s: z.literal('priority'),
    k: z.tuple([
      z.number().int().min(0).max(1),
      z.enum(PRIORITIES),
      z.number().int().min(0).max(1),
      epochMsSchema.nullable(),
      epochMsSchema,
      z.uuid(),
    ]),
  }),
]);
type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string, sort: TicketListSort): Cursor {
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

/** The filters of a ticket list (GET /tickets without sort and paging; the queue's tab counts). */
export type TicketListFilter = Partial<
  Pick<
    ListTicketsQuery,
    | 'view'
    | 'tab'
    | 'scope'
    | 'search'
    | 'teamId'
    | 'priority'
    | 'categoryId'
    | 'assigneeId'
    | 'orgId'
    | 'requesterId'
  >
>;

export interface ListFilterInput {
  actor: Actor;
  query: TicketListFilter;
  now: Date;
}

/** Tickets with the requester joined as `r` (search matches the requester's name and email). */
const LIST_FROM = sql`FROM "Ticket" t JOIN "User" r ON r."id" = t."requesterId"`;

/**
 * The WHERE conditions of GET /tickets for the caller (without the cursor). Every filter is ANDed
 * onto the visibility rule, so none can widen what the caller sees; the staff filters (view, team,
 * priority, category, assignee, organisation, requester) are ignored for clients.
 */
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
    if (query.priority) conditions.push(sql`t."priority" = ${query.priority}::"Priority"`);
    if (query.categoryId) conditions.push(sql`t."categoryId" = ${query.categoryId}::uuid`);
    if (query.assigneeId === UNASSIGNED_FILTER) conditions.push(sql`t."assigneeId" IS NULL`);
    else if (query.assigneeId) conditions.push(sql`t."assigneeId" = ${query.assigneeId}::uuid`);
    if (query.orgId) conditions.push(sql`t."orgId" = ${query.orgId}::uuid`);
    if (query.requesterId) conditions.push(sql`t."requesterId" = ${query.requesterId}::uuid`);
  }
  if (query.search) conditions.push(searchSql(query.search));
  return conditions;
}

/**
 * priority: done last, P1 → P4 (enum order), paused after running within a priority (a PENDING
 * ticket waiting on the client keeps a stale resolution due date that must not put it first —
 * as in the Inbox SLA sort), then the next SLA due date, created, id.
 */
const PRIORITY_KEYS = {
  done: SLA_KEYS.done,
  priority: sql`t."priority"`,
  paused: SLA_KEYS.paused,
};

interface PriorityKeyRow {
  id: string;
  k_done: number;
  k_priority: (typeof PRIORITIES)[number];
  k_paused: number;
  k_due: number | null;
  k_created: number;
}

/** Ids of one page of GET /tickets, in order, and the cursor of the next page. */
export async function listTicketIds(
  db: PrismaClient,
  input: { actor: Actor; query: ListTicketsQuery; now: Date },
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const { actor, query } = input;
  const sort: TicketListSort = query.sort ?? (actor.role === 'CLIENT' ? 'recent' : 'sla');
  const conditions = listConditions(input);
  const limit = query.limit;
  const from = LIST_FROM;

  if (sort === 'priority') {
    if (query.cursor) {
      const [done, priority, paused, due, created, id] = decodeCursor(query.cursor, 'priority')
        .k as [number, string, number, number | null, number, string];
      const dueSql = due === null ? sql`'infinity'::timestamp` : sqlTimestamp(due);
      conditions.push(
        sql`(${PRIORITY_KEYS.done}, ${PRIORITY_KEYS.priority}, ${PRIORITY_KEYS.paused}, ${SLA_DUE_SORT}, t."createdAt", t."id") > (${done}::int, ${priority}::"Priority", ${paused}::int, ${dueSql}, ${sqlTimestamp(created)}, ${id}::uuid)`,
      );
    }
    const rows = await db.$queryRaw<PriorityKeyRow[]>`
      SELECT t."id",
        ${PRIORITY_KEYS.done} AS k_done,
        ${PRIORITY_KEYS.priority}::text AS k_priority,
        ${PRIORITY_KEYS.paused} AS k_paused,
        ${epochMs(SLA_KEYS.due)} AS k_due,
        ${epochMs(sql`t."createdAt"`)} AS k_created
      ${from}
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${PRIORITY_KEYS.done} ASC, ${PRIORITY_KEYS.priority} ASC, ${PRIORITY_KEYS.paused} ASC,
        ${SLA_DUE_SORT} ASC, t."createdAt" ASC, t."id" ASC
      LIMIT ${limit + 1}::int`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      ids: page.map((r) => r.id),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              s: 'priority',
              k: [
                last.k_done,
                last.k_priority,
                last.k_paused,
                last.k_due === null ? null : Math.round(last.k_due),
                Math.round(last.k_created),
                last.id,
              ],
            })
          : null,
    };
  }

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

/**
 * Team queue tab counts (F3) for the list filters and search: each is the length of GET /tickets
 * with the same filters and the tab's view (same conditions, same requester join).
 */
export async function queueTabCounts(
  db: PrismaClient,
  actor: Actor,
  filters: Omit<TicketListFilter, 'view' | 'tab' | 'scope'>,
  now: Date,
): Promise<QueueCounts['tabs']> {
  const conditions = listConditions({ actor, query: filters, now });
  const count = (view: StaffView) =>
    sql`count(*) FILTER (WHERE ${staffViewSql(view, actor, now)})::int`;
  const [row] = await db.$queryRaw<Array<QueueCounts['tabs']>>`
    SELECT ${count('open')} AS open, ${count('unassigned')} AS unassigned,
      ${count('risk')} AS breaching, ${count('solved')} AS solved
    ${LIST_FROM}
    WHERE ${Prisma.join(conditions, ' AND ')}`;
  return row ?? { open: 0, unassigned: 0, breaching: 0, solved: 0 };
}

/**
 * Open tickets assigned to each of `assigneeIds` that the caller can see, and how many of them
 * are "Breaching soon" (the `risk` view) — the agent cards (F5).
 */
export async function assigneeWorkload(
  db: PrismaClient,
  actor: Actor,
  assigneeIds: readonly string[],
  now: Date,
): Promise<Map<string, { open: number; atRisk: number }>> {
  if (assigneeIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ assigneeId: string; open: number; atRisk: number }>>`
    SELECT t."assigneeId" AS "assigneeId", count(*)::int AS open,
      count(*) FILTER (WHERE ${atRiskSql(now)})::int AS "atRisk"
    FROM "Ticket" t
    WHERE ${visibleSql(actor)} AND ${ACTIVE_SQL}
      AND t."assigneeId" = ANY(${[...assigneeIds]}::uuid[])
    GROUP BY t."assigneeId"`;
  return new Map(rows.map((r) => [r.assigneeId, { open: r.open, atRisk: r.atRisk }]));
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
