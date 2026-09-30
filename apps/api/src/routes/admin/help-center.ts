import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  createHelpArticleSchema,
  helpArticleListQuerySchema,
  helpArticleListSchema,
  helpArticleResponseSchema,
  reorderBodySchema,
  updateHelpArticleSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Help center: /admin/help-center/* (spec §10.10; decision E15). Super admins only (the
// section check in ./index.ts). Contract: packages/shared/src/schemas/admin/help-center.ts.

export const helpCenterAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = () => app.services.admin.helpCenter;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List help-center articles',
          '`status` = active (default) | archived | all. Active articles in their order, then archived ones.',
        ),
        querystring: helpArticleListQuerySchema,
        response: { 200: helpArticleListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await service().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a help-center article',
          'The key is generated from the English title when omitted (E4). New articles are drafts unless `isPublished` is true, and go to the end of the list.',
        ),
        body: createHelpArticleSchema,
        response: { 201: helpArticleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      const item = await service().create(adminContext(req), req.body);
      return reply.code(201).send({ item });
    },
  );

  app.post(
    '/reorder',
    {
      schema: {
        ...adminSchema(
          'Reorder the active articles',
          '`expectedIds` is the order the client started from, `ids` the new order (409 `order_changed` when the list changed meanwhile).',
        ),
        body: reorderBodySchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await service().reorder(adminContext(req), req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Edit a help-center article',
          'Title, body (English and Arabic) and `isPublished` (publish / unpublish). `expectedUpdatedAt` is required (409 `stale`).',
        ),
        params: adminIdParamSchema,
        body: updateHelpArticleSchema,
        response: { 200: helpArticleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await service().update(adminContext(req), req.params.id, req.body),
    }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema('Archive a help-center article'),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: helpArticleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await service().archive(adminContext(req), req.params.id, req.body),
    }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema(
          'Restore an archived help-center article',
          'It goes to the end of the list.',
        ),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: helpArticleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await service().restore(adminContext(req), req.params.id, req.body),
    }),
  );
};
