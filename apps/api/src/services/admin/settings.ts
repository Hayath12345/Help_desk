import { Prisma } from '@loons/db';
import {
  ADMIN_KEY_PATTERN,
  HH_MM_PATTERN,
  SETTINGS_LIMITS,
  SETTING_FIELDS,
  SETTING_KEYS,
  normalizeE164,
  type ConfigScope,
  type GeneralSettingsDto,
  type GeneralSettingsValues,
  type SettingKey,
  type UpdateGeneralSettingsInput,
} from '@loons/shared';
import { DEFAULT_AUTO_CLOSE_DAYS, DEFAULT_DIGEST_TIME } from '../../jobs/maintenance.ts';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { DEFAULT_BUSINESS_TIME_ZONE } from '../sla.ts';
import { DEFAULT_SECURITY_CATEGORY_KEY } from '../ticket-config.service.ts';
import { requireSuperAdmin } from './authz.ts';
import { lockRow, sameInstant } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import type { AdminContext } from './write.ts';

// Admin — General settings (decision E11; super admins). Five AppSetting rows edited as one form:
// the business time zone, the SOC phone (E.164), the auto-close delay, the P4 digest time and the
// security category. The form's `updatedAt` is the newest of the five rows (E19: every row is
// locked and a save that started from an older state is 409 `stale`).
// Announced scopes: `settings`, plus `ticket-form` (SOC phone, security category: both are in the
// form config) and `calendar` (time zone). A time-zone or digest-time change reschedules the
// worker's daily jobs within a minute: the SLA scan tick re-reads both settings and re-upserts the
// schedulers that changed (jobs/sla-scan.ts). Contract: packages/shared/src/schemas/admin/settings.ts.

type Tx = Prisma.TransactionClient;
type Field = (typeof SETTING_FIELDS)[SettingKey];

export interface SettingsAdminService {
  get(ctx: AdminContext): Promise<GeneralSettingsDto>;
  update(ctx: AdminContext, input: UpdateGeneralSettingsInput): Promise<GeneralSettingsDto>;
}

/**
 * The IANA name of `zone` in its canonical spelling ("asia/qatar" → "Asia/Qatar", "Etc/UTC" →
 * "UTC"), or null when it isn't a named zone (unknown names and raw offsets like "+03:00" are
 * refused: the worker's cron schedules need a real zone).
 */
export function canonicalTimeZone(zone: string): string | null {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
  return resolved === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(resolved)
    ? resolved
    : null;
}

/** The value each key falls back to when nothing (usable) is stored — what the readers use. */
function coerce(key: SettingKey, raw: unknown): GeneralSettingsValues[Field] {
  switch (key) {
    case 'business.timezone':
      return (typeof raw === 'string' && canonicalTimeZone(raw)) || DEFAULT_BUSINESS_TIME_ZONE;
    case 'support.socPhone':
      return typeof raw === 'string' && raw.trim() !== '' && raw.trim().length <= 40
        ? raw.trim()
        : null;
    case 'tickets.autoCloseDays':
      return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
        ? Math.min(raw, SETTINGS_LIMITS.autoCloseDaysMax)
        : DEFAULT_AUTO_CLOSE_DAYS;
    case 'notifications.p4DigestTime':
      return typeof raw === 'string' && HH_MM_PATTERN.test(raw) ? raw : DEFAULT_DIGEST_TIME;
    case 'tickets.securityCategoryKey':
      return typeof raw === 'string' && ADMIN_KEY_PATTERN.test(raw)
        ? raw
        : DEFAULT_SECURITY_CATEGORY_KEY;
  }
}

/** Scopes a change of `key` announces (on top of `settings`). */
const KEY_SCOPES: Record<SettingKey, ConfigScope[]> = {
  'business.timezone': ['calendar'],
  'support.socPhone': ['ticket-form'],
  'tickets.autoCloseDays': [],
  'notifications.p4DigestTime': [],
  'tickets.securityCategoryKey': ['ticket-form'],
};

function valueIssue(field: Field, message: string, code: string): ValidationIssue {
  return { location: 'body', path: ['values', field], message, code };
}

async function read(db: Tx | AdminDeps['prisma']): Promise<GeneralSettingsDto> {
  const rows = await db.appSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const raw = (key: SettingKey) => rows.find((r) => r.key === key)?.value;
  const values = Object.fromEntries(
    SETTING_KEYS.map((key) => [SETTING_FIELDS[key], coerce(key, raw(key))]),
  ) as GeneralSettingsValues;
  const newest = rows.reduce<Date | null>(
    (max, r) => (max === null || r.updatedAt > max ? r.updatedAt : max),
    null,
  );
  return { values, updatedAt: newest ? newest.toISOString() : null };
}

export function createSettingsAdminService(deps: AdminDeps): SettingsAdminService {
  const { prisma, writer } = deps;

  return {
    async get(ctx) {
      requireSuperAdmin(ctx.actor);
      return read(prisma);
    },

    async update(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        // Lock the five rows (in a fixed order), then compare the newest `updatedAt` (E19).
        let newest: Date | null = null;
        for (const key of SETTING_KEYS) {
          const row = await lockRow(tx, 'AppSetting', key, 'key');
          if (row && (newest === null || row.updatedAt > newest)) newest = row.updatedAt;
        }
        const fresh =
          input.expectedUpdatedAt === null
            ? newest === null
            : newest !== null && sameInstant(newest, input.expectedUpdatedAt);
        if (!fresh) throw adminErrors.stale(newest);

        // Validate and normalise what was sent.
        const next = new Map<SettingKey, Prisma.InputJsonValue | typeof Prisma.JsonNull>();
        const issues: ValidationIssue[] = [];
        const { values } = input;
        if (values.businessTimezone !== undefined) {
          const zone = canonicalTimeZone(values.businessTimezone);
          if (zone) next.set('business.timezone', zone);
          else issues.push(valueIssue('businessTimezone', 'validation.timezone', 'timezone'));
        }
        if (values.socPhone !== undefined) {
          const phone = values.socPhone?.trim() ? normalizeE164(values.socPhone) : null;
          if (values.socPhone?.trim() && !phone) {
            issues.push(valueIssue('socPhone', 'validation.phone', 'phone'));
          } else {
            next.set('support.socPhone', phone ?? Prisma.JsonNull);
          }
        }
        if (values.autoCloseDays !== undefined) {
          next.set('tickets.autoCloseDays', values.autoCloseDays);
        }
        if (values.p4DigestTime !== undefined) {
          next.set('notifications.p4DigestTime', values.p4DigestTime);
        }
        if (values.securityCategoryKey !== undefined) {
          // Locked so a concurrent archive of that category waits for this save (E5 guard).
          await lockRow(tx, 'Category', values.securityCategoryKey, 'key');
          const category = await tx.category.findUnique({
            where: { key: values.securityCategoryKey },
            select: {
              isActive: true,
              _count: { select: { subtypes: { where: { isActive: true } } } },
            },
          });
          if (!category?.isActive || category._count.subtypes === 0) {
            issues.push(
              valueIssue('securityCategoryKey', 'validation.securityCategory', 'security_category'),
            );
          } else {
            next.set('tickets.securityCategoryKey', values.securityCategoryKey);
          }
        }
        if (issues.length) throw errors.validation(issues);

        const stored = await tx.appSetting.findMany({ where: { key: { in: [...next.keys()] } } });
        for (const [key, value] of next) {
          const row = stored.find((r) => r.key === key);
          const plain = value === Prisma.JsonNull ? null : value;
          if (row && JSON.stringify(row.value) === JSON.stringify(plain)) continue;
          await tx.appSetting.upsert({
            where: { key },
            create: { key, value },
            update: { value },
          });
          const field = SETTING_FIELDS[key];
          await audit.record({
            action: row ? 'UPDATE' : 'CREATE',
            entity: 'AppSetting',
            entityId: key,
            entityLabel: key,
            // Named by meaning ({ socPhone }) so the audit log masks the phone.
            before: row ? { [field]: row.value } : null,
            after: { [field]: plain },
          });
          after.scope('settings');
          for (const scope of KEY_SCOPES[key]) after.scope(scope);
        }
        return read(tx);
      });
    },
  };
}
