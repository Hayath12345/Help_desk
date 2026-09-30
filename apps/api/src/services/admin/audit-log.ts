import type { Prisma } from '@loons/db';
import type {
  AuditLogActorList,
  AuditLogEntryDto,
  AuditLogList,
  AuditLogQuery,
} from '@loons/shared';
import { errors } from '../../lib/errors.ts';
import { requireSuperAdmin } from './authz.ts';
import type { AdminDeps } from './deps.ts';
import type { AdminContext } from './write.ts';

// Admin — Audit log viewer (spec §10.11; decision E17). Super admins only, read-only: the rows are
// written by the admin writer (./audit.ts) in the same transaction as each change, already
// redacted, and there is no route that changes or deletes them. Newest first, cursor-paged over
// (createdAt, id): the cursor is the last row's pair, so rows added while paging never shift a page.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeAuditCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** The cursor's (createdAt, id), or null when it is not one this API handed out. */
export function decodeAuditCursor(value: string): Cursor | null {
  const raw = Buffer.from(value, 'base64url').toString('utf8');
  const [at, id, ...rest] = raw.split('|');
  if (rest.length > 0 || !at || !id || !UUID.test(id)) return null;
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at) return null;
  return { createdAt, id };
}

const entrySelect = {
  id: true,
  action: true,
  entity: true,
  entityId: true,
  entityLabel: true,
  requestId: true,
  before: true,
  after: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
} as const satisfies Prisma.AdminAuditLogSelect;

type EntryRow = Prisma.AdminAuditLogGetPayload<{ select: typeof entrySelect }>;

/** A stored before / after: an object of fields (anything else is shown under `value`). */
function fieldsOf(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

export function toAuditLogEntryDto(row: EntryRow): AuditLogEntryDto {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    requestId: row.requestId,
    before: fieldsOf(row.before),
    after: fieldsOf(row.after),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AuditLogAdminService {
  list(ctx: AdminContext, query: AuditLogQuery): Promise<AuditLogList>;
  /**
   * Everyone with at least one entry (any status or role now), by name: the "Changed by" filter,
   * which must still offer an admin who was disabled or demoted since. Only people who could reach
   * the admin write routes ever get entries, so the list stays small.
   */
  actors(ctx: AdminContext): Promise<AuditLogActorList>;
}

export function createAuditLogAdminService(deps: AdminDeps): AuditLogAdminService {
  const { prisma } = deps;

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;
      if (query.cursor && !cursor) {
        throw errors.validation([
          {
            location: 'querystring',
            path: ['cursor'],
            message: 'validation.invalid',
            code: 'cursor',
          },
        ]);
      }
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.from) createdAt.gte = new Date(query.from);
      if (query.to) createdAt.lt = new Date(query.to);
      const and: Prisma.AdminAuditLogWhereInput[] = [
        {
          ...(query.entity ? { entity: query.entity } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.actorId ? { actorId: query.actorId } : {}),
          ...(query.action ? { action: query.action } : {}),
          ...(query.from || query.to ? { createdAt } : {}),
        },
      ];
      if (cursor) {
        and.push({
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        });
      }
      const rows = await prisma.adminAuditLog.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: entrySelect,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toAuditLogEntryDto),
        nextCursor:
          rows.length > query.limit && last
            ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },

    async actors(ctx) {
      requireSuperAdmin(ctx.actor);
      const items = await prisma.user.findMany({
        where: { auditLogs: { some: {} } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, role: true, status: true },
      });
      return { items };
    },
  };
}
