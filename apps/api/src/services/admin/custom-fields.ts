import { Prisma } from '@loons/db';
import {
  CATEGORY_FIELDS_MAX,
  customFieldOptionsProblem,
  hasOptions,
  storedCustomFieldOptionSchema,
  type AdminListQuery,
  type ArchiveBody,
  type CreateCustomFieldInput,
  type CustomFieldAdminDto,
  type CustomFieldOptionInput,
  type CustomFieldType,
  type UpdateCustomFieldInput,
} from '@loons/shared';
import { z } from 'zod';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh, lockRows } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import type { AdminContext } from './write.ts';

// Admin — Custom fields (spec §10.2; decisions E4, E5, E6). Contract:
// packages/shared/src/schemas/admin/custom-fields.ts; routes: ../../routes/admin/custom-fields.ts.
//
// Rules:
// - Super admins only. Keys (`_` separated: they are the JSON keys of ticket values) are generated
//   from the English label when omitted and never change (E4).
// - The type changes only while no ticket holds a value for the field (409 `field_type_in_use`).
// - DROPDOWN / MULTI_SELECT need at least one active option, other types none. Options are
//   archived one by one (`isActive: false`); removing an option a ticket holds is refused
//   (409 `option_in_use`), so old tickets keep its label (E6).
// - `categoryIds` replaces the linked categories: kept links keep their position, new ones go last
//   in their category, removed ones are deleted. Categories whose links changed get a new
//   `updatedAt` (an open category sheet then reloads before saving over it). A category already
//   holding CATEGORY_FIELDS_MAX fields takes no new link (400 `validation.categoryFieldsFull` on
//   `categoryIds.<i>`), the cap PUT /admin/categories/:id/fields applies; counted with the
//   categories locked, so the two sides can't both add the 31st.
// - Every write: audit rows in the same transaction (E17), scope `ticket-form` after commit (E18).

type Db = Prisma.TransactionClient;

const SCOPE = 'ticket-form' as const;

const fieldSelect = {
  id: true,
  key: true,
  labelEn: true,
  labelAr: true,
  type: true,
  options: true,
  placeholderEn: true,
  placeholderAr: true,
  required: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  categories: {
    orderBy: [{ category: { sortOrder: 'asc' } }, { category: { labelEn: 'asc' } }],
    select: {
      sortOrder: true,
      category: {
        select: { id: true, key: true, labelEn: true, labelAr: true, isActive: true },
      },
    },
  },
} as const satisfies Prisma.CustomFieldSelect;

type FieldRow = Prisma.CustomFieldGetPayload<{ select: typeof fieldSelect }>;

type StoredOption = z.output<typeof storedCustomFieldOptionSchema>;

/** The stored options of a field (archived ones included; unreadable JSON counts as none). */
export function storedOptions(value: unknown): StoredOption[] {
  const parsed = z.array(storedCustomFieldOptionSchema).safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

function toFieldDto(row: FieldRow): CustomFieldAdminDto {
  return {
    id: row.id,
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    type: row.type,
    options: hasOptions(row.type) ? storedOptions(row.options) : [],
    placeholderEn: row.placeholderEn,
    placeholderAr: row.placeholderAr,
    required: row.required,
    isActive: row.isActive,
    categories: row.categories.map((link) => ({ ...link.category, sortOrder: link.sortOrder })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fieldAudit(row: {
  key: string;
  labelEn: string;
  labelAr: string;
  type: CustomFieldType;
  options: unknown;
  placeholderEn: string | null;
  placeholderAr: string | null;
  required: boolean;
  isActive: boolean;
}) {
  return {
    key: row.key,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    type: row.type,
    options: hasOptions(row.type) ? storedOptions(row.options) : null,
    placeholderEn: row.placeholderEn,
    placeholderAr: row.placeholderAr,
    required: row.required,
    isActive: row.isActive,
  };
}

/** Options as stored (`CustomField.options` JSON), or DbNull for types without options. */
function optionsData(
  type: CustomFieldType,
  options: readonly CustomFieldOptionInput[],
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!hasOptions(type)) return Prisma.DbNull;
  return options.map((o) => ({
    value: o.value,
    labelEn: o.labelEn,
    labelAr: o.labelAr,
    isActive: o.isActive,
  }));
}

const issue = (path: Array<string | number>, message: string, code: string): ValidationIssue => ({
  location: 'body',
  path,
  message,
  code,
});

/** Does any ticket hold a value for the field `key`? */
async function fieldHasValues(db: Db, key: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ used: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "Ticket" WHERE jsonb_exists("customFields", ${key})) AS used`;
  return rows[0]?.used === true;
}

/** Which of `values` some ticket holds for the field `key` (single or multi-select values). */
async function optionValuesInUse(
  db: Db,
  key: string,
  values: readonly string[],
): Promise<string[]> {
  if (values.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ value: string }>>`
    SELECT DISTINCT v.value
    FROM "Ticket" t,
      LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(t."customFields" -> ${key}) = 'array'
          THEN t."customFields" -> ${key}
          ELSE jsonb_build_array(t."customFields" -> ${key}) END
      ) AS v(value)
    WHERE jsonb_exists(t."customFields", ${key}) AND v.value = ANY(${[...values]}::text[])`;
  return rows.map((r) => r.value);
}

async function assertCategoriesExist(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return;
  const found = new Set(
    (await db.category.findMany({ where: { id: { in: [...ids] } }, select: { id: true } })).map(
      (c) => c.id,
    ),
  );
  const problems = ids.flatMap((id, i) =>
    found.has(id) ? [] : [issue(['categoryIds', i], 'validation.notFound', 'category')],
  );
  if (problems.length) throw errors.validation(problems);
}

/**
 * 400 when a category in `added` already has CATEGORY_FIELDS_MAX linked fields (issues on their
 * positions in `categoryIds`). Call it with the categories locked (`lockRows`).
 */
async function assertCategoryRoom(
  db: Db,
  added: readonly string[],
  categoryIds: readonly string[],
): Promise<void> {
  const full = new Set<string>();
  for (const categoryId of added) {
    if ((await db.categoryField.count({ where: { categoryId } })) >= CATEGORY_FIELDS_MAX) {
      full.add(categoryId);
    }
  }
  const problems = categoryIds.flatMap((id, i) =>
    full.has(id) ? [issue(['categoryIds', i], 'validation.categoryFieldsFull', 'category')] : [],
  );
  if (problems.length) throw errors.validation(problems);
}

/** Appends the field last in each category (CategoryField.sortOrder = max + 1). */
async function linkLast(db: Db, fieldId: string, categoryIds: readonly string[]) {
  for (const categoryId of categoryIds) {
    const last = await db.categoryField.aggregate({
      where: { categoryId },
      _max: { sortOrder: true },
    });
    await db.categoryField.create({
      data: { categoryId, fieldId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
  }
}

export interface CustomFieldsAdminService {
  list(ctx: AdminContext, query: AdminListQuery): Promise<CustomFieldAdminDto[]>;
  create(ctx: AdminContext, input: CreateCustomFieldInput): Promise<CustomFieldAdminDto>;
  update(
    ctx: AdminContext,
    id: string,
    input: UpdateCustomFieldInput,
  ): Promise<CustomFieldAdminDto>;
  archive(ctx: AdminContext, id: string, input: ArchiveBody): Promise<CustomFieldAdminDto>;
  restore(ctx: AdminContext, id: string, input: ArchiveBody): Promise<CustomFieldAdminDto>;
}

export function createCustomFieldsAdminService(deps: AdminDeps): CustomFieldsAdminService {
  const { prisma, writer } = deps;

  const load = async (db: Db, id: string) =>
    toFieldDto(await db.customField.findUniqueOrThrow({ where: { id }, select: fieldSelect }));

  async function setActive(ctx: AdminContext, id: string, input: ArchiveBody, isActive: boolean) {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
      await lockFresh(tx, 'CustomField', id, input.expectedUpdatedAt);
      const before = await tx.customField.findUniqueOrThrow({ where: { id } });
      if (before.isActive === isActive) return load(tx, id);
      const after = await tx.customField.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'CustomField',
        entityId: id,
        entityLabel: after.labelEn,
        before: fieldAudit(before),
        after: fieldAudit(after),
      });
      return load(tx, id);
    });
  }

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const term = query.search?.trim();
      const rows = await prisma.customField.findMany({
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
        orderBy: [{ labelEn: 'asc' }, { id: 'asc' }],
        select: fieldSelect,
      });
      return rows.map(toFieldDto);
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await assertCategoriesExist(tx, input.categoryIds);
        // Locked like the update below and PUT /admin/categories/:id/fields: the room check holds.
        await lockRows(tx, 'Category', input.categoryIds);
        await assertCategoryRoom(tx, input.categoryIds, input.categoryIds);
        await advisoryLock(tx, 'key:CustomField');
        let key = input.key;
        if (key !== undefined) {
          const existing = await tx.customField.findUnique({
            where: { key },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        } else {
          key = await generateKey({
            label: input.labelEn,
            separator: '_',
            fallbackPrefix: 'field',
            taken: async (candidates) =>
              (
                await tx.customField.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((r) => r.key),
          });
        }
        const row = await tx.customField.create({
          data: {
            key,
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            type: input.type,
            options: optionsData(input.type, input.options),
            placeholderEn: input.placeholderEn,
            placeholderAr: input.placeholderAr,
            required: input.required,
          },
        });
        await linkLast(tx, row.id, input.categoryIds);
        if (input.categoryIds.length) {
          await tx.category.updateMany({
            where: { id: { in: input.categoryIds } },
            data: { updatedAt: new Date() },
          });
        }
        await audit.record({
          action: 'CREATE',
          entity: 'CustomField',
          entityId: row.id,
          entityLabel: row.labelEn,
          after: { ...fieldAudit(row), categoryIds: input.categoryIds },
        });
        return load(tx, row.id);
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: SCOPE }, async ({ tx, audit }) => {
        await lockFresh(tx, 'CustomField', id, input.expectedUpdatedAt);
        const before = await tx.customField.findUniqueOrThrow({
          where: { id },
          include: { categories: { select: { categoryId: true } } },
        });

        const type = input.type ?? before.type;
        const typeChanged = type !== before.type;
        if (typeChanged && (await fieldHasValues(tx, before.key))) {
          throw adminErrors.guard(
            'field_type_in_use',
            'Tickets already hold values for this field, so its type can’t change.',
          );
        }
        const current = storedOptions(before.options);
        // A type without options drops them; a changed type keeps the list only if it has options.
        const options: CustomFieldOptionInput[] =
          input.options ?? (hasOptions(type) && hasOptions(before.type) ? current : []);
        const problem = customFieldOptionsProblem(type, options);
        if (problem) throw errors.validation([issue(['options'], problem, 'options')]);
        if (hasOptions(before.type) && input.options !== undefined) {
          const kept = new Set(options.map((o) => o.value));
          const removed = current.filter((o) => !kept.has(o.value)).map((o) => o.value);
          const inUse = await optionValuesInUse(tx, before.key, removed);
          if (inUse.length) {
            throw adminErrors.guard(
              'option_in_use',
              `Tickets hold these options, so they can’t be removed (archive them instead): ${inUse.join(', ')}.`,
            );
          }
        }

        let beforeCategoryIds = before.categories.map((c) => c.categoryId);
        let categoryIds = beforeCategoryIds;
        if (input.categoryIds !== undefined) {
          await assertCategoriesExist(tx, input.categoryIds);
          // Lock the categories first (id order), as PUT /admin/categories/:id/fields does before
          // it writes links: both sides then queue on the category instead of deadlocking on the
          // link rows. Re-read the links afterwards: a link saved meanwhile is now visible.
          await lockRows(tx, 'Category', [...beforeCategoryIds, ...input.categoryIds]);
          beforeCategoryIds = (
            await tx.categoryField.findMany({
              where: { fieldId: id },
              select: { categoryId: true },
            })
          ).map((c) => c.categoryId);
          const next = new Set(input.categoryIds);
          const had = new Set(beforeCategoryIds);
          const removed = beforeCategoryIds.filter((c) => !next.has(c));
          const added = input.categoryIds.filter((c) => !had.has(c));
          await assertCategoryRoom(tx, added, input.categoryIds);
          if (removed.length) {
            await tx.categoryField.deleteMany({
              where: { fieldId: id, categoryId: { in: removed } },
            });
          }
          await linkLast(tx, id, added);
          if (removed.length || added.length) {
            await tx.category.updateMany({
              where: { id: { in: [...removed, ...added] } },
              data: { updatedAt: new Date() },
            });
          }
          categoryIds = input.categoryIds;
        }

        const optionsChanged =
          input.options !== undefined || typeChanged ? { options: optionsData(type, options) } : {};
        const after = await tx.customField.update({
          where: { id },
          data: {
            type,
            labelEn: input.labelEn,
            labelAr: input.labelAr,
            ...optionsChanged,
            placeholderEn: input.placeholderEn,
            placeholderAr: input.placeholderAr,
            required: input.required,
          },
        });
        const sorted = (ids: readonly string[]) => [...ids].sort();
        await audit.record({
          action: 'UPDATE',
          entity: 'CustomField',
          entityId: id,
          entityLabel: after.labelEn,
          before: { ...fieldAudit(before), categoryIds: sorted(beforeCategoryIds) },
          after: { ...fieldAudit(after), categoryIds: sorted(categoryIds) },
        });
        return load(tx, id);
      });
    },

    archive: (ctx, id, input) => setActive(ctx, id, input, false),
    restore: (ctx, id, input) => setActive(ctx, id, input, true),
  };
}
