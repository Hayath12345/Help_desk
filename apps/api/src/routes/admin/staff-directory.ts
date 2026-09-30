import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { staffDirectoryQuerySchema, staffDirectorySchema } from '@loons/shared';
import { actorOf } from '../../plugins/auth.ts';
import { adminErrorResponses, adminSchema } from './common.ts';

/** GET /admin/staff-directory — active staff for the admin pickers (super admins, team leads). */
export const staffDirectoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/staff-directory',
    {
      schema: {
        ...adminSchema(
          'Active staff for pickers',
          'Team members, on-call user, escalation target, account manager. Phones are never returned: only whether one is set (`hasPhone`) and usable for SMS (`phoneValid`).',
        ),
        querystring: staffDirectoryQuerySchema,
        response: { 200: staffDirectorySchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      items: await app.services.admin.staffDirectory.list(actorOf(req), req.query),
    }),
  );
};
