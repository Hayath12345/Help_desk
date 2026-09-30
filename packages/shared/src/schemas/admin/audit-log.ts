// Admin — Audit log (spec §10.11; decision E17; super admins, read-only).
//
// GET /admin/audit-log?entity=&entityId=&actorId=&action=&from=&to=&cursor=&limit=
//     → { items: AuditLogEntryDto[], nextCursor } — newest first, cursor-paged.
// GET /admin/audit-log/actors
//     → { items: AuditLogActorDto[] } — everyone with at least one entry, whatever their status or
//       role is now (the "Changed by" filter: a disabled or demoted admin stays selectable).
// Rows are written by the API's audit writer in the same transaction as each admin change:
// `before` / `after` hold the changed fields only, redacted (webhook → host, phones masked, never
// password hashes, MFA secrets or session versions).

import { z } from 'zod';
import { AUDIT_ACTIONS, ROLES, USER_STATUSES } from '../../enums.ts';
import { ADMIN_LIMITS, isoDateTime } from './common.ts';

/** The `entity` values the API writes (Prisma model names). */
export const AUDIT_ENTITIES = [
  'Category',
  'Subtype',
  'CustomField',
  'CategoryField',
  'Macro',
  'SlaPolicy',
  'BusinessHours',
  'Holiday',
  'EscalationRule',
  'Team',
  'TeamMember',
  'User',
  'Organization',
  'Site',
  'EmailTemplate',
  'HelpArticle',
  'AppSetting',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  /** null when the actor was deleted since (or a system change). */
  actor: z.object({ id: z.uuid(), name: z.string(), role: z.enum(ROLES) }).nullable(),
  action: z.enum(AUDIT_ACTIONS),
  entity: z.string(),
  entityId: z.string(),
  entityLabel: z.string().nullable(),
  requestId: z.string().nullable(),
  /** Changed fields before the write (null for CREATE). */
  before: z.record(z.string(), z.unknown()).nullable(),
  /** Changed fields after the write (null for DELETE). */
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateTime,
});
export type AuditLogEntryDto = z.infer<typeof auditLogEntrySchema>;

export const auditLogQuerySchema = z.object({
  entity: z.enum(AUDIT_ENTITIES).optional(),
  entityId: z.string().trim().max(100).optional(),
  actorId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  /** Inclusive lower bound on createdAt. */
  from: isoDateTime.optional(),
  /** Exclusive upper bound on createdAt. */
  to: isoDateTime.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIMITS.pageMax)
    .optional()
    .default(ADMIN_LIMITS.pageDefault),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogListSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogList = z.infer<typeof auditLogListSchema>;

/** A person who made at least one audited change, with their current name, role and status. */
export const auditLogActorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
});
export type AuditLogActorDto = z.infer<typeof auditLogActorSchema>;

export const auditLogActorListSchema = z.object({ items: z.array(auditLogActorSchema) });
export type AuditLogActorList = z.infer<typeof auditLogActorListSchema>;
