import type { PrismaClient } from '@loons/db';
import {
  helpArticleLanguage,
  type Actor,
  type HelpArticlesQuery,
  type PublishedHelpArticleList,
} from '@loons/shared';
import { ARTICLE_ORDER } from './admin/help-center.ts';

// Phase 5 portal Help center (decision F13): the published, active help articles for any signed-in
// user, in the admin's order, each in the language the shared rule picks for the reader
// (`helpArticleLanguage`: Arabic only when both the Arabic title and text exist). Drafts and
// archived articles are never returned. Plain text, as stored.

export interface HelpService {
  articles(actor: Actor, query: HelpArticlesQuery): Promise<PublishedHelpArticleList>;
}

export function createHelpService(deps: { prisma: PrismaClient }): HelpService {
  const { prisma } = deps;
  return {
    async articles(_actor, { locale }) {
      const rows = await prisma.helpArticle.findMany({
        where: { isActive: true, isPublished: true },
        orderBy: [...ARTICLE_ORDER],
        select: {
          id: true,
          key: true,
          titleEn: true,
          titleAr: true,
          bodyEn: true,
          bodyAr: true,
          updatedAt: true,
        },
      });
      return {
        locale,
        items: rows.map((row) => {
          const language = helpArticleLanguage(locale, row);
          return {
            id: row.id,
            key: row.key,
            language,
            title: language === 'ar' ? row.titleAr : row.titleEn,
            body: language === 'ar' ? row.bodyAr : row.bodyEn,
            updatedAt: row.updatedAt.toISOString(),
          };
        }),
      };
    },
  };
}
