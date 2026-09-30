import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  TEAM_LEAD_UPDATE_FIELDS,
  addTeamMemberSchema,
  adminIdParamSchema,
  archiveBodySchema,
  createTeamSchema,
  isSuperAdmin,
  reorderBodySchema,
  teamAdminListSchema,
  teamListQuerySchema,
  teamMemberParamSchema,
  teamMemberResponseSchema,
  teamMemberRoleResponseSchema,
  teamResponseSchema,
  updateTeamMemberSchema,
  updateTeamSchema,
} from '@loons/shared';
import { actorOf } from '../../plugins/auth.ts';
import {
  requireMemberChange,
  requireTeamAccess,
  requireTeamSettings,
} from '../../services/admin/authz.ts';
import { adminContext, adminErrorResponses, adminSchema, superAdminOnly } from './common.ts';

// Admin — Teams & members: /admin/teams/* (spec §10.3; E5, E7). Registered by ./index.ts under
// /admin/teams after the auth + section hooks (super admins and team leads reach it); the service
// checks the team being changed (team leads: the teams they lead, MEMBER rows and on-call only).
// Contract: packages/shared/src/schemas/admin/teams.ts.

const E7 =
  'Team leads: only the teams they lead (403 otherwise). Super admins: every team. See the contract in packages/shared/src/schemas/admin/teams.ts.';

const LEAD_FIELDS: ReadonlySet<string> = new Set(TEAM_LEAD_UPDATE_FIELDS);

/** The raw (parsed, not yet validated) request body as a plain object, or null. */
function rawBody(req: FastifyRequest): Record<string, unknown> | null {
  const { body } = req;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** The raw `:id` route parameter (not yet validated). */
const rawTeamId = (req: FastifyRequest) => String((req.params as { id?: unknown }).id ?? '');

/**
 * preValidation of PATCH /:id, which team leads share with super admins (E7): a team lead gets 403
 * before any 400 — for a team they don't lead, or a field other than TEAM_LEAD_UPDATE_FIELDS — so
 * the refusal doesn't depend on the value sent. The service checks again.
 */
async function teamLeadUpdateGuard(req: FastifyRequest): Promise<void> {
  const actor = actorOf(req);
  if (isSuperAdmin(actor)) return;
  requireTeamAccess(actor, rawTeamId(req));
  const body = rawBody(req);
  if (body && Object.keys(body).some((key) => !LEAD_FIELDS.has(key))) requireTeamSettings(actor);
}

/** preValidation of POST /:id/members: team leads add MEMBER rows of their teams only (E7). */
async function teamLeadAddMemberGuard(req: FastifyRequest): Promise<void> {
  const actor = actorOf(req);
  if (isSuperAdmin(actor)) return;
  const role = rawBody(req)?.memberRole === 'LEAD' ? 'LEAD' : 'MEMBER';
  requireMemberChange(actor, rawTeamId(req), role);
}

export const teamsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const teams = () => app.services.admin.teams;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List teams with members',
          `${E7} The Teams webhook URL is never returned: only whether one is set and its host.`,
        ),
        querystring: teamListQuerySchema,
        response: { 200: teamAdminListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await teams().list(actorOf(req), req.query) }),
  );

  app.post(
    '/',
    {
      onRequest: superAdminOnly,
      schema: {
        ...adminSchema(
          'Create a team',
          'Super admins only. The key is generated from the English name when omitted. The webhook URL must be https on a TEAMS_WEBHOOK_HOSTS host (400 `teams_webhook_host`).',
        ),
        body: createTeamSchema,
        response: { 201: teamResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await teams().create(adminContext(req), req.body) }),
  );

  app.post(
    '/reorder',
    {
      onRequest: superAdminOnly,
      schema: {
        ...adminSchema('Reorder the active teams', 'Super admins only. 409 `order_changed`.'),
        body: reorderBodySchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await teams().reorder(adminContext(req), req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id',
    {
      preValidation: teamLeadUpdateGuard,
      schema: {
        ...adminSchema(
          'Update a team',
          `${E7} Team leads may only change onCallUserId (an active staff member of the team with an E.164 phone). \`teamsWebhookUrl\`: omitted = unchanged, null = cleared. 409 \`stale\` when expectedUpdatedAt is not current.`,
        ),
        params: adminIdParamSchema,
        body: updateTeamSchema,
        response: { 200: teamResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await teams().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      onRequest: superAdminOnly,
      schema: {
        ...adminSchema(
          'Archive a team',
          'Super admins only. Refused (409 `guard`) while active categories route to it (`team_has_active_categories`), it has open tickets (`team_has_open_tickets`) or active escalation rules (`team_in_escalation`). Nothing is removed.',
        ),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: teamResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await teams().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      onRequest: superAdminOnly,
      schema: {
        ...adminSchema('Restore an archived team', 'Super admins only.'),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: teamResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await teams().restore(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/members',
    {
      preValidation: teamLeadAddMemberGuard,
      schema: {
        ...adminSchema(
          'Add a member to a team',
          `${E7} An active staff user; team leads may only add MEMBER rows. 409 \`duplicate\` if already a member, \`guard\` \`team_archived\` on an archived team.`,
        ),
        params: adminIdParamSchema,
        body: addTeamMemberSchema,
        response: { 201: teamMemberResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send({ item: await teams().addMember(adminContext(req), req.params.id, req.body) }),
  );

  app.patch(
    '/:id/members/:userId',
    {
      onRequest: superAdminOnly,
      schema: {
        ...adminSchema(
          'Change a member between MEMBER and LEAD',
          'Super admins only. `expectedUpdatedAt` is the team’s: a role change moves it, and 409 `stale` when it is not current.',
        ),
        params: teamMemberParamSchema,
        body: updateTeamMemberSchema,
        response: { 200: teamMemberRoleResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) =>
      teams().updateMember(adminContext(req), req.params.id, req.params.userId, req.body),
  );

  app.delete(
    '/:id/members/:userId',
    {
      schema: {
        ...adminSchema(
          'Remove a member from a team',
          `${E7} Team leads may only remove MEMBER rows. Refused (409 \`guard\` \`member_is_on_call\`) while the member is the team's on-call user. Returns the removed membership.`,
        ),
        params: teamMemberParamSchema,
        response: { 200: teamMemberResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await teams().removeMember(adminContext(req), req.params.id, req.params.userId),
    }),
  );
};
