import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  adminIdParamSchema,
  createStaffSchema,
  staffListQuerySchema,
  staffListSchema,
  staffResponseSchema,
  updateStaffSchema,
} from '@loons/shared';
import { actorOf } from '../../plugins/auth.ts';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Staff: /admin/staff/* (decision E9; super admins only — the section hook of ./index.ts
// refuses team leads). Contract: packages/shared/src/schemas/admin/staff.ts. The pickers' staff
// list is GET /admin/staff-directory (./staff-directory.ts).

export const staffAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const staff = () => app.services.admin.staff;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List staff accounts',
          '`status`: active = ACTIVE, archived = DISABLED, all. Sorted by name, cursor-paged.',
        ),
        querystring: staffListQuerySchema,
        response: { 200: staffListSchema, ...adminErrorResponses },
      },
    },
    async (req) => staff().list(actorOf(req), req.query),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a staff account',
          'The address must be on STAFF_EMAIL_DOMAIN (400 `validation.staffDomain`); 409 EMAIL_TAKEN when an account has it. No password: the first Microsoft sign-in links to the account. Phones are stored in E.164 (400 `validation.phone`).',
        ),
        body: createStaffSchema,
        response: { 201: staffResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await staff().create(adminContext(req), req.body) }),
  );

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Update a staff account',
          'A role or status change revokes the user’s sessions and closes their sockets. 409 `guard`: `self_role`, `self_disable`, `last_super_admin`; 409 `stale` when expectedUpdatedAt is not current.',
        ),
        params: adminIdParamSchema,
        body: updateStaffSchema,
        response: { 200: staffResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await staff().update(adminContext(req), req.params.id, req.body) }),
  );
};
