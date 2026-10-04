import type { Prisma } from '@loons/db';
import type {
  ArchiveBody,
  CreateSkillInput,
  SkillAdminDto,
  SkillRef,
  UpdateSkillInput,
  skillListQuerySchema,
} from '@loons/shared';
import type { z } from 'zod';
import { errors } from '../../lib/errors.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import type { AdminContext } from './write.ts';

// Admin — Skills (docs/AUTO_ASSIGN.md; super admins only). Contract:
// packages/shared/src/schemas/admin/skills.ts; routes: ../../routes/admin/skills.ts.
//
// - A skill is a label staff can have and categories can ask for. Keys are generated from the
//   English label when omitted and never change (E4); skills are archived, never deleted.
// - Archiving keeps the links but stops them counting for matching, so restoring a skill brings the
//   old setup back as it was.
// - Every write: audit rows in the same transaction (E17), scope `skills` after commit (E18).

type Db = Prisma.TransactionClient;
type SkillListQuery = z.output<typeof skillListQuerySchema>;

const SCOPE = 'skills' as const;

/** Skills as other admin rows show them: by English label (then id, so the order is stable). */
export const SKILL_ORDER = [
  { labelEn: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.SkillOrderByWithRelationInput[];

export const skillRefSelect = {
  id: true,
  key: true,
  labelEn: true,
  labelAr: true,
  isActive: true,
} as const satisfies Prisma.SkillSelect;

/** Skill refs as the staff and category rows show them: by English label, then id. */
export function toSkillRefs(rows: SkillRef[]): SkillRef[] {
  return rows
    .map((r) => ({
      id: r.id,
      key: r.key,
      labelEn: r.labelEn,
      labelAr: r.labelAr,
      isActive: r.isActive,
    }))
    .sort((a, b) => a.labelEn.localeCompare(b.labelEn) || a.id.localeCompare(b.id));
}

const skillSelect = {
  ...skillRefSelect,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      users: { where: { user: { status: 'ACTIVE' } } },
      categories: { where: { category: { isActive: true } } },
    },
  },
} as const satisfies Prisma.SkillSelect;

type SkillRow = Prisma.SkillGetPayload<{ select: typeof skillSelect }>;

function toSkillDto(row: SkillRow): SkillAdminDto {
  return {
    id: row.id,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    isActive: row.isActive,
    staffCount: row._count.users,
    categoryCount: row._count.categories,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function skillAudit(row: { key: string; labelEn: string; labelAr: string; isActive: boolean }) {
  return { key: row.key, labelEn: row.labelEn, labelAr: row.labelAr, isActive: row.isActive };
}

export interface SkillsAdminService {
  list(ctx: AdminContext, query: SkillListQuery): Promise<SkillAdminDto[]>;
  create(ctx: AdminContext, input: CreateSkillInput): Promise<SkillAdminDto>;
  update(ctx: AdminContext, id: string, input: UpdateSkillInput): Promise<SkillAdminDto>;
  archive(ctx: AdminContext, id: string, input: ArchiveBody): Promise<SkillAdminDto>;
  restore(ctx: AdminContext, id: string, input: ArchiveBody): Promise<SkillAdminDto>;
}

export function createSkillsAdminService(deps: AdminDeps): SkillsAdminService {
  const { prisma, writer } = deps;

  const load = async (db: Db, id: string) =>
    toSkillDto(await db.skill.findUniqueOrThrow({ where: { id }, select: skillSelect }));

  async function setActive(ctx: AdminContext, id: string, input: ArchiveBody, isActive: boolean) {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
      await lockFresh(tx, 'Skill', id, input.expectedUpdatedAt);
      const before = await tx.skill.findUniqueOrThrow({ where: { id } });
      if (before.isActive === isActive) return load(tx, id);
      const after = await tx.skill.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Skill',
        entityId: id,
        entityLabel: after.labelEn,
        before: skillAudit(before),
        after: skillAudit(after),
      });
      return load(tx, id);
    });
  }

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const term = query.search?.trim();
      const rows = await prisma.skill.findMany({
        where: {
          ...(query.status === 'all' ? {} : { isActive: query.status === 'active' }),
          ...(term
            ? {
                OR: [
                  { labelEn: { contains: term, mode: 'insensitive' } },
                  { labelAr: { contains: term, mode: 'insensitive' } },
                  { key: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [...SKILL_ORDER],
        select: skillSelect,
      });
      return rows.map(toSkillDto);
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await advisoryLock(tx, 'key:Skill');
        let key = input.key;
        if (key !== undefined) {
          const existing = await tx.skill.findUnique({
            where: { key },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        } else {
          key = await generateKey({
            label: input.labelEn,
            fallbackPrefix: 'skill',
            taken: async (candidates) =>
              (
                await tx.skill.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((r) => r.key),
          });
        }
        // The same English label twice would be indistinguishable in a picker.
        const sameLabel = await tx.skill.findFirst({
          where: { labelEn: { equals: input.labelEn, mode: 'insensitive' } },
          select: { id: true, isActive: true },
        });
        if (sameLabel) throw adminErrors.duplicate(['labelEn'], sameLabel);
        const row = await tx.skill.create({
          data: { key, labelEn: input.labelEn, labelAr: input.labelAr },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Skill',
          entityId: row.id,
          entityLabel: row.labelEn,
          after: skillAudit(row),
        });
        return load(tx, row.id);
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Skill', id, input.expectedUpdatedAt);
        const before = await tx.skill.findUniqueOrThrow({ where: { id } });
        if (input.labelEn !== undefined) {
          const sameLabel = await tx.skill.findFirst({
            where: { id: { not: id }, labelEn: { equals: input.labelEn, mode: 'insensitive' } },
            select: { id: true, isActive: true },
          });
          if (sameLabel) throw adminErrors.duplicate(['labelEn'], sameLabel);
        }
        const after = await tx.skill.update({
          where: { id },
          data: { labelEn: input.labelEn, labelAr: input.labelAr },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Skill',
          entityId: id,
          entityLabel: after.labelEn,
          before: skillAudit(before),
          after: skillAudit(after),
        });
        return load(tx, id);
      });
    },

    archive: (ctx, id, input) => setActive(ctx, id, input, false),
    restore: (ctx, id, input) => setActive(ctx, id, input, true),
  };
}

/**
 * 400 `validation.notFound` / `validation.skillArchived` on `skillIds` unless every id is a skill
 * and every id that is not already linked (`current`) is active — an archived skill that is
 * already on the row may stay.
 */
export async function assertLinkableSkills(
  db: Db,
  skillIds: readonly string[],
  current: readonly string[],
): Promise<void> {
  if (skillIds.length === 0) return;
  const rows = await db.skill.findMany({
    where: { id: { in: [...skillIds] } },
    select: { id: true, isActive: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const already = new Set(current);
  skillIds.forEach((id, index) => {
    const skill = byId.get(id);
    const message = !skill
      ? 'validation.notFound'
      : !skill.isActive && !already.has(id)
        ? 'validation.skillArchived'
        : null;
    if (message) {
      throw errors.validation([
        { location: 'body', path: ['skillIds', index], message, code: 'skill' },
      ]);
    }
  });
}

/** The keys of skill refs, sorted: what the audit log compares for a skills change. */
export function skillKeys(skills: ReadonlyArray<{ key: string }>): string[] {
  return skills.map((s) => s.key).sort();
}
