// Admin — SLA policies (spec §10.4; decision E12). Four fixed rows, one per priority: edit only.
// Changes apply to new tickets and later priority changes; stored due dates of open tickets are
// not recomputed (the UI says so).
//
// GET    /admin/sla                    → { items: SlaPolicyAdminDto[], businessDayMinutes }
// PATCH  /admin/sla/:priority          → { item }
// Scope `ticket-form` (the form shows the targets).

import { z } from 'zod';
import { PRIORITIES } from '../../enums.ts';
import { expectedUpdatedAtSchema, isoDateTime, itemResponseSchema } from './common.ts';

export const SLA_LIMITS = {
  /** 365 days. */
  minutesMax: 525_600,
  atRiskPercentMin: 1,
  atRiskPercentMax: 99,
} as const;

export const slaPolicyAdminDtoSchema = z.object({
  id: z.uuid(),
  priority: z.enum(PRIORITIES),
  firstReplyMins: z.number().int(),
  resolveMins: z.number().int(),
  businessHoursOnly: z.boolean(),
  atRiskPercent: z.number().int(),
  updatedAt: isoDateTime,
});
export type SlaPolicyAdminDto = z.infer<typeof slaPolicyAdminDtoSchema>;

export const slaPolicyListSchema = z.object({
  items: z.array(slaPolicyAdminDtoSchema),
  /** Configured business-day length (E12), for "N business days" labels. */
  businessDayMinutes: z.number().int().positive(),
});
export const slaPolicyResponseSchema = itemResponseSchema(slaPolicyAdminDtoSchema);

const minutes = z
  .number()
  .int()
  .min(1, { error: 'validation.minutesMin' })
  .max(SLA_LIMITS.minutesMax, { error: 'validation.tooLarge' });

/** Replaces the policy's targets (the whole row is edited at once). */
export const updateSlaPolicySchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  firstReplyMins: minutes,
  resolveMins: minutes,
  businessHoursOnly: z.boolean(),
  atRiskPercent: z
    .number()
    .int()
    .min(SLA_LIMITS.atRiskPercentMin, { error: 'validation.atRiskPercent' })
    .max(SLA_LIMITS.atRiskPercentMax, { error: 'validation.atRiskPercent' }),
});
export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;

export const slaPriorityParamSchema = z.object({ priority: z.enum(PRIORITIES) });
