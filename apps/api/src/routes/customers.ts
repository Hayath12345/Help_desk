import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  customerListSchema,
  customerOrgResponseSchema,
  customersQuerySchema,
  idParamSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Phase 5 Customers (staff only): requesters with their ticket counts, organisation look-up. */
export const customerRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];

  app.get(
    '/customers',
    {
      preHandler: auth,
      schema: {
        tags: ['customers'],
        summary: 'Client requesters with their organisation and ticket counts (staff)',
        description:
          'Every active client requester (the requester search’s people), sorted by name and keyset-paged; `search` matches the name, email or organisation. `open` / `total` count only the tickets the caller can see; `totals` covers the whole search. Clients get 403.',
        security,
        querystring: customersQuerySchema,
        response: { 200: customerListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.customers.list(actorOf(req), req.query),
  );

  app.get(
    '/customers/orgs/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['customers'],
        summary: 'A client organisation’s name and contract (staff; the Inbox company view)',
        security,
        params: idParamSchema,
        response: { 200: customerOrgResponseSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (req) => ({ org: await app.services.customers.org(actorOf(req), req.params.id) }),
  );
};
