import type { Prisma } from '@loons/db';
import type {
  ArchiveBody,
  CreateMacroInput,
  MacroAdminDto,
  ReorderMacrosInput,
  UpdateMacroInput,
  macroListQuerySchema,
} from '@loons/shared';
import type { z } from 'zod';
import { errors } from '../../lib/errors.ts';
import { requireMacroAccess, requireMacroMove, teamScopeFilter } from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import { applyReorder, writeSortOrder } from './reorder.ts';
import type { AdminContext } from './write.ts';

// Admin — Macros (spec §10.8; decision E7). Contract: packages/shared/src/schemas/admin/macros.ts;
// routes: ../../routes/admin/macros.ts.
//
// Rules:
// - Super admins manage every macro (global ones and every team's). Team leads manage the macros
//   of the teams they lead only: never global ones, never another team's, and they never move a
//   macro to another team or to global (403, services/admin/authz.ts).
// - `setStatus` is limited to the statuses staff may set (shared schema); bodies may use the
//   composer variables only (`{{requesterFirstName}}`, `{{siteName}}`; shared schema).
// - A macro belongs to an active team (400 `validation.teamArchived` on `teamId`) or is global.
// - Keys are generated from the English title when omitted and never change (E4).
// - Order is per scope: the global macros, or one team's (`sortOrder`); new macros go last.
// - Every write: audit rows in the same transaction (E17), scope `macros` after commit (E18).

type Db = Prisma.TransactionClient;
type MacroListQuery = z.output<typeof macroListQuerySchema>;

const SCOPE = 'macros' as const;

const MACRO_ORDER = [
  { sortOrder: 'asc' },
  { titleEn: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.MacroOrderByWithRelationInput[];

const macroSelect = {
  id: true,
  key: true,
  teamId: true,
  titleEn: true,
  titleAr: true,
  bodyEn: true,
  bodyAr: true,
  setStatus: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  team: { select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.MacroSelect;

type MacroRow = Prisma.MacroGetPayload<{ select: typeof macroSelect }>;

function toMacroDto(row: MacroRow): MacroAdminDto {
  return {
    id: row.id,
    key: row.key,
    teamId: row.teamId,
    team: row.team,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    bodyEn: row.bodyEn,
    bodyAr: row.bodyAr,
    setStatus: row.setStatus,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function macroAudit(row: {
  key: string;
  teamId: string | null;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  setStatus: string | null;
  isActive: boolean;
}) {
  return {
    key: row.key,
    teamId: row.teamId,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    bodyEn: row.bodyEn,
    bodyAr: row.bodyAr,
    setStatus: row.setStatus,
    isActive: row.isActive,
  };
}

/** 400 unless `teamId` is an active team (null = global: nothing to check). */
async function assertMacroTeam(db: Db, teamId: string | null) {
  if (teamId === null) return;
  const team = await db.team.findUnique({ where: { id: teamId }, select: { isActive: true } });
  const message = !team ? 'validation.notFound' : !team.isActive ? 'validation.teamArchived' : null;
  if (message) {
    throw errors.validation([{ location: 'body', path: ['teamId'], message, code: 'team' }]);
  }
}

async function nextSortOrder(db: Db, teamId: string | null): Promise<number> {
  const last = await db.macro.aggregate({ where: { teamId }, _max: { sortOrder: true } });
  return (last._max.sortOrder ?? -1) + 1;
}

export interface MacrosAdminService {
  list(ctx: AdminContext, query: MacroListQuery): Promise<MacroAdminDto[]>;
  create(ctx: AdminContext, input: CreateMacroInput): Promise<MacroAdminDto>;
  update(ctx: AdminContext, id: string, input: UpdateMacroInput): Promise<MacroAdminDto>;
  archive(ctx: AdminContext, id: string, input: ArchiveBody): Promise<MacroAdminDto>;
  restore(ctx: AdminContext, id: string, input: ArchiveBody): Promise<MacroAdminDto>;
  reorder(ctx: AdminContext, input: ReorderMacrosInput): Promise<void>;
}

/** The audit label of a macro list reorder: the team's list, or the global one (contract-5). */
export function macroReorderLabel(teamId: string | null, teamNameEn?: string | null): string {
  return teamId ? `${teamNameEn ?? teamId} macros` : 'Global macros';
}

export function createMacrosAdminService(deps: AdminDeps): MacrosAdminService {
  const { prisma, writer } = deps;

  const load = async (db: Db, id: string) =>
    toMacroDto(await db.macro.findUniqueOrThrow({ where: { id }, select: macroSelect }));

  /**
   * The macro, locked: 404 when missing, 403 when the caller may not manage its scope (checked
   * before the stale check, so a team lead learns nothing about other teams' macros), 409 stale.
   */
  async function lockMacro(db: Db, ctx: AdminContext, id: string, expectedUpdatedAt: string) {
    const found = await db.macro.findUnique({ where: { id }, select: { teamId: true } });
    if (!found) throw errors.notFound();
    requireMacroAccess(ctx.actor, found.teamId);
    await lockFresh(db, 'Macro', id, expectedUpdatedAt);
    const row = await db.macro.findUniqueOrThrow({ where: { id } });
    requireMacroAccess(ctx.actor, row.teamId); // moved meanwhile
    return row;
  }

  async function setActive(ctx: AdminContext, id: string, input: ArchiveBody, isActive: boolean) {
    return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
      const before = await lockMacro(tx, ctx, id, input.expectedUpdatedAt);
      if (before.isActive === isActive) return load(tx, id);
      const after = await tx.macro.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Macro',
        entityId: id,
        entityLabel: after.titleEn,
        before: macroAudit(before),
        after: macroAudit(after),
      });
      return load(tx, id);
    });
  }

  return {
    async list(ctx, query) {
      const scope = teamScopeFilter(ctx.actor);
      if (query.teamId !== undefined) {
        requireMacroAccess(ctx.actor, query.teamId === 'global' ? null : query.teamId);
      }
      const term = query.search?.trim();
      const rows = await prisma.macro.findMany({
        where: {
          // Team leads: their teams' macros only (never global ones).
          ...(scope ? { teamId: scope } : {}),
          ...(query.teamId === undefined
            ? {}
            : { teamId: query.teamId === 'global' ? null : query.teamId }),
          ...(query.status === 'all' ? {} : { isActive: query.status === 'active' }),
          ...(term
            ? {
                OR: [
                  { titleEn: { contains: term, mode: 'insensitive' } },
                  { titleAr: { contains: term, mode: 'insensitive' } },
                  { key: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ team: { sortOrder: 'asc' } }, { teamId: 'asc' }, ...MACRO_ORDER],
        select: macroSelect,
      });
      // Global macros first, then teams in their order.
      return rows
        .map(toMacroDto)
        .sort((a, b) => Number(a.teamId !== null) - Number(b.teamId !== null));
    },

    async create(ctx, input) {
      requireMacroAccess(ctx.actor, input.teamId);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await assertMacroTeam(tx, input.teamId);
        await advisoryLock(tx, 'key:Macro');
        let key = input.key;
        if (key !== undefined) {
          const existing = await tx.macro.findUnique({
            where: { key },
            select: { id: true, isActive: true },
          });
          // A team lead learns only that the key is taken (not which macro has it).
          if (existing) throw adminErrors.duplicate(['key']);
        } else {
          key = await generateKey({
            label: input.titleEn,
            fallbackPrefix: 'macro',
            taken: async (candidates) =>
              (
                await tx.macro.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((r) => r.key),
          });
        }
        const row = await tx.macro.create({
          data: {
            key,
            teamId: input.teamId,
            titleEn: input.titleEn,
            titleAr: input.titleAr,
            bodyEn: input.bodyEn,
            bodyAr: input.bodyAr,
            setStatus: input.setStatus,
            sortOrder: await nextSortOrder(tx, input.teamId),
            createdById: ctx.actor.id,
          },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Macro',
          entityId: row.id,
          entityLabel: row.titleEn,
          after: macroAudit(row),
        });
        return load(tx, row.id);
      });
    },

    async update(ctx, id, input) {
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const before = await lockMacro(tx, ctx, id, input.expectedUpdatedAt);
        const moving = input.teamId !== undefined && input.teamId !== before.teamId;
        if (moving) {
          const to = input.teamId ?? null;
          requireMacroMove(ctx.actor, before.teamId, to);
          await assertMacroTeam(tx, to);
        }
        const after = await tx.macro.update({
          where: { id },
          data: {
            ...(moving
              ? {
                  teamId: input.teamId ?? null,
                  sortOrder: await nextSortOrder(tx, input.teamId ?? null),
                }
              : {}),
            titleEn: input.titleEn,
            titleAr: input.titleAr,
            bodyEn: input.bodyEn,
            bodyAr: input.bodyAr,
            setStatus: input.setStatus,
          },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Macro',
          entityId: id,
          entityLabel: after.titleEn,
          before: macroAudit(before),
          after: macroAudit(after),
        });
        return load(tx, id);
      });
    },

    archive: (ctx, id, input) => setActive(ctx, id, input, false),
    restore: (ctx, id, input) => setActive(ctx, id, input, true),

    async reorder(ctx, input) {
      requireMacroAccess(ctx.actor, input.teamId);
      await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const changed = await applyReorder(tx, {
          list: `Macro:${input.teamId ?? 'global'}`,
          body: input,
          currentIds: async () =>
            (
              await tx.macro.findMany({
                where: { teamId: input.teamId, isActive: true },
                orderBy: [...MACRO_ORDER],
                select: { id: true },
              })
            ).map((r) => r.id),
          write: (ids) => writeSortOrder(tx, 'Macro', ids),
        });
        if (changed) {
          const team = input.teamId
            ? await tx.team.findUnique({ where: { id: input.teamId }, select: { nameEn: true } })
            : null;
          await audit.record({
            action: 'REORDER',
            entity: 'Macro',
            entityId: input.teamId ?? 'global',
            entityLabel: macroReorderLabel(input.teamId, team?.nameEn),
            before: { order: changed.before },
            after: { order: changed.after },
          });
        }
      });
    },
  };
}
