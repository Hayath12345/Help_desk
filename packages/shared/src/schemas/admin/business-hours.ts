// Admin — Business hours & holidays (spec §10.5; decision E12). The time zone is a General setting.
//
// GET    /admin/business-hours                             → BusinessHoursDto
// PUT    /admin/business-hours                             → BusinessHoursDto (the whole week)
// GET    /admin/business-hours/holidays?status=&year=      → { items: HolidayAdminDto[] }
// POST   /admin/business-hours/holidays                    → 201 { item } (409 duplicate with
//                                                            existingId when the date exists,
//                                                            archived included: restore it)
// PATCH  /admin/business-hours/holidays/:id                → { item }
// POST   /admin/business-hours/holidays/:id/archive | /restore → { item }
// Scope `calendar`. Changes apply to new tickets and later priority changes only.

import { z } from 'zod';
import {
  NOTHING_TO_CHANGE,
  adminListQuerySchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  isoDay,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
} from './common.ts';

/** "HH:mm", 00:00–23:59. */
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmmSchema = z.string().regex(HH_MM_PATTERN, { error: 'validation.timeFormat' });

/** Minutes between two "HH:mm" times (negative when `close` is earlier). */
export function minutesBetween(open: string, close: string): number {
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return toMinutes(close) - toMinutes(open);
}

export const businessDayDtoSchema = z.object({
  /** 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  open: z.string(),
  close: z.string(),
  updatedAt: isoDateTime,
});
export type BusinessDayDto = z.infer<typeof businessDayDtoSchema>;

export const businessHoursDtoSchema = z.object({
  /** Seven days, Sunday first. */
  days: z.array(businessDayDtoSchema),
  /** `business.timezone` (edited in General settings). */
  timeZone: z.string(),
  /** Configured business-day length (E12). */
  businessDayMinutes: z.number().int().positive(),
});
export type BusinessHoursDto = z.infer<typeof businessHoursDtoSchema>;

export const businessDayInputSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  open: hhmmSchema,
  close: hhmmSchema,
  /** The day's `updatedAt` the edit started from. */
  expectedUpdatedAt: expectedUpdatedAtSchema,
});

/** The whole week at once: seven distinct weekdays, open < close on open days, ≥ 1 open day. */
export const updateBusinessHoursSchema = z
  .object({ days: z.array(businessDayInputSchema).length(7) })
  .superRefine((value, ctx) => {
    const weekdays = new Set(value.days.map((d) => d.weekday));
    if (weekdays.size !== 7) {
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'validation.duplicateValue' });
    }
    value.days.forEach((day, i) => {
      if (day.isOpen && minutesBetween(day.open, day.close) <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['days', i, 'close'],
          message: 'validation.openBeforeClose',
        });
      }
    });
    if (!value.days.some((d) => d.isOpen)) {
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'validation.oneOpenDay' });
    }
  });
export type UpdateBusinessHoursInput = z.infer<typeof updateBusinessHoursSchema>;

export const holidayAdminDtoSchema = z.object({
  id: z.uuid(),
  date: isoDay,
  name: z.string(),
  nameAr: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type HolidayAdminDto = z.infer<typeof holidayAdminDtoSchema>;

export const holidayListQuerySchema = adminListQuerySchema.extend({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export const holidayListSchema = itemListSchema(holidayAdminDtoSchema);
export const holidayResponseSchema = itemResponseSchema(holidayAdminDtoSchema);

export const createHolidaySchema = z.object({
  date: isoDay,
  name: labelEnSchema,
  nameAr: labelArSchema.default(''),
});
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;

/** The date never changes (archive it and add the new date). */
export const updateHolidaySchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    name: labelEnSchema.optional(),
    nameAr: labelArSchema.optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
