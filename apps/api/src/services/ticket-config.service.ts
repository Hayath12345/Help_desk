import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { PrismaClient } from '@loons/db';
import {
  minutesBetween,
  storedCustomFieldOptionSchema,
  ticketFormConfigSchema,
  type BusinessCalendar,
  type BusinessDayHours,
  type TicketFormConfig,
} from '@loons/shared';
import type { AppLogger as Logger } from '../lib/logger.ts';
import { withTimeout } from '../lib/redis.ts';
import { buildCustomFieldsSchema, type CustomFieldsSchema } from './custom-fields.ts';
import { DEFAULT_BUSINESS_TIME_ZONE, isValidTimeZone } from './sla.ts';

// The live ticket configuration (categories → sub-types → custom fields, SLA policies) and the
// SLA business calendar, read from the database and cached in Redis. Phase 4 admin edits call
// `invalidate()` after commit (through `afterConfigChange`, which also emits `config:updated`) so
// every API instance, the worker and open forms refresh.
//
// Config generation (decision E18): `<prefix>config:gen` is a counter that every invalidation
// increments (it never expires). A loader reads it before the database and writes the cache only
// if it is unchanged (a Lua compare-and-set, like the principal store), so a request that read the
// database just before an admin change committed can't put the old config back after the
// invalidation. The form config carries the generation it was read at as `version`; a cached
// entry of another generation is ignored.

/** Form config cache lifetime; admin edits invalidate it explicitly. */
export const FORM_CONFIG_TTL_SECONDS = 300;
/** Business calendar cache lifetime (contract: ≤ 60 s). */
export const CALENDAR_TTL_SECONDS = 60;
/** Category forced for SECURITY_INCIDENT tickets (spec §7); AppSetting overrides it. */
export const DEFAULT_SECURITY_CATEGORY_KEY = 'cyber';
/** Business-day length when no open day is configured (07:30–16:30). */
export const DEFAULT_BUSINESS_DAY_MINUTES = 540;

const REDIS_TIMEOUT_MS = 1_000;

/** Qatar working week, used only when no day at all is configured as open. */
const FALLBACK_HOURS: BusinessCalendar['hours'] = [0, 1, 2, 3, 4, 5, 6].map((d) =>
  d <= 4 ? { open: '07:30', close: '16:30' } : null,
);

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const calendarSchema = z.object({
  timeZone: z.string(),
  hours: z.array(z.object({ open: z.string(), close: z.string() }).nullable()).length(7),
  holidays: z.array(z.string()),
});

/**
 * Writes a cache entry only if the generation is still the one the loader read.
 * KEYS[1] = entry, KEYS[2] = generation; ARGV = generation seen ('' = none yet), JSON, TTL seconds.
 */
const SET_IF_GENERATION_UNCHANGED = `
if (redis.call('GET', KEYS[2]) or '') == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
end
return 0
`;

/** A cached value with the generation it was loaded at. */
const cachedEntrySchema = z.object({
  generation: z.number().int().nonnegative(),
  value: z.unknown(),
});

/**
 * Length of a business day (E12): the most common length among the open days, the longer one on a
 * tie; DEFAULT_BUSINESS_DAY_MINUTES when no day is open.
 */
export function businessDayMinutes(
  rows: ReadonlyArray<{ isOpen: boolean; open: string; close: string }>,
): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (!row.isOpen || !HH_MM.test(row.open) || !HH_MM.test(row.close)) continue;
    const minutes = minutesBetween(row.open, row.close);
    if (minutes > 0) counts.set(minutes, (counts.get(minutes) ?? 0) + 1);
  }
  let best: [minutes: number, count: number] | null = null;
  for (const [minutes, count] of counts) {
    if (!best || count > best[1] || (count === best[1] && minutes > best[0])) {
      best = [minutes, count];
    }
  }
  return best ? best[0] : DEFAULT_BUSINESS_DAY_MINUTES;
}

export interface TicketConfigService {
  /** Active categories (with active sub-types and fields), SLA policies, SOC phone, version. */
  getFormConfig(): Promise<TicketFormConfig>;
  /** BusinessHours + active Holidays + AppSetting "business.timezone". */
  getCalendar(): Promise<BusinessCalendar>;
  /** The custom-field schema of a category of `config` (memoised per field set). */
  customFieldsSchema(config: TicketFormConfig, categoryId: string): CustomFieldsSchema | null;
  /**
   * Bumps the config generation and drops the cached config and calendar (call after committing a
   * config change; `afterConfigChange` does). Returns the new generation, or null when Redis could
   * not be reached (the entries then expire on their own: ≤ 300 s / 60 s).
   */
  invalidate(): Promise<number | null>;
  /** The current config generation (0 before the first change; null when Redis is unavailable). */
  currentVersion(): Promise<number | null>;
}

function settingString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** "2026-12-18" for a @db.Date column (Prisma returns midnight UTC). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function generationOf(raw: string | null): number {
  const value = Number(raw ?? '');
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function createTicketConfigService(deps: {
  prisma: PrismaClient;
  redis: Redis;
  prefix: string;
  logger: Logger;
}): TicketConfigService {
  const { prisma, redis, logger } = deps;
  const formKey = `${deps.prefix}config:ticket-form`;
  const calendarKey = `${deps.prefix}config:sla-calendar`;
  const generationKey = `${deps.prefix}config:gen`;
  const schemaMemo = new Map<string, CustomFieldsSchema>();

  /**
   * The cached value of the current generation, or `load(generation)` from the database, written
   * back only if no invalidation happened in between.
   */
  async function cached<T>(
    key: string,
    ttl: number,
    schema: z.ZodType<T>,
    load: (generation: number) => Promise<T>,
  ): Promise<T> {
    /** The generation as read ('' = never bumped); null = Redis unavailable (no write-back). */
    let seen: string | null = null;
    try {
      const [raw, gen] = await withTimeout(
        redis.mget(key, generationKey),
        REDIS_TIMEOUT_MS,
        'config cache read',
      );
      seen = gen ?? '';
      if (raw) {
        const entry = cachedEntrySchema.safeParse(JSON.parse(raw));
        if (entry.success && entry.data.generation === generationOf(seen)) {
          const parsed = schema.safeParse(entry.data.value);
          if (parsed.success) return parsed.data;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'config cache read failed; using the database');
    }
    const generation = generationOf(seen);
    const value = await load(generation);
    if (seen !== null) {
      try {
        await withTimeout(
          redis.eval(
            SET_IF_GENERATION_UNCHANGED,
            2,
            key,
            generationKey,
            seen,
            JSON.stringify({ generation, value }),
            ttl,
          ),
          REDIS_TIMEOUT_MS,
          'config cache write',
        );
      } catch (err) {
        logger.warn({ err }, 'config cache write failed');
      }
    }
    return value;
  }

  async function loadFormConfig(generation: number): Promise<TicketFormConfig> {
    const [categories, policies, settings, hours] = await Promise.all([
      prisma.category.findMany({
        // A category routed to an archived team is not offered (the admin list says why:
        // hiddenReason 'team_archived'); the team archive guard normally prevents it.
        where: { isActive: true, team: { isActive: true } },
        orderBy: [{ sortOrder: 'asc' }, { labelEn: 'asc' }],
        select: {
          id: true,
          key: true,
          labelEn: true,
          labelAr: true,
          icon: true,
          assetPlaceholder: true,
          assetPlaceholderAr: true,
          team: { select: { id: true, key: true, nameEn: true, nameAr: true } },
          subtypes: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { labelEn: 'asc' }],
            select: { id: true, key: true, labelEn: true, labelAr: true, defaultPriority: true },
          },
          fields: {
            where: { field: { isActive: true } },
            orderBy: [{ sortOrder: 'asc' }],
            select: {
              field: {
                select: {
                  id: true,
                  key: true,
                  labelEn: true,
                  labelAr: true,
                  type: true,
                  options: true,
                  placeholderEn: true,
                  placeholderAr: true,
                  required: true,
                },
              },
            },
          },
        },
      }),
      prisma.slaPolicy.findMany({ orderBy: { priority: 'asc' } }),
      prisma.appSetting.findMany({
        where: { key: { in: ['support.socPhone', 'tickets.securityCategoryKey'] } },
      }),
      prisma.businessHours.findMany({ select: { isOpen: true, open: true, close: true } }),
    ]);
    const setting = (key: string) => settingString(settings.find((s) => s.key === key)?.value);

    return {
      // A category without an active sub-type can't be chosen (a sub-type is required).
      categories: categories
        .filter((c) => c.subtypes.length > 0)
        .map((c) => ({
          id: c.id,
          key: c.key,
          labelEn: c.labelEn,
          labelAr: c.labelAr,
          icon: c.icon,
          assetPlaceholder: c.assetPlaceholder,
          assetPlaceholderAr: c.assetPlaceholderAr,
          team: c.team,
          subtypes: c.subtypes,
          fields: c.fields.map(({ field }) => {
            // Archived options stay stored (old tickets keep their labels) but are not offered.
            const options = z.array(storedCustomFieldOptionSchema).safeParse(field.options ?? []);
            return {
              id: field.id,
              key: field.key,
              labelEn: field.labelEn,
              labelAr: field.labelAr,
              type: field.type,
              options: options.success
                ? options.data
                    .filter((o) => o.isActive)
                    .map(({ value, labelEn, labelAr }) => ({ value, labelEn, labelAr }))
                : [],
              placeholderEn: field.placeholderEn,
              placeholderAr: field.placeholderAr,
              required: field.required,
            };
          }),
        })),
      slaPolicies: policies.map((p) => ({
        priority: p.priority,
        firstReplyMins: p.firstReplyMins,
        resolveMins: p.resolveMins,
        businessHoursOnly: p.businessHoursOnly,
        atRiskPercent: p.atRiskPercent,
      })),
      securityCategoryKey: setting('tickets.securityCategoryKey') ?? DEFAULT_SECURITY_CATEGORY_KEY,
      socPhone: setting('support.socPhone'),
      businessDayMinutes: businessDayMinutes(hours),
      version: generation,
    };
  }

  async function loadCalendar(): Promise<BusinessCalendar> {
    const [rows, holidays, zone] = await Promise.all([
      prisma.businessHours.findMany(),
      prisma.holiday.findMany({
        where: { isActive: true },
        select: { date: true },
        orderBy: { date: 'asc' },
      }),
      prisma.appSetting.findUnique({ where: { key: 'business.timezone' } }),
    ]);
    let hours: Array<BusinessDayHours | null> = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
      const row = rows.find((r) => r.weekday === weekday);
      if (!row || !row.isOpen || !HH_MM.test(row.open) || !HH_MM.test(row.close)) return null;
      return row.open < row.close ? { open: row.open, close: row.close } : null;
    });
    if (hours.every((h) => h === null)) {
      logger.warn('no business day is configured as open; using the default working week');
      hours = [...FALLBACK_HOURS];
    }
    const configuredZone = settingString(zone?.value);
    let timeZone = DEFAULT_BUSINESS_TIME_ZONE;
    if (configuredZone && isValidTimeZone(configuredZone)) timeZone = configuredZone;
    else if (configuredZone) logger.warn('business.timezone is not a valid IANA zone; ignored');
    return { timeZone, hours, holidays: holidays.map((h) => isoDay(h.date)) };
  }

  return {
    getFormConfig: () =>
      cached(formKey, FORM_CONFIG_TTL_SECONDS, ticketFormConfigSchema, loadFormConfig),

    getCalendar: () => cached(calendarKey, CALENDAR_TTL_SECONDS, calendarSchema, loadCalendar),

    customFieldsSchema(config, categoryId) {
      const category = config.categories.find((c) => c.id === categoryId);
      if (!category) return null;
      // Keyed by the fields themselves, not the version: rows edited outside the admin (seed, SQL)
      // change the config without a new generation once the cache expires.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(category.fields))
        .digest('base64url');
      const memoKey = `${categoryId}:${fingerprint}`;
      let schema = schemaMemo.get(memoKey);
      if (!schema) {
        schema = buildCustomFieldsSchema(category.fields);
        if (schemaMemo.size > 500) schemaMemo.clear();
        schemaMemo.set(memoKey, schema);
      }
      return schema;
    },

    async invalidate() {
      schemaMemo.clear();
      try {
        // One MULTI: the generation moves first, so a loader that read the old one can no longer
        // write, and whatever it wrote before is deleted.
        const results = await withTimeout(
          redis.multi().incr(generationKey).del(formKey, calendarKey).exec(),
          REDIS_TIMEOUT_MS,
          'config cache invalidation',
        );
        const failed = results?.find(([err]) => err)?.[0];
        if (!results || failed) throw failed ?? new Error('config cache invalidation aborted');
        return generationOf(String(results[0]?.[1]));
      } catch (err) {
        logger.warn({ err }, 'config cache invalidation failed');
        return null;
      }
    },

    async currentVersion() {
      try {
        const raw = await withTimeout(
          redis.get(generationKey),
          REDIS_TIMEOUT_MS,
          'config generation read',
        );
        return generationOf(raw);
      } catch (err) {
        logger.warn({ err }, 'config generation read failed');
        return null;
      }
    },
  };
}
