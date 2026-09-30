import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auditLogActorListSchema, auditLogListSchema, auditLogQuerySchema } from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Audit log: GET /admin/audit-log and GET /admin/audit-log/actors (spec §10.11; decision
// E17). Super admins only (the section check in ./index.ts). Read-only: the log has no write
// routes at all.
// Contract: packages/shared/src/schemas/admin/audit-log.ts.

export const auditLogAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'Read the admin audit log',
          'Newest first. Filters: `entity`, `entityId`, `actorId`, `action`, `from` (inclusive) and `to` (exclusive). Pass `nextCursor` back as `cursor` for the next page. `before` / `after` hold the changed fields only, redacted (webhook URLs → host, phone numbers masked, secrets never stored).',
        ),
        querystring: auditLogQuerySchema,
        response: { 200: auditLogListSchema, ...adminErrorResponses },
      },
    },
    async (req) => app.services.admin.auditLog.list(adminContext(req), req.query),
  );

  app.get(
    '/actors',
    {
      schema: {
        ...adminSchema(
          'List the people in the admin audit log',
          'Everyone with at least one entry, by name, with their current role and status — disabled and demoted admins included, so their changes can still be filtered (`actorId`).',
        ),
        response: { 200: auditLogActorListSchema, ...adminErrorResponses },
      },
    },
    async (req) => app.services.admin.auditLog.actors(adminContext(req)),
  );
};
