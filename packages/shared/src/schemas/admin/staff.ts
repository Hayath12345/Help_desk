// Admin — Staff (decision E9; super admins only). Staff accounts are created here (email on
// STAFF_EMAIL_DOMAIN; the Microsoft sign-in links to the account on first use). A role or status
// change bumps `sessionVersion` and invalidates the principal; nobody changes their own role or
// disables themselves, and the last active super admin stays (see `staffChangeProblem`).
//
// GET    /admin/staff?status=&role=&search=&cursor=&limit=   → { items, nextCursor }
//        (status: active = ACTIVE, archived = DISABLED)
// POST   /admin/staff                                        → 201 { item }
// PATCH  /admin/staff/:id                                    → { item }
// GET    /admin/staff-directory?search=&teamId=&role=        → { items } (pickers; super admins
//        and team leads, see directory.ts)
// Scope `staff`. Phones are stored in E.164 (`normalizeE164`; anything else is 400
// `validation.phone`).

import { z } from 'zod';
import { STAFF_ROLES, TEAM_MEMBER_ROLES, USER_STATUSES } from '../../enums.ts';
import { STAFF_ACCOUNT_STATUSES } from '../../permissions.ts';
import { emailSchema } from '../auth.ts';
import {
  NOTHING_TO_CHANGE,
  adminPagedQuerySchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemResponseSchema,
  labelText,
  optionalText,
  pagedListSchema,
} from './common.ts';

export const STAFF_LIMITS = { nameMin: 2, nameMax: 100, jobTitleMax: 120, phoneMax: 40 } as const;

/** Shown as assignee, note author and audit actor: the label rules (no bidi controls, visible). */
export const staffNameSchema = labelText()
  .min(STAFF_LIMITS.nameMin, { error: 'validation.nameMin' })
  .max(STAFF_LIMITS.nameMax, { error: 'validation.tooLong' });

/** Free text in; the API stores it as E.164 or refuses it (400 `validation.phone`). */
export const staffPhoneInputSchema = optionalText(STAFF_LIMITS.phoneMax);

export const staffAdminDtoSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(STAFF_ROLES),
  status: z.enum(USER_STATUSES),
  jobTitle: z.string().nullable(),
  /** As stored (E.164 for numbers saved through the admin). */
  phone: z.string().nullable(),
  phoneValid: z.boolean(),
  teams: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      nameEn: z.string(),
      nameAr: z.string(),
      isActive: z.boolean(),
      memberRole: z.enum(TEAM_MEMBER_ROLES),
    }),
  ),
  /** A Microsoft account is linked (they have signed in at least once). */
  microsoftLinked: z.boolean(),
  lastLoginAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type StaffAdminDto = z.infer<typeof staffAdminDtoSchema>;

export const staffListQuerySchema = adminPagedQuerySchema.extend({
  role: z.enum(STAFF_ROLES).optional(),
});
export const staffListSchema = pagedListSchema(staffAdminDtoSchema);
export const staffResponseSchema = itemResponseSchema(staffAdminDtoSchema);

export const createStaffSchema = z.object({
  /** Must be on STAFF_EMAIL_DOMAIN (400 `validation.staffDomain`); 409 EMAIL_TAKEN if it exists. */
  email: emailSchema,
  name: staffNameSchema,
  role: z.enum(STAFF_ROLES),
  jobTitle: optionalText(STAFF_LIMITS.jobTitleMax).default(null),
  phone: staffPhoneInputSchema.default(null),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    name: staffNameSchema.optional(),
    role: z.enum(STAFF_ROLES).optional(),
    status: z.enum(STAFF_ACCOUNT_STATUSES).optional(),
    jobTitle: optionalText(STAFF_LIMITS.jobTitleMax).optional(),
    phone: staffPhoneInputSchema.optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
