// GET /admin/staff-directory — active staff for pickers (team members, on-call user, escalation
// USER target, account manager). Super admins and team leads (who add members to their teams).
// Contact data is limited to what the pickers need: the email, and whether a usable phone exists.

import { z } from 'zod';
import { STAFF_ROLES, TEAM_MEMBER_ROLES } from '../../enums.ts';
import { cleanText } from '../tickets.ts';
import { ADMIN_LIMITS } from './common.ts';

export const STAFF_DIRECTORY_MAX = 500;

export const staffDirectoryQuerySchema = z.object({
  search: cleanText().max(ADMIN_LIMITS.searchMax).optional(),
  /** Only members of this team. */
  teamId: z.uuid().optional(),
  role: z.enum(STAFF_ROLES).optional(),
  limit: z.coerce.number().int().min(1).max(STAFF_DIRECTORY_MAX).optional().default(200),
});
export type StaffDirectoryQuery = z.infer<typeof staffDirectoryQuerySchema>;

export const staffDirectoryEntrySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  role: z.enum(STAFF_ROLES),
  jobTitle: z.string().nullable(),
  hasPhone: z.boolean(),
  /** The phone is an international number (usable for SMS / on-call). */
  phoneValid: z.boolean(),
  /** Memberships in active teams. */
  teams: z.array(z.object({ teamId: z.uuid(), memberRole: z.enum(TEAM_MEMBER_ROLES) })),
});
export type StaffDirectoryEntry = z.infer<typeof staffDirectoryEntrySchema>;

export const staffDirectorySchema = z.object({ items: z.array(staffDirectoryEntrySchema) });
export type StaffDirectory = z.infer<typeof staffDirectorySchema>;
