import { z } from 'zod';
import { Prisma, type PrismaClient } from '@loons/db';
import type { Actor, ContractType, CustomerList, CustomerOrg, CustomersQuery } from '@loons/shared';
import { errors } from '../lib/errors.ts';
import { localDate } from '../jobs/local-time.ts';
import { requireStaff } from './ticket-access.ts';
import type { TicketConfigService } from './ticket-config.service.ts';
import { ACTIVE_SQL, visibleSql } from './ticket-query.ts';

// Phase 5 Customers (decisions F8, F9). Staff only. One row per active client requester — the same
// people the requester search offers staff (active, verified clients of active organisations,
// `REQUESTER_WHERE`) — sorted by name and keyset-paged over (name, id); the open / total ticket
// counts count only tickets the caller can see (the Inbox visibility). Header totals cover the
// whole search. `org(id)` gives the Inbox company view its title.

type Sql = Prisma.Sql;
const sql = Prisma.sql;

export interface CustomersService {
  list(actor: Actor, query: CustomersQuery): Promise<CustomerList>;
  org(actor: Actor, orgId: string): Promise<CustomerOrg>;
}

// Postgres text can't hold U+0000: a crafted cursor with one is a 400, never a 500.
const cursorSchema = z.object({
  n: z
    .string()
    .max(1000)
    .refine((n) => !n.includes('\u0000')),
  i: z.uuid(),
});

/**
 * Names sort in the Unicode root collation (ICU), not byte order: case and accents sort next to
 * the plain letter ("zeta, Zeta, ZETA, Zéta, Zz"). Deterministic (ties fall back to the bytes), so
 * (name, id) stays a strict keyset; the cursor comparison uses the same collation.
 */
const NAME_ORDER = sql`u."name" COLLATE "und-x-icu"`;

export function encodeCustomerCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: id }), 'utf8').toString('base64url');
}

function decodeCustomerCursor(raw: string): { n: string; i: string } {
  let parsed: ReturnType<typeof cursorSchema.safeParse> | null = null;
  try {
    parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    throw errors.validation([
      { location: 'querystring', path: ['cursor'], message: 'validation.invalid', code: 'cursor' },
    ]);
  }
  return parsed.data;
}

/** `%term%` for ILIKE with the wildcard characters of the term escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** SQL twin of `REQUESTER_WHERE` (directory.service.ts) for users `u` of organisations `o`. */
const REQUESTER_SQL = sql`u."role" = 'CLIENT'::"Role" AND u."status" = 'ACTIVE'::"UserStatus"
  AND u."emailVerifiedAt" IS NOT NULL AND o."isActive" = TRUE`;

interface OrgRow {
  id: string;
  name: string;
  nameAr: string | null;
  contractType: ContractType;
  /** A `@db.Date` (midnight UTC) or its "YYYY-MM-DD". */
  amcExpiry: Date | string | null;
  isActive: boolean;
}

/** An AMC is expired once its last day ("YYYY-MM-DD") is before `today` (business time zone). */
function toCustomerOrg(org: OrgRow, today: string): CustomerOrg {
  const amcExpiry =
    org.amcExpiry instanceof Date ? org.amcExpiry.toISOString().slice(0, 10) : org.amcExpiry;
  return {
    id: org.id,
    name: org.name,
    nameAr: org.nameAr,
    contractType: org.contractType,
    amcExpiry,
    amcExpired: org.contractType === 'AMC' && amcExpiry !== null && amcExpiry < today,
    isActive: org.isActive,
  };
}

export function createCustomersService(deps: {
  prisma: PrismaClient;
  ticketConfig: TicketConfigService;
  /** Clock (tests). */
  now?: () => Date;
}): CustomersService {
  const { prisma, ticketConfig } = deps;
  const clock = deps.now ?? (() => new Date());

  const today = async () => localDate(clock(), (await ticketConfig.getCalendar()).timeZone);

  return {
    async list(actor, query) {
      requireStaff(actor);
      const search = query.search?.trim();
      const conditions: Sql[] = [REQUESTER_SQL];
      if (search) {
        const pattern = likePattern(search);
        conditions.push(
          sql`(u."name" ILIKE ${pattern} OR u."email" ILIKE ${pattern} OR o."name" ILIKE ${pattern} OR COALESCE(o."nameAr", '') ILIKE ${pattern})`,
        );
      }
      const where = Prisma.join(conditions, ' AND ');
      const cursor = query.cursor ? decodeCustomerCursor(query.cursor) : null;
      const pageWhere = cursor
        ? sql`${where} AND (${NAME_ORDER}, u."id") > (${cursor.n}::text COLLATE "und-x-icu", ${cursor.i}::uuid)`
        : where;
      const from = sql`FROM "User" u JOIN "Organization" o ON o."id" = u."orgId"`;

      const [rows, totals, day] = await Promise.all([
        prisma.$queryRaw<
          Array<{
            id: string;
            name: string;
            email: string;
            orgId: string;
            orgName: string;
            orgNameAr: string | null;
            contractType: ContractType;
            amcExpiry: string | null;
            orgActive: boolean;
          }>
        >`
          SELECT u."id", u."name", u."email", o."id" AS "orgId", o."name" AS "orgName",
            o."nameAr" AS "orgNameAr", o."contractType"::text AS "contractType",
            to_char(o."amcExpiry", 'YYYY-MM-DD') AS "amcExpiry", o."isActive" AS "orgActive"
          ${from}
          WHERE ${pageWhere}
          ORDER BY ${NAME_ORDER} ASC, u."id" ASC
          LIMIT ${query.limit + 1}::int`,
        prisma.$queryRaw<Array<{ requesters: number; companies: number }>>`
          SELECT count(*)::int AS requesters, count(DISTINCT u."orgId")::int AS companies
          ${from}
          WHERE ${where}`,
        today(),
      ]);
      const page = rows.slice(0, query.limit);
      const ids = page.map((r) => r.id);
      const counts = ids.length
        ? await prisma.$queryRaw<Array<{ requesterId: string; open: number; total: number }>>`
            SELECT t."requesterId" AS "requesterId",
              count(*) FILTER (WHERE ${ACTIVE_SQL})::int AS open, count(*)::int AS total
            FROM "Ticket" t
            WHERE ${visibleSql(actor)} AND t."requesterId" = ANY(${ids}::uuid[])
            GROUP BY t."requesterId"`
        : [];
      const byRequester = new Map(counts.map((c) => [c.requesterId, c]));
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          org: toCustomerOrg(
            {
              id: r.orgId,
              name: r.orgName,
              nameAr: r.orgNameAr,
              contractType: r.contractType,
              amcExpiry: r.amcExpiry,
              isActive: r.orgActive,
            },
            day,
          ),
          open: byRequester.get(r.id)?.open ?? 0,
          total: byRequester.get(r.id)?.total ?? 0,
        })),
        nextCursor:
          rows.length > query.limit && last ? encodeCustomerCursor(last.name, last.id) : null,
        totals: totals[0] ?? { requesters: 0, companies: 0 },
      };
    },

    async org(actor, orgId) {
      requireStaff(actor);
      const [org, day] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: orgId },
          select: {
            id: true,
            name: true,
            nameAr: true,
            contractType: true,
            amcExpiry: true,
            isActive: true,
          },
        }),
        today(),
      ]);
      if (!org) throw errors.notFound('Organisation not found');
      return toCustomerOrg(org, day);
    },
  };
}
