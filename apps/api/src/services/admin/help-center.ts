import type { HelpArticle, Prisma } from '@loons/db';
import type {
  AdminListQuery,
  ArchiveBody,
  CreateHelpArticleInput,
  HelpArticleAdminDto,
  ReorderBody,
  UpdateHelpArticleInput,
} from '@loons/shared';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import { applyReorder, writeSortOrder } from './reorder.ts';
import type { AdminContext } from './write.ts';

// Admin — Help center (spec §10.10; decision E15): FAQ articles in English and Arabic. Super admins
// only. Articles are drafts (`isPublished` false) or published; archive / restore instead of
// delete (E5). Active articles are ordered by `sortOrder` (one reorder request per drop, E3); new
// and restored articles go to the end. The portal page that reads published articles is Phase 5.
// Audit: CREATE / UPDATE / ARCHIVE / RESTORE on `HelpArticle` (label = English title), REORDER on
// entity id `help-center` with the keys in order. Scope `help-center`.

type Tx = Prisma.TransactionClient;

/** Active articles' order (also the portal's, services/help.service.ts). */
export const ARTICLE_ORDER = [
  { sortOrder: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.HelpArticleOrderByWithRelationInput[];

export function toHelpArticleDto(row: HelpArticle): HelpArticleAdminDto {
  return {
    id: row.id,
    key: row.key,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    bodyEn: row.bodyEn,
    bodyAr: row.bodyAr,
    sortOrder: row.sortOrder,
    isPublished: row.isPublished,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields an audit row compares (content and state; not the position). */
function auditFields(row: HelpArticle) {
  return {
    key: row.key,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    bodyEn: row.bodyEn,
    bodyAr: row.bodyAr,
    isPublished: row.isPublished,
    isActive: row.isActive,
  };
}

async function nextSortOrder(tx: Tx): Promise<number> {
  const { _max } = await tx.helpArticle.aggregate({
    where: { isActive: true },
    _max: { sortOrder: true },
  });
  return (_max.sortOrder ?? -1) + 1;
}

export interface HelpCenterAdminService {
  list(ctx: AdminContext, query: AdminListQuery): Promise<HelpArticleAdminDto[]>;
  create(ctx: AdminContext, input: CreateHelpArticleInput): Promise<HelpArticleAdminDto>;
  update(
    ctx: AdminContext,
    id: string,
    input: UpdateHelpArticleInput,
  ): Promise<HelpArticleAdminDto>;
  archive(ctx: AdminContext, id: string, input: ArchiveBody): Promise<HelpArticleAdminDto>;
  restore(ctx: AdminContext, id: string, input: ArchiveBody): Promise<HelpArticleAdminDto>;
  reorder(ctx: AdminContext, body: ReorderBody): Promise<void>;
}

export function createHelpCenterAdminService(deps: AdminDeps): HelpCenterAdminService {
  const { prisma, writer } = deps;

  async function setActive(
    ctx: AdminContext,
    id: string,
    input: ArchiveBody,
    isActive: boolean,
  ): Promise<HelpArticleAdminDto> {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
      await lockFresh(tx, 'HelpArticle', id, input.expectedUpdatedAt);
      const before = await tx.helpArticle.findUniqueOrThrow({ where: { id } });
      if (before.isActive === isActive) return toHelpArticleDto(before);
      // A restored article goes to the end of the list (its old place may be taken).
      const sortOrder = isActive ? await nextSortOrder(tx) : before.sortOrder;
      const row = await tx.helpArticle.update({ where: { id }, data: { isActive, sortOrder } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'HelpArticle',
        entityId: id,
        entityLabel: row.titleEn,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive },
      });
      after.scope('help-center');
      return toHelpArticleDto(row);
    });
  }

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const search = query.search?.trim();
      const rows = await prisma.helpArticle.findMany({
        where: {
          ...(query.status === 'all' ? {} : { isActive: query.status === 'active' }),
          ...(search
            ? {
                OR: [
                  { key: { contains: search, mode: 'insensitive' } },
                  { titleEn: { contains: search, mode: 'insensitive' } },
                  { titleAr: { contains: search, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        // Active articles in their order, then archived ones.
        orderBy: [{ isActive: 'desc' }, ...ARTICLE_ORDER],
      });
      return rows.map(toHelpArticleDto);
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'help-center' }, async ({ tx, audit }) => {
        // Serialises key choice (E4: collisions include archived articles).
        await advisoryLock(tx, 'key:HelpArticle');
        let key = input.key;
        if (key) {
          const existing = await tx.helpArticle.findUnique({
            where: { key },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        } else {
          key = await generateKey({
            label: input.titleEn,
            fallbackPrefix: 'article',
            taken: async (candidates) =>
              (
                await tx.helpArticle.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((row) => row.key),
          });
        }
        const row = await tx.helpArticle.create({
          data: {
            key,
            titleEn: input.titleEn,
            titleAr: input.titleAr,
            bodyEn: input.bodyEn,
            bodyAr: input.bodyAr,
            isPublished: input.isPublished,
            sortOrder: await nextSortOrder(tx),
          },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'HelpArticle',
          entityId: row.id,
          entityLabel: row.titleEn,
          after: auditFields(row),
        });
        return toHelpArticleDto(row);
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        await lockFresh(tx, 'HelpArticle', id, input.expectedUpdatedAt);
        const before = await tx.helpArticle.findUniqueOrThrow({ where: { id } });
        const data: Prisma.HelpArticleUpdateInput = {};
        if (input.titleEn !== undefined) data.titleEn = input.titleEn;
        if (input.titleAr !== undefined) data.titleAr = input.titleAr;
        if (input.bodyEn !== undefined) data.bodyEn = input.bodyEn;
        if (input.bodyAr !== undefined) data.bodyAr = input.bodyAr;
        if (input.isPublished !== undefined) data.isPublished = input.isPublished;
        const unchanged = Object.entries(data).every(
          ([field, value]) => before[field as keyof HelpArticle] === value,
        );
        // Nothing differs: keep `updatedAt` (another open editor can still save).
        if (unchanged) return toHelpArticleDto(before);
        const row = await tx.helpArticle.update({ where: { id }, data });
        await audit.record({
          action: 'UPDATE',
          entity: 'HelpArticle',
          entityId: id,
          entityLabel: row.titleEn,
          before: auditFields(before),
          after: auditFields(row),
        });
        after.scope('help-center');
        return toHelpArticleDto(row);
      });
    },

    archive: (ctx, id, input) => setActive(ctx, id, input, false),
    restore: (ctx, id, input) => setActive(ctx, id, input, true),

    async reorder(ctx, body) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        let keys = new Map<string, string>();
        const change = await applyReorder(tx, {
          list: 'HelpArticle',
          body,
          currentIds: async () => {
            const rows = await tx.helpArticle.findMany({
              where: { isActive: true },
              orderBy: ARTICLE_ORDER,
              select: { id: true, key: true },
            });
            keys = new Map(rows.map((row) => [row.id, row.key]));
            return rows.map((row) => row.id);
          },
          write: (ids) => writeSortOrder(tx, 'HelpArticle', ids),
        });
        if (!change) return;
        await audit.record({
          action: 'REORDER',
          entity: 'HelpArticle',
          entityId: 'help-center',
          entityLabel: 'Help center',
          before: { order: change.before.map((id) => keys.get(id) ?? id) },
          after: { order: change.after.map((id) => keys.get(id) ?? id) },
        });
        after.scope('help-center');
      });
    },
  };
}
