import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { helpArticlesQuerySchema, publishedHelpArticleListSchema } from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Phase 5 portal Help center: published articles for any signed-in user. */
export const helpRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];

  app.get(
    '/help/articles',
    {
      preHandler: auth,
      schema: {
        tags: ['help'],
        summary: 'Published help articles in the reader’s language (English fallback)',
        description:
          'Published, active articles in the admin’s order. Each comes in Arabic only when `locale=ar` and both its Arabic title and text exist, otherwise in English; `language` says which (set `lang` / `dir` from it). Plain text. Drafts and archived articles are never returned.',
        security,
        querystring: helpArticlesQuerySchema,
        response: { 200: publishedHelpArticleListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.help.articles(actorOf(req), req.query),
  );
};
