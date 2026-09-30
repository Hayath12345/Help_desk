import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  categoryListQuerySchema,
  categoryListSchema,
  categoryResponseSchema,
  categorySubtypeParamSchema,
  createCategorySchema,
  createSubtypeSchema,
  reorderBodySchema,
  setCategoryFieldsSchema,
  subtypeResponseSchema,
  updateCategorySchema,
  updateSubtypeSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Categories & sub-types: /admin/categories/* (super admins; spec §10.1, E4, E5, E16).
// Contract: packages/shared/src/schemas/admin/categories.ts. Every write announces the
// `ticket-form` scope after commit (config:updated).

const guards =
  'Guards (409 `guard`): `security_category`, `security_category_last_subtype`, `category_team_archived`.';

export const categoriesAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const svc = () => app.services.admin.categories;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List categories with their sub-types and linked fields',
          '`hiddenReason` says why a category is not on the New Ticket form (archived, no active sub-type, archived team).',
        ),
        querystring: categoryListQuerySchema,
        response: { 200: categoryListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await svc().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a category with its first sub-type',
          'The key is generated from the English label when omitted (E4). The team must be active.',
        ),
        body: createCategorySchema,
        response: { 201: categoryResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await svc().create(adminContext(req), req.body) }),
  );

  app.post(
    '/reorder',
    {
      schema: {
        ...adminSchema('Reorder the active categories', '409 `order_changed` when the list moved.'),
        body: reorderBodySchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await svc().reorder(adminContext(req), req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Update a category',
          'The key never changes. A new team re-routes new tickets only. 409 `stale` when `expectedUpdatedAt` is not current.',
        ),
        params: adminIdParamSchema,
        body: updateCategorySchema,
        response: { 200: categoryResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema('Archive a category', guards),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: categoryResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema('Restore an archived category', guards),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: categoryResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().restore(adminContext(req), req.params.id, req.body) }),
  );

  app.put(
    '/:id/fields',
    {
      schema: {
        ...adminSchema(
          'Set the custom fields linked to a category, in form order',
          'Newly linked fields must be active. Uses the category’s `updatedAt` (and moves it).',
        ),
        params: adminIdParamSchema,
        body: setCategoryFieldsSchema,
        response: { 200: categoryResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().setFields(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/subtypes',
    {
      schema: {
        ...adminSchema('Add a sub-type to a category'),
        params: adminIdParamSchema,
        body: createSubtypeSchema,
        response: { 201: subtypeResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send({ item: await svc().createSubtype(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/subtypes/reorder',
    {
      schema: {
        ...adminSchema('Reorder the active sub-types of a category'),
        params: adminIdParamSchema,
        body: reorderBodySchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await svc().reorderSubtypes(adminContext(req), req.params.id, req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id/subtypes/:subtypeId',
    {
      schema: {
        ...adminSchema('Update a sub-type'),
        params: categorySubtypeParamSchema,
        body: updateSubtypeSchema,
        response: { 200: subtypeResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await svc().updateSubtype(
        adminContext(req),
        req.params.id,
        req.params.subtypeId,
        req.body,
      ),
    }),
  );

  app.post(
    '/:id/subtypes/:subtypeId/archive',
    {
      schema: {
        ...adminSchema('Archive a sub-type', guards),
        params: categorySubtypeParamSchema,
        body: archiveBodySchema,
        response: { 200: subtypeResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await svc().archiveSubtype(
        adminContext(req),
        req.params.id,
        req.params.subtypeId,
        req.body,
      ),
    }),
  );

  app.post(
    '/:id/subtypes/:subtypeId/restore',
    {
      schema: {
        ...adminSchema('Restore an archived sub-type'),
        params: categorySubtypeParamSchema,
        body: archiveBodySchema,
        response: { 200: subtypeResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await svc().restoreSubtype(
        adminContext(req),
        req.params.id,
        req.params.subtypeId,
        req.body,
      ),
    }),
  );
};
