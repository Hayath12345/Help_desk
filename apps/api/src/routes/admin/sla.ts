import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  slaPolicyListSchema,
  slaPolicyResponseSchema,
  slaPriorityParamSchema,
  updateSlaPolicySchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — SLA policies: /admin/sla/* (spec §10.4; E12). Registered by ./index.ts under /admin/sla
// after the auth + section hooks (super admins only). Contract:
// packages/shared/src/schemas/admin/sla.ts.

const APPLIES =
  'Changes apply to new tickets and later priority changes; the stored due dates of open tickets are not recomputed.';

export const slaAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const sla = () => app.services.admin.sla;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List the SLA policies',
          'The four policies (P1…P4) and `businessDayMinutes`, the configured business-day length used for "N business days" labels.',
        ),
        response: { 200: slaPolicyListSchema, ...adminErrorResponses },
      },
    },
    async (req) => sla().list(adminContext(req)),
  );

  app.patch(
    '/:priority',
    {
      schema: {
        ...adminSchema(
          "Change a priority's SLA targets",
          `Replaces the targets (minutes ≥ 1, atRiskPercent 1–99) with \`expectedUpdatedAt\` (409 \`stale\`). ${APPLIES} Announces \`config:updated\` scope \`ticket-form\`.`,
        ),
        params: slaPriorityParamSchema,
        body: updateSlaPolicySchema,
        response: { 200: slaPolicyResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await sla().update(adminContext(req), req.params.priority, req.body),
    }),
  );
};
