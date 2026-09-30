// Admin — General settings (decision E11; super admins). Five AppSetting rows.
//
// GET    /admin/settings        → GeneralSettingsDto
// PATCH  /admin/settings        → GeneralSettingsDto
// Scope `settings` (plus `ticket-form` for the SOC phone and the security category, `calendar`
// for the time zone). A time zone or digest-time change reschedules the worker's jobs within a
// minute (the SLA scan tick re-checks the settings and re-upserts changed schedulers).

import { z } from 'zod';
import { adminKeySchema, isoDateTime } from './common.ts';
import { hhmmSchema } from './business-hours.ts';
import { cleanText } from '../tickets.ts';

/** AppSetting keys edited here, in form order. */
export const SETTING_KEYS = [
  'business.timezone',
  'support.socPhone',
  'tickets.autoCloseDays',
  'notifications.p4DigestTime',
  'tickets.securityCategoryKey',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTINGS_LIMITS = { autoCloseDaysMin: 1, autoCloseDaysMax: 60 } as const;

/** The DTO / form field of each AppSetting key. */
export const SETTING_FIELDS = {
  'business.timezone': 'businessTimezone',
  'support.socPhone': 'socPhone',
  'tickets.autoCloseDays': 'autoCloseDays',
  'notifications.p4DigestTime': 'p4DigestTime',
  'tickets.securityCategoryKey': 'securityCategoryKey',
} as const satisfies Record<SettingKey, string>;

export const generalSettingsValuesSchema = z.object({
  /** IANA zone (the API checks it: 400 `validation.timezone`). */
  businessTimezone: z.string().trim().min(1).max(64),
  /** The SOC line shown in the P1 banner; stored in E.164 (400 `validation.phone`). */
  socPhone: cleanText().max(40).nullable(),
  /** Days a SOLVED ticket waits before it is closed. */
  autoCloseDays: z
    .number()
    .int()
    .min(SETTINGS_LIMITS.autoCloseDaysMin, { error: 'validation.tooSmall' })
    .max(SETTINGS_LIMITS.autoCloseDaysMax, { error: 'validation.tooLarge' }),
  /** "HH:mm" in the business time zone. */
  p4DigestTime: hhmmSchema,
  /** An active category with an active sub-type (400 `security_category`). */
  securityCategoryKey: adminKeySchema,
});
export type GeneralSettingsValues = z.infer<typeof generalSettingsValuesSchema>;

export const generalSettingsDtoSchema = z.object({
  values: generalSettingsValuesSchema,
  /** The newest `updatedAt` of the five rows (null when none is stored). */
  updatedAt: isoDateTime.nullable(),
});
export type GeneralSettingsDto = z.infer<typeof generalSettingsDtoSchema>;

/** Changes some values; `expectedUpdatedAt` is the DTO's `updatedAt` the edit started from. */
export const updateGeneralSettingsSchema = z.object({
  expectedUpdatedAt: isoDateTime.nullable(),
  values: generalSettingsValuesSchema
    .partial()
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
      error: 'validation.nothingToChange',
    }),
});
export type UpdateGeneralSettingsInput = z.infer<typeof updateGeneralSettingsSchema>;
