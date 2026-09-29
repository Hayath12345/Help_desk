import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { PrismaClient } from '@loons/db';
import {
  customFieldOptionSchema,
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
// `invalidate()` (and emit `config:updated`) so every API instance and open form refreshes.

/** Form config cache lifetime; admin edits invalidate it explicitly. */
export const FORM_CONFIG_TTL_SECONDS = 300;
/** Business calendar cache lifetime (contract: ≤ 60 s). */
export const CALENDAR_TTL_SECONDS = 60;
/** Category forced for SECURITY_INCIDENT tickets (spec §7); AppSetting overrides it. */
export const DEFAULT_SECURITY_CATEGORY_KEY = 'cyber';

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

export interface TicketConfigService {
  /** Active categories (with active sub-types and fields), SLA policies, SOC phone, version. */
  getFormConfig(): Promise<TicketFormConfig>;
  /** BusinessHours + active Holidays + AppSetting "business.timezone". */
  getCalendar(): Promise<BusinessCalendar>;
  /** The custom-field schema of a category of `config` (memoised per config version). */
  customFieldsSchema(config: TicketFormConfig, categoryId: string): CustomFieldsSchema | null;
  /** Drops the cached config and calendar (call after committing a config change). */
  invalidate(): Promise<void>;
}

function settingString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** "2026-12-18" for a @db.Date column (Prisma returns midnight UTC). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
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
  const schemaMemo = new Map<string, CustomFieldsSchema>();

  async function cached<T>(
    key: string,
    ttl: number,
    schema: z.ZodType<T>,
    load: () => Promise<T>,
  ): Promise<T> {
    try {
      const raw = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS, 'config cache read');
      if (raw) {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      }
    } catch (err) {
      logger.warn({ err }, 'config cache read failed; using the database');
    }
    const value = await load();
    try {
      await withTimeout(
        redis.set(key, JSON.stringify(value), 'EX', ttl),
        REDIS_TIMEOUT_MS,
        'config cache write',
      );
    } catch (err) {
      logger.warn({ err }, 'config cache write failed');
    }
    return value;
  }

  async function loadFormConfig(): Promise<TicketFormConfig> {
    const [categories, policies, settings] = await Promise.all([
      prisma.category.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { labelEn: 'asc' }],
        select: {
          id: true,
          key: true,
          labelEn: true,
          labelAr: true,
          icon: true,
          assetPlaceholder: true,
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
    ]);
    const setting = (key: string) => settingString(settings.find((s) => s.key === key)?.value);

    const body: Omit<TicketFormConfig, 'version'> = {
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
          team: c.team,
          subtypes: c.subtypes,
          fields: c.fields.map(({ field }) => {
            const options = z.array(customFieldOptionSchema).safeParse(field.options ?? []);
            return {
              id: field.id,
              key: field.key,
              labelEn: field.labelEn,
              labelAr: field.labelAr,
              type: field.type,
              options: options.success ? options.data : [],
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
      })),
      securityCategoryKey: setting('tickets.securityCategoryKey') ?? DEFAULT_SECURITY_CATEGORY_KEY,
      socPhone: setting('support.socPhone'),
    };
    const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return { ...body, version };
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
      const memoKey = `${config.version}:${categoryId}`;
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
        await withTimeout(redis.del(formKey, calendarKey), REDIS_TIMEOUT_MS, 'config cache clear');
      } catch (err) {
        logger.warn({ err }, 'config cache invalidation failed');
      }
    },
  };
}
