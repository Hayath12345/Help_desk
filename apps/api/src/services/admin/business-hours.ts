import type { Holiday, Prisma } from '@loons/db';
import type {
  AdminListQuery,
  BusinessDayDto,
  BusinessHoursDto,
  CreateHolidayInput,
  HolidayAdminDto,
  UpdateBusinessHoursInput,
  UpdateHolidayInput,
} from '@loons/shared';
import { DEFAULT_BUSINESS_TIME_ZONE, isValidTimeZone } from '../sla.ts';
import { businessDayMinutes } from '../ticket-config.service.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, assertFresh, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import type { AdminContext } from './write.ts';

// Admin — Business hours & holidays (spec §10.5; decision E12). The working week is edited as a
// whole (seven rows, one per weekday, each with its own `updatedAt` for E19); holidays are
// archived, never deleted, and a holiday's date is unique across archived rows too, so re-adding
// an archived date means restoring that row (409 `duplicate` with `existingId`). The time zone is
// a General setting (read-only here). Every change announces `calendar` (the SLA calendar, the
// form config's business-day length, ticket details). Stored due dates of open tickets are not
// recomputed.
// Contract: packages/shared/src/schemas/admin/business-hours.ts.

type Tx = Prisma.TransactionClient;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** `updatedAt` reported for a weekday that has no row yet (PUT creates it). */
export const MISSING_DAY_UPDATED_AT = new Date(0);

/** A new weekday row starts closed (the loader treats a missing day as closed too). */
const MISSING_DAY = { isOpen: false, open: '07:30', close: '16:30' } as const;

export interface HolidayListQuery extends AdminListQuery {
  year?: number | undefined;
}

export interface BusinessHoursAdminService {
  get(ctx: AdminContext): Promise<BusinessHoursDto>;
  /** Replaces the week (every day's `expectedUpdatedAt` must be current: 409 `stale`). */
  update(ctx: AdminContext, input: UpdateBusinessHoursInput): Promise<BusinessHoursDto>;
  listHolidays(ctx: AdminContext, query: HolidayListQuery): Promise<HolidayAdminDto[]>;
  /** 409 `duplicate` + `existingId` when the date exists (archived ones too: restore it). */
  createHoliday(ctx: AdminContext, input: CreateHolidayInput): Promise<HolidayAdminDto>;
  updateHoliday(ctx: AdminContext, id: string, input: UpdateHolidayInput): Promise<HolidayAdminDto>;
  setHolidayActive(
    ctx: AdminContext,
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<HolidayAdminDto>;
}

/** "2026-12-18" for a @db.Date column (Prisma returns midnight UTC). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function holidayDto(row: Holiday): HolidayAdminDto {
  return {
    id: row.id,
    date: isoDay(row.date),
    name: row.name,
    nameAr: row.nameAr,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function holidayLabel(row: Pick<Holiday, 'date' | 'name'>): string {
  return `${isoDay(row.date)} ${row.name}`;
}

function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createBusinessHoursAdminService(deps: AdminDeps): BusinessHoursAdminService {
  const { prisma, writer } = deps;

  async function read(db: Tx | typeof prisma): Promise<BusinessHoursDto> {
    // Sequential: `db` may be a transaction, whose connection runs one query at a time.
    const rows = await db.businessHours.findMany({ orderBy: { weekday: 'asc' } });
    const zone = await db.appSetting.findUnique({ where: { key: 'business.timezone' } });
    const days: BusinessDayDto[] = WEEKDAY_NAMES.map((_, weekday) => {
      const row = rows.find((r) => r.weekday === weekday);
      return row
        ? {
            weekday,
            isOpen: row.isOpen,
            open: row.open,
            close: row.close,
            updatedAt: row.updatedAt.toISOString(),
          }
        : { weekday, ...MISSING_DAY, updatedAt: MISSING_DAY_UPDATED_AT.toISOString() };
    });
    const configured = typeof zone?.value === 'string' ? zone.value.trim() : '';
    return {
      days,
      timeZone: configured && isValidTimeZone(configured) ? configured : DEFAULT_BUSINESS_TIME_ZONE,
      businessDayMinutes: businessDayMinutes(days),
    };
  }

  async function lockedHoliday(tx: Tx, id: string, expectedUpdatedAt: string): Promise<Holiday> {
    await lockFresh(tx, 'Holiday', id, expectedUpdatedAt);
    return tx.holiday.findUniqueOrThrow({ where: { id } });
  }

  return {
    async get(ctx) {
      requireSuperAdmin(ctx.actor);
      return read(prisma);
    },

    async update(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        // Every weekday row, locked (E19: two admins saving the week from the same state).
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            weekday: number;
            isOpen: boolean;
            open: string;
            close: string;
            updatedAt: Date;
          }>
        >`SELECT "id", "weekday", "isOpen", "open", "close", "updatedAt" FROM "BusinessHours" ORDER BY "weekday" FOR UPDATE`;
        const byWeekday = new Map(rows.map((r) => [r.weekday, r]));
        for (const day of input.days) {
          const row = byWeekday.get(day.weekday);
          assertFresh(row ?? { updatedAt: MISSING_DAY_UPDATED_AT }, day.expectedUpdatedAt);
        }
        let changed = false;
        for (const day of [...input.days].sort((a, b) => a.weekday - b.weekday)) {
          const row = byWeekday.get(day.weekday);
          const next = { isOpen: day.isOpen, open: day.open, close: day.close };
          if (
            row &&
            row.isOpen === next.isOpen &&
            row.open === next.open &&
            row.close === next.close
          )
            continue;
          const saved = row
            ? await tx.businessHours.update({ where: { id: row.id }, data: next })
            : await tx.businessHours.create({ data: { weekday: day.weekday, ...next } });
          await audit.record({
            action: row ? 'UPDATE' : 'CREATE',
            entity: 'BusinessHours',
            entityId: saved.id,
            entityLabel: WEEKDAY_NAMES[day.weekday] ?? String(day.weekday),
            before: row ? { isOpen: row.isOpen, open: row.open, close: row.close } : null,
            after: next,
          });
          changed = true;
        }
        if (changed) after.scope('calendar');
        return read(tx);
      });
    },

    async listHolidays(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const term = query.search?.trim();
      const where: Prisma.HolidayWhereInput = {
        ...(query.status === 'all' ? {} : { isActive: query.status !== 'archived' }),
        ...(query.year
          ? {
              date: {
                gte: new Date(Date.UTC(query.year, 0, 1)),
                lt: new Date(Date.UTC(query.year + 1, 0, 1)),
              },
            }
          : {}),
        ...(term
          ? {
              OR: [
                { name: { contains: likeEscape(term), mode: 'insensitive' } },
                { nameAr: { contains: likeEscape(term), mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const rows = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
      return rows.map(holidayDto);
    },

    async createHoliday(ctx, input) {
      requireSuperAdmin(ctx.actor);
      const row = await writer.write(ctx, { scopes: 'calendar' }, async ({ tx, audit }) => {
        // One writer per date, so a concurrent create gets the same 409 with the row to restore.
        await advisoryLock(tx, `holiday:${input.date}`);
        const date = new Date(`${input.date}T00:00:00.000Z`);
        const existing = await tx.holiday.findUnique({ where: { date } });
        if (existing) {
          throw adminErrors.duplicate(['date'], { id: existing.id, isActive: existing.isActive });
        }
        const created = await tx.holiday.create({
          data: { date, name: input.name, nameAr: input.nameAr === '' ? null : input.nameAr },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Holiday',
          entityId: created.id,
          entityLabel: holidayLabel(created),
          after: { date: isoDay(created.date), name: created.name, nameAr: created.nameAr },
        });
        return created;
      });
      return holidayDto(row);
    },

    async updateHoliday(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      const row = await writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        const before = await lockedHoliday(tx, id, input.expectedUpdatedAt);
        const data = {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.nameAr !== undefined
            ? { nameAr: input.nameAr === '' ? null : input.nameAr }
            : {}),
        };
        const same =
          (data.name === undefined || data.name === before.name) &&
          (data.nameAr === undefined || data.nameAr === before.nameAr);
        if (same) return before;
        const updated = await tx.holiday.update({ where: { id }, data });
        await audit.record({
          action: 'UPDATE',
          entity: 'Holiday',
          entityId: id,
          entityLabel: holidayLabel(updated),
          before: { name: before.name, nameAr: before.nameAr },
          after: { name: updated.name, nameAr: updated.nameAr },
        });
        after.scope('calendar');
        return updated;
      });
      return holidayDto(row);
    },

    async setHolidayActive(ctx, id, active, expectedUpdatedAt) {
      requireSuperAdmin(ctx.actor);
      const row = await writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        const before = await lockedHoliday(tx, id, expectedUpdatedAt);
        if (before.isActive === active) return before;
        const updated = await tx.holiday.update({ where: { id }, data: { isActive: active } });
        await audit.record({
          action: active ? 'RESTORE' : 'ARCHIVE',
          entity: 'Holiday',
          entityId: id,
          entityLabel: holidayLabel(updated),
          before: { isActive: before.isActive },
          after: { isActive: updated.isActive },
        });
        after.scope('calendar');
        return updated;
      });
      return holidayDto(row);
    },
  };
}
