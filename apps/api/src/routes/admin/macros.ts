import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  createMacroSchema,
  macroAdminListSchema,
  macroListQuerySchema,
  macroResponseSchema,
  reorderMacrosSchema,
  updateMacroSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Macros: /admin/macros/* (super admins; team leads for the teams they lead, E7).
// Contract: packages/shared/src/schemas/admin/macros.ts. Every write announces the `macros` scope
// after commit (config:updated), which refreshes the console's macro list.

const scopeRule =
  'Team leads: macros of the teams they lead only (never global ones; never moved to another team or to global) — 403 otherwise.';

export const macrosAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const svc = () => app.services.admin.macros;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema('List macros', `Global macros first, then by team. ${scopeRule}`),
        querystring: macroListQuerySchema,
        response: { 200: macroAdminListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await svc().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a macro',
          `\`teamId: null\` = global (super admins only). Bodies may use {{requesterFirstName}} and {{siteName}} only. ${scopeRule}`,
        ),
        body: createMacroSchema,
        response: { 201: macroResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await svc().create(adminContext(req), req.body) }),
  );

  app.post(
    '/reorder',
    {
      schema: {
        ...adminSchema(
          'Reorder the active macros of one scope (a team, or the global ones)',
          `409 \`order_changed\` when the list moved. ${scopeRule}`,
        ),
        body: reorderMacrosSchema,
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
          'Update a macro',
          `The key never changes. 409 \`stale\` when \`expectedUpdatedAt\` is not current. ${scopeRule}`,
        ),
        params: adminIdParamSchema,
        body: updateMacroSchema,
        response: { 200: macroResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema('Archive a macro', scopeRule),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: macroResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema('Restore an archived macro', scopeRule),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: macroResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await svc().restore(adminContext(req), req.params.id, req.body) }),
  );
};
