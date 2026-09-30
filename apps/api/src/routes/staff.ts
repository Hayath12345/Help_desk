import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  macroListSchema,
  requesterListSchema,
  requesterSearchQuerySchema,
  teamListSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Console look-ups (staff only): requester picker, macros, teams with members. */
export const staffRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];

  app.get(
    '/requesters',
    {
      preHandler: auth,
      schema: {
        tags: ['staff'],
        summary: 'Search requesters (active, verified clients) for a ticket raised by staff',
        security,
        querystring: requesterSearchQuerySchema,
        response: { 200: requesterListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => ({
      items: await app.services.directory.searchRequesters(actorOf(req), req.query),
    }),
  );

  app.get(
    '/macros',
    {
      preHandler: auth,
      schema: {
        tags: ['staff'],
        summary: 'Reply macros: global ones plus those of the caller’s teams',
        security,
        response: { 200: macroListSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => ({ items: await app.services.directory.macros(actorOf(req)) }),
  );

  app.get(
    '/teams',
    {
      preHandler: auth,
      schema: {
        tags: ['staff'],
        summary: 'Active teams with their active staff (assignee picker, Teams sidebar)',
        description:
          '`archived=include` also lists archived teams, after the active ones: a ticket on an archived team stays workable (its members are still offered as assignees, Phase 4 E6).',
        security,
        querystring: z.object({ archived: z.enum(['include']).optional() }),
        response: { 200: teamListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => ({
      items: await app.services.directory.teams(actorOf(req), {
        includeArchived: req.query.archived === 'include',
      }),
    }),
  );
};
