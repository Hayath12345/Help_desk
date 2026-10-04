import type { Prisma, PrismaClient } from '@loons/db';
import {
  ESCALATION_CHANNELS,
  ESCALATION_TARGET_TYPES,
  IMPACTS,
  PRIORITIES,
  SLA_TARGETS,
  TICKET_CHANNELS,
  TICKET_STATUSES,
  TICKET_TYPES,
  type Actor,
  type TicketEventDto,
  type TicketEventList,
  type TicketEventMeta,
  type TicketEventType,
  type TicketEventValue,
  type TicketEventsQuery,
} from '@loons/shared';
import { errors } from '../lib/errors.ts';
import { loadVisibleTicket, requireStaff } from './ticket-access.ts';
import { categoryRefSelect } from './ticket-dto.ts';
import { CURSOR_EPOCH_MS } from './ticket-query.ts';

// The staff activity timeline (Phase 5 F14; Phase 3 carry-over): a ticket's TicketEvents, newest
// first, cursor-paged over (createdAt, id). Staff only (clients get 403); a ticket the caller
// can't see is 404. Ids in the stored before / after values are resolved to labels — archived
// teams, categories, sub-types, sites and disabled users included — and only known meta keys are
// passed on (ticketEventMetaSchema). The events are never pushed to ticket rooms: the web
// refetches the timeline on `ticket:updated`.

export interface TicketEventsService {
  list(actor: Actor, ticketId: string, query: TicketEventsQuery): Promise<TicketEventList>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeEventCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** The cursor's (createdAt, id), or null when it is not one this API handed out. */
export function decodeEventCursor(value: string): Cursor | null {
  const raw = Buffer.from(value, 'base64url').toString('utf8');
  const [at, id, ...rest] = raw.split('|');
  if (rest.length > 0 || !at || !id || !UUID.test(id)) return null;
  const createdAt = new Date(at);
  const ms = createdAt.getTime();
  if (Number.isNaN(ms) || createdAt.toISOString() !== at) return null;
  // Only instants Postgres can store (0001-01-01 … 9999-12-31 UTC): a crafted year 0 or a
  // negative year is a 400, never a 500 (like the ticket list's cursor).
  if (ms < CURSOR_EPOCH_MS.min || ms > CURSOR_EPOCH_MS.max) return null;
  return { createdAt, id };
}

/** Which kind of value `fromValue` / `toValue` hold, by event type. */
type ValueKind =
  | 'status'
  | 'priority'
  | 'impact'
  | 'user'
  | 'team'
  | 'category'
  | 'subtype'
  | 'site'
  | 'step'
  | 'tags'
  | 'text'
  | 'none';

const VALUE_KINDS: Record<TicketEventType, ValueKind> = {
  CREATED: 'status',
  STATUS_CHANGED: 'status',
  REOPENED: 'status',
  AUTO_CLOSED: 'status',
  PRIORITY_CHANGED: 'priority',
  IMPACT_CHANGED: 'impact',
  ASSIGNEE_CHANGED: 'user',
  P1_ACKNOWLEDGED: 'user',
  TEAM_CHANGED: 'team',
  CATEGORY_CHANGED: 'category',
  SUBTYPE_CHANGED: 'subtype',
  SITE_CHANGED: 'site',
  ESCALATED: 'step',
  TAGS_CHANGED: 'tags',
  ASSET_CHANGED: 'text',
  TYPE_CHANGED: 'text',
  FIRST_REPLY: 'none',
  SLA_AT_RISK: 'none',
  SLA_BREACHED: 'none',
  CUSTOM_FIELDS_CHANGED: 'none',
};

const eventSelect = {
  id: true,
  type: true,
  fromValue: true,
  toValue: true,
  meta: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
} as const satisfies Prisma.TicketEventSelect;

type EventRow = Prisma.TicketEventGetPayload<{ select: typeof eventSelect }>;

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const isUuid = (value: string | null): value is string => value !== null && UUID.test(value);

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function createTicketEventsService(deps: { prisma: PrismaClient }): TicketEventsService {
  const { prisma } = deps;

  /** Labels for every id the page refers to, archived / disabled rows included. */
  async function loadLabels(rows: readonly EventRow[]) {
    const ids = { user: new Set<string>(), team: new Set<string>(), category: new Set<string>() };
    const more = { subtype: new Set<string>(), site: new Set<string>() };
    const categoryKeys = new Set<string>();
    const subtypeKeys = new Set<string>();
    const fieldKeys = new Set<string>();
    for (const row of rows) {
      const kind = VALUE_KINDS[row.type];
      for (const value of [row.fromValue, row.toValue]) {
        if (!isUuid(value)) continue;
        if (kind === 'user' || kind === 'team' || kind === 'category') ids[kind].add(value);
        if (kind === 'subtype' || kind === 'site') more[kind].add(value);
      }
      const meta = (row.meta ?? {}) as Record<string, unknown>;
      if (row.type === 'CREATED') {
        if (typeof meta.category === 'string') categoryKeys.add(meta.category);
        if (typeof meta.subtype === 'string') subtypeKeys.add(meta.subtype);
      }
      if (row.type === 'CUSTOM_FIELDS_CHANGED') {
        for (const key of stringList(meta.fields) ?? []) fieldKeys.add(key);
      }
    }
    const subtypeSelect = { id: true, key: true, labelEn: true, labelAr: true, isActive: true };
    const [users, teams, categories, subtypes, sites, fields] = await Promise.all([
      ids.user.size
        ? prisma.user.findMany({
            where: { id: { in: [...ids.user] } },
            select: { id: true, name: true, status: true },
          })
        : [],
      ids.team.size
        ? prisma.team.findMany({
            where: { id: { in: [...ids.team] } },
            select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true },
          })
        : [],
      ids.category.size || categoryKeys.size
        ? prisma.category.findMany({
            where: {
              OR: [{ id: { in: [...ids.category] } }, { key: { in: [...categoryKeys] } }],
            },
            select: categoryRefSelect,
          })
        : [],
      more.subtype.size || subtypeKeys.size
        ? prisma.subtype.findMany({
            where: {
              OR: [
                { id: { in: [...more.subtype] } },
                // CREATED names the sub-type by key: keys are unique per category.
                ...(subtypeKeys.size
                  ? [
                      {
                        key: { in: [...subtypeKeys] },
                        category: { key: { in: [...categoryKeys] } },
                      },
                    ]
                  : []),
              ],
            },
            select: { ...subtypeSelect, category: { select: { key: true } } },
          })
        : [],
      more.site.size
        ? prisma.site.findMany({
            where: { id: { in: [...more.site] } },
            select: { id: true, name: true, nameAr: true, isActive: true },
          })
        : [],
      fieldKeys.size
        ? prisma.customField.findMany({
            where: { key: { in: [...fieldKeys] } },
            select: { key: true, labelEn: true, labelAr: true, isActive: true },
          })
        : [],
    ]);
    return {
      users: new Map(users.map((u) => [u.id, u])),
      teams: new Map(teams.map((t) => [t.id, t])),
      categories: new Map(categories.map((c) => [c.id, c])),
      categoriesByKey: new Map(categories.map((c) => [c.key, c])),
      subtypes: new Map(subtypes.map((s) => [s.id, s])),
      subtypesByKey: new Map(subtypes.map((s) => [`${s.category.key}:${s.key}`, s])),
      sites: new Map(sites.map((s) => [s.id, s])),
      fields: new Map(fields.map((f) => [f.key, f])),
    };
  }

  type Labels = Awaited<ReturnType<typeof loadLabels>>;

  function categoryValue(c: {
    id: string;
    key: string;
    labelEn: string;
    labelAr: string;
    icon: string;
    isActive: boolean;
  }): TicketEventValue {
    return { kind: 'category', ...c };
  }

  function subtypeValue(s: {
    id: string;
    key: string;
    labelEn: string;
    labelAr: string;
    isActive: boolean;
  }): TicketEventValue {
    return {
      kind: 'subtype',
      id: s.id,
      key: s.key,
      labelEn: s.labelEn,
      labelAr: s.labelAr,
      isActive: s.isActive,
    };
  }

  function valueOf(kind: ValueKind, raw: string | null, labels: Labels): TicketEventValue | null {
    if (raw === null || kind === 'none') return null;
    const text: TicketEventValue = { kind: 'text', value: raw };
    switch (kind) {
      case 'status': {
        const value = oneOf(TICKET_STATUSES, raw);
        return value ? { kind, value } : text;
      }
      case 'priority': {
        const value = oneOf(PRIORITIES, raw);
        return value ? { kind, value } : text;
      }
      case 'impact': {
        const value = oneOf(IMPACTS, raw);
        return value ? { kind, value } : text;
      }
      case 'step': {
        const value = Number(raw);
        return Number.isInteger(value) && value >= 0 ? { kind, value } : text;
      }
      case 'tags':
        return { kind, value: raw.split(',').filter((tag) => tag !== '') };
      case 'text':
        return text;
      case 'user': {
        const user = labels.users.get(raw);
        if (user) {
          return { kind, id: user.id, name: user.name, isActive: user.status === 'ACTIVE' };
        }
        return isUuid(raw) ? { kind: 'removed', entity: 'user', id: raw } : text;
      }
      case 'team': {
        const team = labels.teams.get(raw);
        if (team) return { kind, ...team };
        return isUuid(raw) ? { kind: 'removed', entity: 'team', id: raw } : text;
      }
      case 'category': {
        const category = labels.categories.get(raw);
        if (category) return categoryValue(category);
        return isUuid(raw) ? { kind: 'removed', entity: 'category', id: raw } : text;
      }
      case 'subtype': {
        const subtype = labels.subtypes.get(raw);
        if (subtype) return subtypeValue(subtype);
        return isUuid(raw) ? { kind: 'removed', entity: 'subtype', id: raw } : text;
      }
      case 'site': {
        const site = labels.sites.get(raw);
        if (site) return { kind, ...site };
        return isUuid(raw) ? { kind: 'removed', entity: 'site', id: raw } : text;
      }
    }
  }

  /** Only the known keys of each event type, typed (ticketEventMetaSchema). */
  function metaOf(row: EventRow, labels: Labels): TicketEventMeta {
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const out: TicketEventMeta = {};
    switch (row.type) {
      case 'CREATED': {
        const priority = oneOf(PRIORITIES, meta.priority);
        const type = oneOf(TICKET_TYPES, meta.type);
        const channel = oneOf(TICKET_CHANNELS, meta.channel);
        if (priority) out.priority = priority;
        if (type) out.type = type;
        if (channel) out.channel = channel;
        if (typeof meta.category === 'string') {
          const category = labels.categoriesByKey.get(meta.category);
          out.category = category
            ? categoryValue(category)
            : { kind: 'text', value: meta.category };
          if (typeof meta.subtype === 'string') {
            const subtype = labels.subtypesByKey.get(`${meta.category}:${meta.subtype}`);
            out.subtype = subtype ? subtypeValue(subtype) : { kind: 'text', value: meta.subtype };
          }
        }
        break;
      }
      case 'TAGS_CHANGED': {
        const added = stringList(meta.added);
        const removed = stringList(meta.removed);
        if (added) out.added = added;
        if (removed) out.removed = removed;
        break;
      }
      case 'CUSTOM_FIELDS_CHANGED': {
        const keys = stringList(meta.fields);
        if (keys) {
          out.fields = keys.map((key) => {
            const field = labels.fields.get(key);
            return field ?? { key, labelEn: key, labelAr: key, isActive: false };
          });
        }
        break;
      }
      case 'FIRST_REPLY': {
        const minutes = finite(meta.minutesToFirstReply);
        if (minutes !== undefined) out.minutesToFirstReply = minutes;
        break;
      }
      case 'SLA_AT_RISK':
      case 'SLA_BREACHED': {
        const target = oneOf(SLA_TARGETS, meta.target);
        if (target) out.target = target;
        if (typeof meta.dueAt === 'string' && !Number.isNaN(Date.parse(meta.dueAt))) {
          out.dueAt = new Date(meta.dueAt).toISOString();
        }
        break;
      }
      case 'ESCALATED': {
        const step = finite(meta.step);
        const targetType = oneOf(ESCALATION_TARGET_TYPES, meta.targetType);
        if (step !== undefined && Number.isInteger(step) && step >= 0) out.step = step;
        if (targetType) out.targetType = targetType;
        const channels = stringList(meta.channels)?.flatMap((c) => {
          const channel = oneOf(ESCALATION_CHANNELS, c);
          return channel ? [channel] : [];
        });
        if (channels) out.channels = channels;
        break;
      }
      case 'P1_ACKNOWLEDGED': {
        const step = finite(meta.step);
        if (step !== undefined && Number.isInteger(step) && step >= 0) out.step = step;
        if (meta.minutesToAcknowledge === null) out.minutesToAcknowledge = null;
        const minutes = finite(meta.minutesToAcknowledge);
        if (minutes !== undefined) out.minutesToAcknowledge = minutes;
        break;
      }
      case 'AUTO_CLOSED': {
        const days = finite(meta.days);
        if (days !== undefined) out.days = days;
        break;
      }
      case 'ASSIGNEE_CHANGED': {
        // Picked by the system from the category's skills (docs/AUTO_ASSIGN.md).
        if (meta.auto === true) out.auto = true;
        break;
      }
      default:
        break;
    }
    return out;
  }

  function toDto(row: EventRow, labels: Labels): TicketEventDto {
    const kind = VALUE_KINDS[row.type];
    return {
      id: row.id,
      type: row.type,
      actor: row.actor,
      from: valueOf(kind, row.fromValue, labels),
      to: valueOf(kind, row.toValue, labels),
      meta: metaOf(row, labels),
      createdAt: row.createdAt.toISOString(),
    };
  }

  return {
    async list(actor, ticketId, query) {
      requireStaff(actor);
      const ticket = await loadVisibleTicket(prisma, actor, ticketId);
      const cursor = query.cursor ? decodeEventCursor(query.cursor) : null;
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
      const rows = await prisma.ticketEvent.findMany({
        where: {
          ticketId: ticket.id,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: eventSelect,
      });
      const page = rows.slice(0, query.limit);
      const labels = await loadLabels(page);
      const last = page.at(-1);
      return {
        items: page.map((row) => toDto(row, labels)),
        nextCursor:
          rows.length > query.limit && last
            ? encodeEventCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      };
    },
  };
}
