import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  createSkillSchema,
  skillAdminListSchema,
  skillListQuerySchema,
  skillResponseSchema,
  updateSkillSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Skills: /admin/skills/* (super admins only; the section check of ./index.ts refuses team
// leads). Contract: packages/shared/src/schemas/admin/skills.ts. Which staff have a skill and which
// category needs it are set from the Staff and Categories sections.

export const skillsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const svc = () => app.services.admin.skills;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List skills',
          'By English label, with how many active staff have the skill and how many active categories need it.',
        ),
        querystring: skillListQuerySchema,
        response: { 200: skillAdminListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await svc().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a skill',
          'The key is generated from the English label when omitted and never changes. 409 `duplicate` when the key or the English label is taken (archived skills included: `existingId` says which to restore).',
        ),
        body: createSkillSchema,
        response: { 201: skillResponseSchema, ...adminErrorResponses },
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
          'Update a skill',
          'Labels only. 409 `stale` when `expectedUpdatedAt` is not current.',
        ),
        params: adminIdParamSchema,
        body: updateSkillSchema,
        response: { 200: skillResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema(
          'Archive a skill',
          'The links to staff and categories stay but stop counting for automatic assignment.',
        ),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: skillResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema('Restore an archived skill'),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: skillResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().restore(adminContext(req), req.params.id, req.body) }),
  );
};
