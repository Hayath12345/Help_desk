import type { Prisma } from '@loons/db';
import type {
  AdminListQuery,
  ArchiveBody,
  CategoryAdminDto,
  CategoryHiddenReason,
  CreateCategoryInput,
  CreateSubtypeInput,
  ReorderBody,
  SetCategoryFieldsInput,
  SubtypeAdminDto,
  UpdateCategoryInput,
  UpdateSubtypeInput,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { DEFAULT_SECURITY_CATEGORY_KEY } from '../ticket-config.service.ts';
import type { AuditRecorder } from './audit.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh, lockRows, shareActive } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import { applyReorder, writeCategoryFieldOrder, writeSortOrder } from './reorder.ts';
import type { AdminContext } from './write.ts';

// Admin — Categories & sub-types (spec §10.1; decisions E4, E5, E6, E16). Contract:
// packages/shared/src/schemas/admin/categories.ts; routes: ../../routes/admin/categories.ts.
//
// Rules:
// - Super admins only (the route plugin already refuses team leads; checked again here).
// - A category is created with its first sub-type (a category without an active sub-type never
//   appears on the New Ticket form; the list says why: `hiddenReason`).
// - Keys are generated from the English label when omitted (collision suffix, archived rows
//   included) and never change afterwards (E4). Sub-type keys are unique within their category.
// - A category routes to an ACTIVE team (400 `validation.teamArchived` on `teamId`); an archived
//   category can't be restored while its team is archived (409 guard `category_team_archived`).
// - The security category (`tickets.securityCategoryKey`) can't be archived, nor its last active
//   sub-type (409 guards `security_category`, `security_category_last_subtype`, E5).
// - Linked custom fields: newly linked fields must be active; fields already linked stay linked
//   when archived (old tickets keep them). Link changes bump the category's `updatedAt` and the
//   `updatedAt` of every field linked or unlinked (a custom-field edit sends the whole category
//   set, so one started before the change is stale, E19). Lock order: the fields, then the
//   category — the custom-field side's order (its field, then the categories), so they queue.
// - Every write: audit rows in the same transaction (E17), scope `ticket-form` after commit (E18).

type Db = Prisma.TransactionClient;

const SCOPE = 'ticket-form' as const;

const subtypeSelect = {
  id: true,
  categoryId: true,
  key: true,
  labelEn: true,
  labelAr: true,
  defaultPriority: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SubtypeSelect;

type SubtypeRow = Prisma.SubtypeGetPayload<{ select: typeof subtypeSelect }>;

/** Sub-types and categories in form order (the New Ticket form's order, ties by id). */
const SUBTYPE_ORDER = [
  { sortOrder: 'asc' },
  { labelEn: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.SubtypeOrderByWithRelationInput[];
const CATEGORY_ORDER = [
  { sortOrder: 'asc' },
  { labelEn: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.CategoryOrderByWithRelationInput[];

const categorySelect = {
  id: true,
  key: true,
  labelEn: true,
  labelAr: true,
  icon: true,
  assetPlaceholder: true,
  assetPlaceholderAr: true,
  teamId: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  team: { select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true } },
  subtypes: { orderBy: [...SUBTYPE_ORDER], select: subtypeSelect },
  fields: {
    orderBy: [{ sortOrder: 'asc' }, { fieldId: 'asc' }],
    select: {
      sortOrder: true,
      field: {
        select: {
          id: true,
          key: true,
          labelEn: true,
          labelAr: true,
          type: true,
          required: true,
          isActive: true,
        },
      },
    },
  },
} as const satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof categorySelect }>;

/** The audited columns of a category (the rest is bookkeeping). */
function categoryAudit(row: {
  key: string;
  labelEn: string;
  labelAr: string;
  icon: string;
  assetPlaceholder: string | null;
  assetPlaceholderAr: string | null;
  teamId: string;
  isActive: boolean;
}) {
  return {
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    icon: row.icon,
    assetPlaceholder: row.assetPlaceholder,
    assetPlaceholderAr: row.assetPlaceholderAr,
    teamId: row.teamId,
    isActive: row.isActive,
  };
}

function subtypeAudit(row: SubtypeRow) {
  return {
    categoryId: row.categoryId,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    defaultPriority: row.defaultPriority,
    isActive: row.isActive,
  };
}

export function toSubtypeDto(row: SubtypeRow): SubtypeAdminDto {
  return {
    id: row.id,
    categoryId: row.categoryId,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    defaultPriority: row.defaultPriority,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Why a category is not on the New Ticket form (null: it is). */
export function categoryHiddenReason(row: {
  isActive: boolean;
  team: { isActive: boolean };
  subtypes: ReadonlyArray<{ isActive: boolean }>;
}): CategoryHiddenReason | null {
  if (!row.isActive) return 'archived';
  if (!row.subtypes.some((s) => s.isActive)) return 'no_active_subtype';
  if (!row.team.isActive) return 'team_archived';
  return null;
}

function toCategoryDto(row: CategoryRow, securityKey: string): CategoryAdminDto {
  return {
    id: row.id,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    icon: row.icon,
    assetPlaceholder: row.assetPlaceholder,
    assetPlaceholderAr: row.assetPlaceholderAr,
    team: row.team,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isSecurityCategory: row.key === securityKey,
    hiddenReason: categoryHiddenReason(row),
    subtypes: row.subtypes.map(toSubtypeDto),
    fields: row.fields.map((link) => ({
      fieldId: link.field.id,
      key: link.field.key,
      labelEn: link.field.labelEn,
      labelAr: link.field.labelAr,
      type: link.field.type,
      required: link.field.required,
      isActive: link.field.isActive,
      sortOrder: link.sortOrder,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `tickets.securityCategoryKey` (AppSetting), as the form config reads it. */
export async function securityCategoryKey(db: Db): Promise<string> {
  const row = await db.appSetting.findUnique({
    where: { key: 'tickets.securityCategoryKey' },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_SECURITY_CATEGORY_KEY;
}

const issue = (path: Array<string | number>, message: string, code: string): ValidationIssue => ({
  location: 'body',
  path,
  message,
  code,
});

/**
 * 400 unless `teamId` is an active team. The team is read FOR SHARE, so a concurrent team archive
 * (which locks the team, then counts its active categories) either finishes first and this sees
 * the archived team, or waits for this transaction and then counts the category (E5).
 */
async function assertActiveTeam(db: Db, teamId: string, path: Array<string | number>) {
  const team = await shareActive(db, 'Team', teamId);
  if (!team) throw errors.validation([issue(path, 'validation.notFound', 'team')]);
  if (!team.isActive) throw errors.validation([issue(path, 'validation.teamArchived', 'team')]);
}

/**
 * 400 unless every id in `fieldIds` is a custom field, and those not in `alreadyLinked` are
 * active (an archived field stays linked, but is not newly linked).
 */
async function assertLinkableFields(
  db: Db,
  fieldIds: readonly string[],
  alreadyLinked: ReadonlySet<string>,
  path: string,
) {
  if (fieldIds.length === 0) return;
  const rows = await db.customField.findMany({
    where: { id: { in: [...fieldIds] } },
    select: { id: true, isActive: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems: ValidationIssue[] = [];
  fieldIds.forEach((id, i) => {
    const row = byId.get(id);
    if (!row) problems.push(issue([path, i], 'validation.notFound', 'field'));
    else if (!row.isActive && !alreadyLinked.has(id)) {
      problems.push(issue([path, i], 'validation.fieldArchived', 'field'));
    }
  });
  if (problems.length) throw errors.validation(problems);
}

/**
 * The fields' links changed from the category side: a custom-field edit started before must reload
 * (its `categoryIds` replaces the whole set). Lock the fields before the category.
 */
async function touchFields(db: Db, fieldIds: readonly string[]) {
  if (fieldIds.length === 0) return;
  await db.customField.updateMany({
    where: { id: { in: [...fieldIds] } },
    data: { updatedAt: new Date() },
  });
}

async function categoryKey(db: Db, label: string, key: string | undefined): Promise<string> {
  await advisoryLock(db, 'key:Category');
  if (key !== undefined) {
    const existing = await db.category.findUnique({
      where: { key },
      select: { id: true, isActive: true },
    });
    if (existing) throw adminErrors.duplicate(['key'], existing);
    return key;
  }
  return generateKey({
    label,
    fallbackPrefix: 'category',
    taken: async (candidates) =>
      (
        await db.category.findMany({ where: { key: { in: candidates } }, select: { key: true } })
      ).map((r) => r.key),
  });
}

async function subtypeKey(
  db: Db,
  categoryId: string,
  label: string,
  key: string | undefined,
  path: string[],
): Promise<string> {
  await advisoryLock(db, `key:Subtype:${categoryId}`);
  if (key !== undefined) {
    const existing = await db.subtype.findUnique({
      where: { categoryId_key: { categoryId, key } },
      select: { id: true, isActive: true },
    });
    if (existing) throw adminErrors.duplicate([...path, 'key'], existing);
    return key;
  }
  return generateKey({
    label,
    fallbackPrefix: 'subtype',
    taken: async (candidates) =>
      (
        await db.subtype.findMany({
          where: { categoryId, key: { in: candidates } },
          select: { key: true },
        })
      ).map((r) => r.key),
  });
}

export interface CategoriesAdminService {
  list(ctx: AdminContext, query: AdminListQuery): Promise<CategoryAdminDto[]>;
  create(ctx: AdminContext, input: CreateCategoryInput): Promise<CategoryAdminDto>;
  update(ctx: AdminContext, id: string, input: UpdateCategoryInput): Promise<CategoryAdminDto>;
  archive(ctx: AdminContext, id: string, input: ArchiveBody): Promise<CategoryAdminDto>;
  restore(ctx: AdminContext, id: string, input: ArchiveBody): Promise<CategoryAdminDto>;
  reorder(ctx: AdminContext, input: ReorderBody): Promise<void>;
  setFields(
    ctx: AdminContext,
    id: string,
    input: SetCategoryFieldsInput,
  ): Promise<CategoryAdminDto>;
  createSubtype(
    ctx: AdminContext,
    categoryId: string,
    input: CreateSubtypeInput,
  ): Promise<SubtypeAdminDto>;
  updateSubtype(
    ctx: AdminContext,
    categoryId: string,
    subtypeId: string,
    input: UpdateSubtypeInput,
  ): Promise<SubtypeAdminDto>;
  archiveSubtype(
    ctx: AdminContext,
    categoryId: string,
    subtypeId: string,
    input: ArchiveBody,
  ): Promise<SubtypeAdminDto>;
  restoreSubtype(
    ctx: AdminContext,
    categoryId: string,
    subtypeId: string,
    input: ArchiveBody,
  ): Promise<SubtypeAdminDto>;
  reorderSubtypes(ctx: AdminContext, categoryId: string, input: ReorderBody): Promise<void>;
}

export interface CategoriesAdminOptions {
  /** Where the security category key comes from (default: the AppSetting; tests inject one). */
  securityCategoryKey?: (db: Db) => Promise<string>;
}

export function createCategoriesAdminService(
  deps: Pick<AdminDeps, 'prisma' | 'writer'>,
  options: CategoriesAdminOptions = {},
): CategoriesAdminService {
  const { prisma, writer } = deps;
  const readSecurityKey = options.securityCategoryKey ?? securityCategoryKey;

  /**
   * The row as the API returns it, read after the write committed: its nested reads run in
   * parallel, which one transaction connection can't do.
   */
  async function load(db: Db, id: string): Promise<CategoryAdminDto> {
    const row = await db.category.findUniqueOrThrow({ where: { id }, select: categorySelect });
    return toCategoryDto(row, await readSecurityKey(db));
  }

  /** The sub-type, locked and fresh, of this category (404 when it belongs to another one). */
  async function lockSubtype(db: Db, categoryId: string, subtypeId: string, expected: string) {
    await lockFresh(db, 'Subtype', subtypeId, expected);
    const row = await db.subtype.findUniqueOrThrow({
      where: { id: subtypeId },
      select: subtypeSelect,
    });
    if (row.categoryId !== categoryId) throw errors.notFound();
    return row;
  }

  async function setActive(
    ctx: AdminContext,
    id: string,
    input: ArchiveBody,
    isActive: boolean,
  ): Promise<CategoryAdminDto> {
    requireSuperAdmin(ctx.actor);
    await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
      await lockFresh(tx, 'Category', id, input.expectedUpdatedAt);
      const before = await tx.category.findUniqueOrThrow({ where: { id } });
      if (!isActive && before.key === (await readSecurityKey(tx))) {
        throw adminErrors.guard(
          'security_category',
          'The security category can’t be archived. Choose another security category in General settings first.',
        );
      }
      if (isActive && !(await shareActive(tx, 'Team', before.teamId))?.isActive) {
        throw adminErrors.guard(
          'category_team_archived',
          'This category routes to an archived team. Route it to an active team first.',
        );
      }
      if (before.isActive === isActive) return;
      const after = await tx.category.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Category',
        entityId: id,
        entityLabel: after.labelEn,
        before: categoryAudit(before),
        after: categoryAudit(after),
      });
    });
    return load(prisma, id);
  }

  async function setSubtypeActive(
    ctx: AdminContext,
    categoryId: string,
    subtypeId: string,
    input: ArchiveBody,
    isActive: boolean,
  ): Promise<SubtypeAdminDto> {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
      const before = await lockSubtype(tx, categoryId, subtypeId, input.expectedUpdatedAt);
      if (before.isActive === isActive) return toSubtypeDto(before);
      if (!isActive) {
        // Serialise with other sub-type archives of this category (the last-one guard), and with
        // General settings choosing this category as the security category: settings locks the
        // category row before it counts the active sub-types, and this read waits for that lock
        // (then sees the committed security key), or settings waits for this archive (E5).
        await advisoryLock(tx, `subtypes:${categoryId}`);
        await shareActive(tx, 'Category', categoryId);
        const category = await tx.category.findUniqueOrThrow({
          where: { id: categoryId },
          select: { key: true },
        });
        if (category.key === (await readSecurityKey(tx))) {
          const others = await tx.subtype.count({
            where: { categoryId, isActive: true, id: { not: subtypeId } },
          });
          if (others === 0) {
            throw adminErrors.guard(
              'security_category_last_subtype',
              'The security category needs at least one active sub-type.',
            );
          }
        }
      }
      const after = await tx.subtype.update({
        where: { id: subtypeId },
        data: { isActive },
        select: subtypeSelect,
      });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Subtype',
        entityId: subtypeId,
        entityLabel: after.labelEn,
        before: subtypeAudit(before),
        after: subtypeAudit(after),
      });
      return toSubtypeDto(after);
    });
  }

  /**
   * Replaces the category's linked fields with `fieldIds` (in form order): links removed are
   * deleted, new ones created, and positions written; the fields linked or unlinked get a new
   * `updatedAt`. Audit: CategoryField CREATE / DELETE per link and one REORDER when the kept links
   * changed order. Returns whether anything changed. Call it with the fields and category locked.
   */
  async function writeLinks(
    tx: Db,
    audit: AuditRecorder,
    categoryId: string,
    fieldIds: readonly string[],
  ): Promise<boolean> {
    const current = await tx.categoryField.findMany({
      where: { categoryId },
      orderBy: [{ sortOrder: 'asc' }, { fieldId: 'asc' }],
      select: { fieldId: true, field: { select: { labelEn: true } } },
    });
    const currentIds = current.map((l) => l.fieldId);
    const linked = new Set(currentIds);
    await assertLinkableFields(tx, fieldIds, linked, 'fieldIds');
    const next = new Set(fieldIds);
    const removed = current.filter((l) => !next.has(l.fieldId));
    const added = fieldIds.filter((id) => !linked.has(id));
    if (removed.length) {
      await tx.categoryField.deleteMany({
        where: { categoryId, fieldId: { in: removed.map((l) => l.fieldId) } },
      });
    }
    if (added.length) {
      await tx.categoryField.createMany({
        data: added.map((fieldId) => ({
          categoryId,
          fieldId,
          sortOrder: fieldIds.indexOf(fieldId),
        })),
      });
    }
    await writeCategoryFieldOrder(tx, categoryId, fieldIds);
    await touchFields(tx, [...added, ...removed.map((l) => l.fieldId)]);

    const labels = new Map(
      (
        await tx.customField.findMany({
          where: { id: { in: [...added] } },
          select: { id: true, labelEn: true },
        })
      ).map((f) => [f.id, f.labelEn]),
    );
    for (const fieldId of added) {
      await audit.record({
        action: 'CREATE',
        entity: 'CategoryField',
        entityId: `${categoryId}:${fieldId}`,
        entityLabel: labels.get(fieldId) ?? null,
        after: { categoryId, fieldId, position: fieldIds.indexOf(fieldId) },
      });
    }
    for (const link of removed) {
      await audit.record({
        action: 'DELETE',
        entity: 'CategoryField',
        entityId: `${categoryId}:${link.fieldId}`,
        entityLabel: link.field.labelEn,
        before: { categoryId, fieldId: link.fieldId },
      });
    }
    const keptBefore = currentIds.filter((id) => next.has(id));
    const keptAfter = fieldIds.filter((id) => linked.has(id));
    if (keptBefore.join() !== keptAfter.join()) {
      const category = await tx.category.findUniqueOrThrow({
        where: { id: categoryId },
        select: { labelEn: true },
      });
      await audit.record({
        action: 'REORDER',
        entity: 'CategoryField',
        entityId: categoryId,
        entityLabel: category.labelEn,
        before: { order: keptBefore },
        after: { order: keptAfter },
      });
    }
    return removed.length > 0 || added.length > 0 || keptBefore.join() !== keptAfter.join();
  }

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const term = query.search?.trim();
      const [rows, securityKey] = await Promise.all([
        prisma.category.findMany({
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
          orderBy: [...CATEGORY_ORDER],
          select: categorySelect,
        }),
        readSecurityKey(prisma),
      ]);
      return rows.map((row) => toCategoryDto(row, securityKey));
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      const id = await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await lockRows(tx, 'CustomField', input.fieldIds);
        await assertActiveTeam(tx, input.teamId, ['teamId']);
        await assertLinkableFields(tx, input.fieldIds, new Set(), 'fieldIds');
        const key = await categoryKey(tx, input.labelEn, input.key);
        const last = await tx.category.aggregate({ _max: { sortOrder: true } });
        const category = await tx.category.create({
          data: {
            key,
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            icon: input.icon,
            assetPlaceholder: input.assetPlaceholder,
            assetPlaceholderAr: input.assetPlaceholderAr,
            teamId: input.teamId,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
        });
        const first = input.firstSubtype;
        const subtype = await tx.subtype.create({
          data: {
            categoryId: category.id,
            key: await subtypeKey(tx, category.id, first.labelEn, first.key, ['firstSubtype']),
            labelEn: first.labelEn,
            labelAr: first.labelAr,
            defaultPriority: first.defaultPriority,
            sortOrder: 0,
          },
          select: subtypeSelect,
        });
        if (input.fieldIds.length) {
          await tx.categoryField.createMany({
            data: input.fieldIds.map((fieldId, i) => ({
              categoryId: category.id,
              fieldId,
              sortOrder: i,
            })),
          });
          await touchFields(tx, input.fieldIds);
        }
        await audit.record({
          action: 'CREATE',
          entity: 'Category',
          entityId: category.id,
          entityLabel: category.labelEn,
          after: { ...categoryAudit(category), fieldIds: input.fieldIds },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Subtype',
          entityId: subtype.id,
          entityLabel: subtype.labelEn,
          after: subtypeAudit(subtype),
        });
        return category.id;
      });
      return load(prisma, id);
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Category', id, input.expectedUpdatedAt);
        const before = await tx.category.findUniqueOrThrow({ where: { id } });
        if (input.teamId !== undefined && input.teamId !== before.teamId) {
          await assertActiveTeam(tx, input.teamId, ['teamId']);
        }
        const after = await tx.category.update({
          where: { id },
          data: {
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            icon: input.icon,
            assetPlaceholder: input.assetPlaceholder,
            assetPlaceholderAr: input.assetPlaceholderAr,
            teamId: input.teamId,
          },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Category',
          entityId: id,
          entityLabel: after.labelEn,
          before: categoryAudit(before),
          after: categoryAudit(after),
        });
      });
      return load(prisma, id);
    },

    archive: (ctx, id, input) => setActive(ctx, id, input, false),
    restore: (ctx, id, input) => setActive(ctx, id, input, true),

    async reorder(ctx, input) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const changed = await applyReorder(tx, {
          list: 'Category',
          body: input,
          currentIds: async () =>
            (
              await tx.category.findMany({
                where: { isActive: true },
                orderBy: [...CATEGORY_ORDER],
                select: { id: true },
              })
            ).map((r) => r.id),
          write: (ids) => writeSortOrder(tx, 'Category', ids),
        });
        if (changed) {
          await audit.record({
            action: 'REORDER',
            entity: 'Category',
            entityId: 'categories',
            entityLabel: 'Categories',
            before: { order: changed.before },
            after: { order: changed.after },
          });
        }
      });
    },

    async setFields(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        // The fields first (linked now or to be), then the category: custom-field writes lock in
        // that order too. A link another writer adds before the category lock bumps the
        // category's `updatedAt`, so the lockFresh below refuses the save as stale.
        const linkedNow = await tx.categoryField.findMany({
          where: { categoryId: id },
          select: { fieldId: true },
        });
        await lockRows(tx, 'CustomField', [...linkedNow.map((l) => l.fieldId), ...input.fieldIds]);
        await lockFresh(tx, 'Category', id, input.expectedUpdatedAt);
        const changed = await writeLinks(tx, audit, id, input.fieldIds);
        // The linked fields are part of the category: an edit started before this is stale.
        if (changed) await tx.category.update({ where: { id }, data: { updatedAt: new Date() } });
      });
      return load(prisma, id);
    },

    async createSubtype(ctx, categoryId, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const category = await tx.category.findUnique({
          where: { id: categoryId },
          select: { id: true },
        });
        if (!category) throw errors.notFound();
        const key = await subtypeKey(tx, categoryId, input.labelEn, input.key, []);
        const last = await tx.subtype.aggregate({
          where: { categoryId },
          _max: { sortOrder: true },
        });
        const row = await tx.subtype.create({
          data: {
            categoryId,
            key,
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            defaultPriority: input.defaultPriority,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
          select: subtypeSelect,
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Subtype',
          entityId: row.id,
          entityLabel: row.labelEn,
          after: subtypeAudit(row),
        });
        return toSubtypeDto(row);
      });
    },

    async updateSubtype(ctx, categoryId, subtypeId, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const before = await lockSubtype(tx, categoryId, subtypeId, input.expectedUpdatedAt);
        const after = await tx.subtype.update({
          where: { id: subtypeId },
          data: {
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            defaultPriority: input.defaultPriority,
          },
          select: subtypeSelect,
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Subtype',
          entityId: subtypeId,
          entityLabel: after.labelEn,
          before: subtypeAudit(before),
          after: subtypeAudit(after),
        });
        return toSubtypeDto(after);
      });
    },

    archiveSubtype: (ctx, categoryId, subtypeId, input) =>
      setSubtypeActive(ctx, categoryId, subtypeId, input, false),
    restoreSubtype: (ctx, categoryId, subtypeId, input) =>
      setSubtypeActive(ctx, categoryId, subtypeId, input, true),

    async reorderSubtypes(ctx, categoryId, input) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        const category = await tx.category.findUnique({
          where: { id: categoryId },
          select: { id: true, labelEn: true },
        });
        if (!category) throw errors.notFound();
        const changed = await applyReorder(tx, {
          list: `Subtype:${categoryId}`,
          body: input,
          currentIds: async () =>
            (
              await tx.subtype.findMany({
                where: { categoryId, isActive: true },
                orderBy: [...SUBTYPE_ORDER],
                select: { id: true },
              })
            ).map((r) => r.id),
          write: (ids) => writeSortOrder(tx, 'Subtype', ids),
        });
        if (changed) {
          await audit.record({
            action: 'REORDER',
            entity: 'Subtype',
            entityId: categoryId,
            entityLabel: category.labelEn,
            before: { order: changed.before },
            after: { order: changed.after },
          });
        }
      });
    },
  };
}
