// Admin — Teams & members (spec §10.3; decisions E5, E6, E7).
//
// GET    /admin/teams?status=                           → { items: TeamAdminDto[] } (team leads:
//                                                         the teams they lead)
// POST   /admin/teams                                   → 201 { item }             super admin
// PATCH  /admin/teams/:id                               → { item }  team leads: onCallUserId only
// POST   /admin/teams/:id/archive | /restore            → { item }                 super admin
// POST   /admin/teams/reorder                           → 204                      super admin
// POST   /admin/teams/:id/members                       → 201 { item }  team leads: role MEMBER
// PATCH  /admin/teams/:id/members/:userId               → { item }  (role)         super admin
//                                                         (sends the team's expectedUpdatedAt)
// DELETE /admin/teams/:id/members/:userId               → { item }  team leads: MEMBER rows
// Scope `teams`. Every member change invalidates the member's principal (sockets re-synced).
// The Teams webhook URL is write-only: reads return `{ configured, host }` (D12), the audit log the
// host only. Archive guards (E5): active categories routed to it, open tickets, active escalation
// rules of the team.

import { z } from 'zod';
import { ROLES, TEAM_MEMBER_ROLES, USER_STATUSES } from '../../enums.ts';
import { emailSchema } from '../auth.ts';
import {
  NOTHING_TO_CHANGE,
  adminKeySchema,
  adminListQuerySchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
} from './common.ts';

export const TEAM_LIMITS = { emailsMax: 20, webhookUrlMax: 2_048 } as const;

/** The Teams webhook as reads show it: never the URL (a secret), only whether one is set. */
export const teamsWebhookDtoSchema = z.object({
  configured: z.boolean(),
  host: z.string().nullable(),
});

export const teamMemberAdminDtoSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.email(),
  /** The account role (AGENT, TEAM_LEAD, SUPER_ADMIN). */
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  /** MEMBER or LEAD of this team. */
  memberRole: z.enum(TEAM_MEMBER_ROLES),
  hasPhone: z.boolean(),
  /** The phone is an international number (usable for SMS). */
  phoneValid: z.boolean(),
  since: isoDateTime,
});
export type TeamMemberAdminDto = z.infer<typeof teamMemberAdminDtoSchema>;

export const teamAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  nameEn: z.string(),
  nameAr: z.string(),
  emails: z.array(z.string()),
  teamsWebhook: teamsWebhookDtoSchema,
  onCallUser: z
    .object({
      id: z.uuid(),
      name: z.string(),
      phoneValid: z.boolean(),
      isMember: z.boolean(),
      isActive: z.boolean(),
    })
    .nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  members: z.array(teamMemberAdminDtoSchema),
  /** Active categories routed to the team (an archive guard). */
  activeCategoryCount: z.number().int().nonnegative(),
  /** Tickets of the team that are NEW, OPEN or PENDING (an archive guard). */
  openTicketCount: z.number().int().nonnegative(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TeamAdminDto = z.infer<typeof teamAdminDtoSchema>;

export const teamListQuerySchema = adminListQuerySchema;
export const teamAdminListSchema = itemListSchema(teamAdminDtoSchema);
export const teamResponseSchema = itemResponseSchema(teamAdminDtoSchema);
export const teamMemberResponseSchema = itemResponseSchema(teamMemberAdminDtoSchema);
/**
 * PATCH /admin/teams/:id/members/:userId: the member, plus the team's `updatedAt` after the change
 * (a role change moves it, E19), so the open team sheet carries on from its own write instead of
 * taking it for someone else's.
 */
export const teamMemberRoleResponseSchema = z.object({
  item: teamMemberAdminDtoSchema,
  teamUpdatedAt: isoDateTime,
});
export type TeamMemberRoleResponse = z.infer<typeof teamMemberRoleResponseSchema>;

/** Distribution list: valid addresses, lower-cased, duplicates dropped (first one kept). */
export const teamEmailsSchema = z
  .array(emailSchema)
  .max(TEAM_LIMITS.emailsMax, { error: 'validation.tooLarge' })
  .transform((emails) => [...new Set(emails)]);

/**
 * https, no credentials, port 443, a host on TEAMS_WEBHOOK_HOSTS (the API checks the host and
 * refuses with 400 `teams_webhook_host`). null clears it.
 */
export const teamsWebhookUrlSchema = z
  .string()
  .trim()
  .max(TEAM_LIMITS.webhookUrlMax, { error: 'validation.tooLong' })
  .pipe(z.url({ protocol: /^https$/, error: 'validation.webhookUrl' }));

export const createTeamSchema = z.object({
  key: adminKeySchema.optional(),
  nameEn: labelEnSchema,
  nameAr: labelArSchema.default(''),
  emails: teamEmailsSchema.default([]),
  teamsWebhookUrl: teamsWebhookUrlSchema.nullable().default(null),
});
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

/**
 * The only body fields a team lead may send to PATCH /admin/teams/:id (E7). Any other field is
 * super admin only: the API answers 403 before it validates the body.
 */
export const TEAM_LEAD_UPDATE_FIELDS = ['expectedUpdatedAt', 'onCallUserId'] as const;

/**
 * Team leads may only send `onCallUserId` (plus `expectedUpdatedAt`, see
 * TEAM_LEAD_UPDATE_FIELDS); everything else is super admin only (403). `teamsWebhookUrl`: omitted =
 * unchanged, null = cleared.
 */
export const updateTeamSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    nameEn: labelEnSchema.optional(),
    nameAr: labelArSchema.optional(),
    emails: teamEmailsSchema.optional(),
    teamsWebhookUrl: teamsWebhookUrlSchema.nullable().optional(),
    /** An active staff member of the team with a valid phone; null = none. */
    onCallUserId: z.uuid().nullable().optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

/** Adds an active staff user. Team leads may only add MEMBER rows. */
export const addTeamMemberSchema = z.object({
  userId: z.uuid(),
  memberRole: z.enum(TEAM_MEMBER_ROLES).default('MEMBER'),
});
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;

/**
 * MEMBER ↔ LEAD (super admins only). `expectedUpdatedAt` is the team's (E19): a role change moves
 * the team's `updatedAt`, so a change made from an older view of the team is 409 `stale`.
 */
export const updateTeamMemberSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  memberRole: z.enum(TEAM_MEMBER_ROLES),
});
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;

export const teamMemberParamSchema = z.object({ id: z.uuid(), userId: z.uuid() });
