import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TEAM_MEMBER_ROLES, authUserSchema, updateLocaleSchema } from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

export const meResponseSchema = z.object({
  user: authUserSchema,
  org: z.object({ id: z.string(), name: z.string() }).nullable(),
  teams: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      nameEn: z.string(),
      nameAr: z.string(),
      role: z.enum(TEAM_MEMBER_ROLES),
    }),
  ),
});

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  // Pending-approval users may read their profile and change their language, nothing else.
  const auth = requireAuth({ allowPending: true });

  app.get(
    '/me',
    {
      preHandler: auth,
      schema: {
        tags: ['me'],
        summary: 'The signed-in user, their organisation and teams',
        security: [{ bearerAuth: [] }],
        response: { 200: meResponseSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => app.services.me.get(actorOf(req).id),
  );

  app.patch(
    '/me',
    {
      preHandler: auth,
      schema: {
        tags: ['me'],
        summary: 'Update the signed-in user’s language',
        security: [{ bearerAuth: [] }],
        body: updateLocaleSchema,
        response: { 204: z.undefined(), ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req, reply) => {
      await app.services.me.updateLocale(actorOf(req).id, req.body.locale);
      return reply.code(204).send();
    },
  );
};
