import type { SlaPolicy } from '@loons/db';
import {
  PRIORITIES,
  type Priority,
  type SlaPolicyAdminDto,
  type UpdateSlaPolicyInput,
} from '@loons/shared';
import { errors } from '../../lib/errors.ts';
import { businessDayMinutes } from '../ticket-config.service.ts';
import { requireSuperAdmin } from './authz.ts';
import { lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import type { AdminContext } from './write.ts';

// Admin — SLA policies (spec §10.4; decision E12). Four fixed rows, one per priority: edit only
// (no create / archive). The form config shows the targets, so a change announces `ticket-form`.
// Changes apply to new tickets and later priority changes: stored due dates and at-risk instants
// of open tickets are NOT recomputed (the web says so).
// Contract: packages/shared/src/schemas/admin/sla.ts; routes: ../../routes/admin/sla.ts.

export interface SlaAdminService {
  /** The four policies (P1…P4) and the configured business-day length. */
  list(ctx: AdminContext): Promise<{ items: SlaPolicyAdminDto[]; businessDayMinutes: number }>;
  /** Replaces one policy's targets (404 unknown priority row, 409 stale). */
  update(
    ctx: AdminContext,
    priority: Priority,
    input: UpdateSlaPolicyInput,
  ): Promise<SlaPolicyAdminDto>;
}

export function slaPolicyDto(row: SlaPolicy): SlaPolicyAdminDto {
  return {
    id: row.id,
    priority: row.priority,
    firstReplyMins: row.firstReplyMins,
    resolveMins: row.resolveMins,
    businessHoursOnly: row.businessHoursOnly,
    atRiskPercent: row.atRiskPercent,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The audited fields of a policy. */
function auditFields(row: SlaPolicy) {
  return {
    firstReplyMins: row.firstReplyMins,
    resolveMins: row.resolveMins,
    businessHoursOnly: row.businessHoursOnly,
    atRiskPercent: row.atRiskPercent,
  };
}

export function createSlaAdminService(deps: AdminDeps): SlaAdminService {
  const { prisma, writer } = deps;

  return {
    async list(ctx) {
      requireSuperAdmin(ctx.actor);
      const [rows, hours] = await Promise.all([
        prisma.slaPolicy.findMany(),
        prisma.businessHours.findMany({ select: { isOpen: true, open: true, close: true } }),
      ]);
      const order = (p: Priority) => PRIORITIES.indexOf(p);
      return {
        items: rows.sort((a, b) => order(a.priority) - order(b.priority)).map(slaPolicyDto),
        businessDayMinutes: businessDayMinutes(hours),
      };
    },

    async update(ctx, priority, input) {
      requireSuperAdmin(ctx.actor);
      // Announced only when something changed (a no-op save moves nothing).
      const row = await writer.write(ctx, { scopes: [] }, async ({ tx, audit, after: effects }) => {
        const existing = await tx.slaPolicy.findUnique({
          where: { priority },
          select: { id: true },
        });
        if (!existing) throw errors.notFound('There is no SLA policy for this priority.');
        await lockFresh(tx, 'SlaPolicy', existing.id, input.expectedUpdatedAt);
        const before = await tx.slaPolicy.findUniqueOrThrow({ where: { id: existing.id } });
        const next = {
          firstReplyMins: input.firstReplyMins,
          resolveMins: input.resolveMins,
          businessHoursOnly: input.businessHoursOnly,
          atRiskPercent: input.atRiskPercent,
        };
        // Saving the same values changes nothing (no new updatedAt, no audit row).
        const unchanged = (Object.keys(next) as Array<keyof typeof next>).every(
          (k) => before[k] === next[k],
        );
        if (unchanged) return before;
        const after = await tx.slaPolicy.update({ where: { id: existing.id }, data: next });
        await audit.record({
          action: 'UPDATE',
          entity: 'SlaPolicy',
          entityId: after.id,
          entityLabel: after.priority,
          before: auditFields(before),
          after: auditFields(after),
        });
        effects.scope('ticket-form');
        return after;
      });
      return slaPolicyDto(row);
    },
  };
}
