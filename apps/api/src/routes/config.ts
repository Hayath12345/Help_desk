import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ticketFormConfigSchema } from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { requireAuth } from '../plugins/auth.ts';

/** Live configuration for forms (Phase 4 admin edits invalidate it and emit config:updated). */
export const configRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/config/ticket-form',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['config'],
        summary:
          'New-ticket form configuration: categories, sub-types, custom fields, SLA policies',
        security: [{ bearerAuth: [] }],
        response: { 200: ticketFormConfigSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async () => app.services.ticketConfig.getFormConfig(),
  );
};
