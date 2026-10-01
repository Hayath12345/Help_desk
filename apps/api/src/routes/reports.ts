import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { reportsSummaryQuerySchema, reportsSummarySchema } from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Phase 5 Reports (staff only; scoped like the Inbox). */
export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];

  app.get(
    '/reports/summary',
    {
      preHandler: auth,
      schema: {
        tags: ['reports'],
        summary: 'Report tiles and open tickets by category, for the tickets the caller can see',
        description:
          'Snapshot tiles (open, P1 open, SLA breached, unassigned) and period tiles (solved, average first reply on the SLA clock) over the last `period` days in `business.timezone` (default 30d), plus open tickets per category. Clients get 403.',
        security,
        querystring: reportsSummaryQuerySchema,
        response: { 200: reportsSummarySchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.reports.summary(actorOf(req), req.query),
  );
};
