import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminIdParamSchema,
  archiveBodySchema,
  createEscalationRuleSchema,
  escalationListQuerySchema,
  escalationListSchema,
  escalationRuleResponseSchema,
  reorderEscalationSchema,
  updateEscalationRuleSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Escalation rules: /admin/escalation/* (spec §10.6; D3, E13). Registered by ./index.ts
// under /admin/escalation after the auth + section hooks (super admins only).
// Contract: packages/shared/src/schemas/admin/escalation.ts.

const CHAIN =
  'P1 chains only: `teamId` null is the global chain; a team with active rules of its own uses only those. Announces `config:updated` scope `escalation`. Pending steps of open P1 tickets follow the new timing (a step that fires early waits again; an overdue one fires on the next SLA scan).';

export const escalationAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const rules = () => app.services.admin.escalation;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List escalation rules',
          'Global chain first, then teams by name; steps in order. `teamId` = a team id or `global`. Each rule carries `warnings` (TEAMS without a webhook, ON_CALL without an on-call user or a phone, an inactive USER target…).',
        ),
        querystring: escalationListQuerySchema,
        response: { 200: escalationListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await rules().list(adminContext(req), req.query) }),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Add an escalation step',
          `${CHAIN} 409 \`duplicate\` with \`existingId\` when the step number is taken (archived rules included: restore it, or add the step at the end).`,
        ),
        body: createEscalationRuleSchema,
        response: { 201: escalationRuleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await rules().create(adminContext(req), req.body) }),
  );

  app.post(
    '/reorder',
    {
      schema: {
        ...adminSchema(
          "Reorder a chain's steps",
          `Renumbers the chain's active rules 1…n in \`ids\` order (archived ones move after them). 409 \`order_changed\` when the active rules are not \`expectedIds\` any more. ${CHAIN}`,
        ),
        body: reorderEscalationSchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await rules().reorder(adminContext(req), req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Change an escalation step',
          `Target, delay and channels, with \`expectedUpdatedAt\` (409 \`stale\`). ${CHAIN}`,
        ),
        params: adminIdParamSchema,
        body: updateEscalationRuleSchema,
        response: { 200: escalationRuleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await rules().update(adminContext(req), req.params.id, req.body) }),
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/:id/${action}`,
      {
        schema: {
          ...adminSchema(
            action === 'archive' ? 'Archive an escalation step' : 'Restore an escalation step',
            `With \`expectedUpdatedAt\` (409 \`stale\`). ${CHAIN}`,
          ),
          params: adminIdParamSchema,
          body: archiveBodySchema,
          response: { 200: escalationRuleResponseSchema, ...adminErrorResponses },
        },
      },
      async (req) => ({
        item: await rules().setActive(
          adminContext(req),
          req.params.id,
          action === 'restore',
          req.body.expectedUpdatedAt,
        ),
      }),
    );
  }
};
