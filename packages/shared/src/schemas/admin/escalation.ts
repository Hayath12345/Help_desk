// Admin — Escalation rules (spec §10.6; decision E13). The P1 chain, global (teamId null) and per
// team (a team's own active rules replace the global chain for that team, D3). Steps fire
// `afterMins` after the ticket became P1 (cumulative). Edits re-time pending steps: a step job
// re-checks `p1Since + afterMins` when it fires and waits again when it is early.
//
// GET    /admin/escalation?status=&teamId=            → { items: EscalationRuleAdminDto[] }
// POST   /admin/escalation                            → 201 { item } (409 duplicate + existingId
//                                                       when the step is taken, archived included)
// PATCH  /admin/escalation/:id                        → { item }
// POST   /admin/escalation/:id/archive | /restore     → { item }
// POST   /admin/escalation/reorder                    → 204 (renumbers one chain's steps 1…n; each
//                                                       step keeps its delay slot)
// A chain's delays never go down by step: 400 `validation.chainOrder` on `afterMins` otherwise.
// Scope `escalation`. The on-call user is a Team field (Teams & members).

import { z } from 'zod';
import { ESCALATION_CHANNELS, ESCALATION_TARGET_TYPES, PRIORITIES, ROLES } from '../../enums.ts';
import {
  NOTHING_TO_CHANGE,
  adminListQuerySchema,
  adminTeamRefSchema,
  adminUserRefSchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  reorderBodySchema,
} from './common.ts';

export const ESCALATION_LIMITS = {
  /** MAX_ESCALATION_STEPS in the API. */
  stepsMax: 20,
  /** 7 days. */
  afterMinsMax: 10_080,
} as const;

/** Roles a ROLE step may page: the team's leads (TeamMember LEAD) or every super admin. */
export const ESCALATION_TARGET_ROLES = [
  'TEAM_LEAD',
  'SUPER_ADMIN',
] as const satisfies readonly (typeof ROLES)[number][];

/**
 * Warnings shown next to a rule (it still saves): TEAMS chosen but the team has no webhook;
 * ON_CALL but the team has no on-call user, or theirs has no valid phone for SMS; a USER target
 * that is disabled or has no valid phone for SMS.
 */
export const ESCALATION_WARNINGS = [
  'teams_no_webhook',
  'on_call_missing',
  'on_call_no_phone',
  'target_user_inactive',
  'target_user_no_phone',
] as const;
export type EscalationWarning = (typeof ESCALATION_WARNINGS)[number];

/** What the team warnings need to know about a team. */
export interface EscalationTeamFacts {
  hasWebhook: boolean;
  /** null: no on-call user, or not an active staff member. */
  onCall: { phoneValid: boolean } | null;
  /** Active, and without active P1 rules of its own (it follows the global chain). */
  usesGlobalChain: boolean;
}

/**
 * The warnings about the rule's team(s): TEAMS without a webhook, ON_CALL without an on-call user
 * or (for SMS) without a valid phone. A team rule is checked against its team; a global rule
 * against every active team that follows the global chain ("some teams …"). The API adds the
 * USER-target ones; the rule sheet runs this on the draft, so the warnings follow what is chosen.
 */
export function escalationTeamWarnings(
  rule: {
    teamId: string | null;
    targetType: (typeof ESCALATION_TARGET_TYPES)[number];
    channels: readonly (typeof ESCALATION_CHANNELS)[number][];
  },
  teams: ReadonlyMap<string, EscalationTeamFacts>,
): EscalationWarning[] {
  const scope = rule.teamId
    ? [teams.get(rule.teamId)].filter((t): t is EscalationTeamFacts => t !== undefined)
    : [...teams.values()].filter((t) => t.usesGlobalChain);
  const out: EscalationWarning[] = [];
  if (rule.channels.includes('TEAMS') && scope.some((t) => !t.hasWebhook)) {
    out.push('teams_no_webhook');
  }
  if (rule.targetType === 'ON_CALL') {
    if (scope.some((t) => t.onCall === null)) out.push('on_call_missing');
    if (rule.channels.includes('SMS') && scope.some((t) => t.onCall && !t.onCall.phoneValid)) {
      out.push('on_call_no_phone');
    }
  }
  return out;
}

export const escalationRuleAdminDtoSchema = z.object({
  id: z.uuid(),
  priority: z.enum(PRIORITIES),
  teamId: z.uuid().nullable(),
  team: adminTeamRefSchema.nullable(),
  step: z.number().int(),
  targetType: z.enum(ESCALATION_TARGET_TYPES),
  targetRole: z.enum(ROLES).nullable(),
  targetUser: adminUserRefSchema.extend({ isActive: z.boolean() }).nullable(),
  afterMins: z.number().int(),
  channels: z.array(z.enum(ESCALATION_CHANNELS)),
  isActive: z.boolean(),
  warnings: z.array(z.enum(ESCALATION_WARNINGS)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type EscalationRuleAdminDto = z.infer<typeof escalationRuleAdminDtoSchema>;

export const escalationListQuerySchema = adminListQuerySchema.extend({
  /** A team's own chain, or `global`; omitted = every chain. */
  teamId: z.union([z.uuid(), z.literal('global')]).optional(),
});
export const escalationListSchema = itemListSchema(escalationRuleAdminDtoSchema);
export const escalationRuleResponseSchema = itemResponseSchema(escalationRuleAdminDtoSchema);

const channelsSchema = z
  .array(z.enum(ESCALATION_CHANNELS))
  .min(1, { error: 'validation.required' })
  .max(ESCALATION_CHANNELS.length)
  .refine((c) => new Set(c).size === c.length, { error: 'validation.duplicateValue' });

const afterMinsSchema = z
  .number()
  .int()
  .min(0)
  .max(ESCALATION_LIMITS.afterMinsMax, { error: 'validation.tooLarge' });

interface TargetFields {
  targetType?: (typeof ESCALATION_TARGET_TYPES)[number] | undefined;
  targetRole?: string | null | undefined;
  targetUserId?: string | null | undefined;
}

/**
 * Target consistency: ROLE needs `targetRole` (and no user), USER needs `targetUserId` (and no
 * role), ON_CALL neither. Checked when `targetType` is present.
 */
function checkTarget(value: TargetFields, ctx: z.RefinementCtx): void {
  const { targetType, targetRole, targetUserId } = value;
  if (!targetType) return;
  const wantRole = targetType === 'ROLE';
  const wantUser = targetType === 'USER';
  if (wantRole !== (targetRole != null)) {
    ctx.addIssue({ code: 'custom', path: ['targetRole'], message: 'validation.targetMismatch' });
  }
  if (wantUser !== (targetUserId != null)) {
    ctx.addIssue({ code: 'custom', path: ['targetUserId'], message: 'validation.targetMismatch' });
  }
}

export const createEscalationRuleSchema = z
  .object({
    /** null = the global chain. */
    teamId: z.uuid().nullable(),
    step: z.number().int().min(1).max(ESCALATION_LIMITS.stepsMax),
    targetType: z.enum(ESCALATION_TARGET_TYPES),
    targetRole: z.enum(ESCALATION_TARGET_ROLES).nullable().default(null),
    /** An active staff user. */
    targetUserId: z.uuid().nullable().default(null),
    afterMins: afterMinsSchema,
    channels: channelsSchema,
  })
  .superRefine(checkTarget);
export type CreateEscalationRuleInput = z.infer<typeof createEscalationRuleSchema>;

/**
 * The chain and step never change here (reorder renumbers). Changing `targetType` must send the
 * matching `targetRole` / `targetUserId` (the other one is cleared).
 */
export const updateEscalationRuleSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    targetType: z.enum(ESCALATION_TARGET_TYPES).optional(),
    targetRole: z.enum(ESCALATION_TARGET_ROLES).nullable().optional(),
    targetUserId: z.uuid().nullable().optional(),
    afterMins: afterMinsSchema.optional(),
    channels: channelsSchema.optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE)
  .superRefine(checkTarget);
export type UpdateEscalationRuleInput = z.infer<typeof updateEscalationRuleSchema>;

/**
 * Renumbers the active rules of one chain (`teamId`, null = global) to steps 1…n in `ids` order.
 * Archived rules keep their step numbers only if they don't collide (the API moves them after the
 * active ones). Each step keeps its time slot: a moved rule takes the delay of its new place (the
 * chain's delays never go down by step; create / edit / restore are 400 `validation.chainOrder` on
 * `afterMins` when they would).
 */
export const reorderEscalationSchema = reorderBodySchema.safeExtend({
  teamId: z.uuid().nullable(),
});
export type ReorderEscalationInput = z.infer<typeof reorderEscalationSchema>;
