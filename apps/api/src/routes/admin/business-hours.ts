import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  businessHoursDtoSchema,
  createHolidaySchema,
  holidayListQuerySchema,
  holidayListSchema,
  holidayResponseSchema,
  updateBusinessHoursSchema,
  updateHolidaySchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Business hours & holidays: /admin/business-hours/* (spec §10.5; E12). Registered by
// ./index.ts under /admin/business-hours after the auth + section hooks (super admins only).
// Contract: packages/shared/src/schemas/admin/business-hours.ts.

const APPLIES =
  'Announces `config:updated` scope `calendar`. Changes apply to new tickets and later priority changes; stored due dates of open tickets are not recomputed.';

export const businessHoursAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const hours = () => app.services.admin.businessHours;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'The working week',
          'Seven days (Sunday first), the business time zone (a General setting) and the configured business-day length.',
        ),
        response: { 200: businessHoursDtoSchema, ...adminErrorResponses },
      },
    },
    async (req) => hours().get(adminContext(req)),
  );

  app.put(
    '/',
    {
      schema: {
        ...adminSchema(
          'Replace the working week',
          `All seven days, each with the \`expectedUpdatedAt\` it started from (409 \`stale\`). Open days need open < close; at least one day must be open. ${APPLIES}`,
        ),
        body: updateBusinessHoursSchema,
        response: { 200: businessHoursDtoSchema, ...adminErrorResponses },
      },
    },
    async (req) => hours().update(adminContext(req), req.body),
  );

  app.get(
    '/holidays',
    {
      schema: {
        ...adminSchema('List holidays', 'Ordered by date. `status` = active | archived | all.'),
        querystring: holidayListQuerySchema,
        response: { 200: holidayListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await hours().listHolidays(adminContext(req), req.query) }),
  );

  app.post(
    '/holidays',
    {
      schema: {
        ...adminSchema(
          'Add a holiday',
          `409 \`duplicate\` with \`existingId\` / \`existingIsActive\` when the date already has a holiday (archived ones included: restore it instead). ${APPLIES}`,
        ),
        body: createHolidaySchema,
        response: { 201: holidayResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await hours().createHoliday(adminContext(req), req.body) }),
  );

  app.patch(
    '/holidays/:id',
    {
      schema: {
        ...adminSchema(
          'Rename a holiday',
          `The date never changes (archive it and add the new date). ${APPLIES}`,
        ),
        params: adminIdParamSchema,
        body: updateHolidaySchema,
        response: { 200: holidayResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await hours().updateHoliday(adminContext(req), req.params.id, req.body),
    }),
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/holidays/:id/${action}`,
      {
        schema: {
          ...adminSchema(
            action === 'archive' ? 'Archive a holiday' : 'Restore a holiday',
            `With \`expectedUpdatedAt\` (409 \`stale\`). ${APPLIES}`,
          ),
          params: adminIdParamSchema,
          body: archiveBodySchema,
          response: { 200: holidayResponseSchema, ...adminErrorResponses },
        },
      },
      async (req) => ({
        item: await hours().setHolidayActive(
          adminContext(req),
          req.params.id,
          action === 'restore',
          req.body.expectedUpdatedAt,
        ),
      }),
    );
  }
};
