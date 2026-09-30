import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  createCustomFieldSchema,
  customFieldListQuerySchema,
  customFieldListSchema,
  customFieldResponseSchema,
  updateCustomFieldSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Custom fields: /admin/custom-fields/* (super admins; spec §10.2, E4, E6).
// Contract: packages/shared/src/schemas/admin/custom-fields.ts. Every write announces the
// `ticket-form` scope after commit (config:updated).

export const customFieldsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const svc = () => app.services.admin.customFields;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List custom fields with their options and linked categories',
          'Options include archived ones (`isActive: false`).',
        ),
        querystring: customFieldListQuerySchema,
        response: { 200: customFieldListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await svc().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a custom field',
          'The key (`_` separated) is generated from the English label when omitted (E4); `categoryIds` links it last in each category.',
        ),
        body: createCustomFieldSchema,
        response: { 201: customFieldResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await svc().create(adminContext(req), req.body) }),
  );

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Update a custom field',
          'The key never changes. 409 `guard`: `field_type_in_use` (the type changes only while no ticket holds a value), `option_in_use` (archive an option a ticket holds instead of removing it). 409 `stale` when `expectedUpdatedAt` is not current.',
        ),
        params: adminIdParamSchema,
        body: updateCustomFieldSchema,
        response: { 200: customFieldResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema(
          'Archive a custom field',
          'It leaves the New Ticket form; old tickets keep showing its values (E6).',
        ),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: customFieldResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema('Restore an archived custom field'),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: customFieldResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().restore(adminContext(req), req.params.id, req.body) }),
  );
};
