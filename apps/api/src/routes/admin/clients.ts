import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  adminIdParamSchema,
  approveSignupSchema,
  archiveBodySchema,
  createOrganizationSchema,
  createSiteSchema,
  organizationListQuerySchema,
  organizationListSchema,
  organizationResponseSchema,
  organizationSiteParamSchema,
  pendingSignupListQuerySchema,
  pendingSignupListSchema,
  pendingSignupResponseSchema,
  rejectSignupSchema,
  reorderBodySchema,
  siteResponseSchema,
  updateOrganizationSchema,
  updateSiteSchema,
} from '@loons/shared';
import { actorOf } from '../../plugins/auth.ts';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Clients & sites, pending sign-ups: /admin/clients/* (spec §10.7; E10; super admins
// only — the section hook of ./index.ts refuses team leads). Contract:
// packages/shared/src/schemas/admin/clients.ts.

export const clientsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const clients = () => app.services.admin.clients;

  // ───────────── Organisations ─────────────

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List client organisations with their sites',
          '`status`: active | archived | all. Search matches the names, the key or an exact email domain. Sorted by name, cursor-paged.',
        ),
        querystring: organizationListQuerySchema,
        response: { 200: organizationListSchema, ...adminErrorResponses },
      },
    },
    async (req) => clients().list(actorOf(req), req.query),
  );

  app.post(
    '/',
    {
      schema: {
        ...adminSchema(
          'Create a client organisation',
          'Email domains: lower-case hostnames, unique across every organisation (409 `duplicate` on `emailDomains`), never the staff domain (400 `validation.staffEmailDomain`) or a public mail domain. The account manager must be active staff; the phone is stored in E.164.',
        ),
        body: createOrganizationSchema,
        response: { 201: organizationResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply.code(201).send({ item: await clients().create(adminContext(req), req.body) }),
  );

  // ───────────── Pending sign-ups ─────────────

  app.get(
    '/pending-signups',
    {
      schema: {
        ...adminSchema(
          'List pending client sign-ups',
          'Clients whose address matched no organisation (PENDING_APPROVAL), oldest first. `status=rejected` lists rejected sign-ups instead (DISABLED, no organisation), which can still be approved.',
        ),
        querystring: pendingSignupListQuerySchema,
        response: { 200: pendingSignupListSchema, ...adminErrorResponses },
      },
    },
    async (req) => clients().pendingSignups(actorOf(req), req.query),
  );

  app.post(
    '/pending-signups/:id/approve',
    {
      schema: {
        ...adminSchema(
          'Approve a sign-up into an organisation',
          'The client joins the active organisation and becomes ACTIVE. A rejected sign-up can be approved too (the way back). 409 `guard` `signup_not_pending` when it was already approved.',
        ),
        params: adminIdParamSchema,
        body: approveSignupSchema,
        response: { 200: pendingSignupResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await clients().approveSignup(adminContext(req), req.params.id, req.body),
    }),
  );

  app.post(
    '/pending-signups/:id/reject',
    {
      schema: {
        ...adminSchema(
          'Reject a sign-up',
          'The account is disabled and its sessions revoked (the address can’t register again). It stays listed under `status=rejected`, where it can still be approved.',
        ),
        params: adminIdParamSchema,
        body: rejectSignupSchema,
        response: { 200: pendingSignupResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await clients().rejectSignup(adminContext(req), req.params.id, req.body),
    }),
  );

  // ───────────── One organisation ─────────────

  app.patch(
    '/:id',
    {
      schema: {
        ...adminSchema(
          'Update a client organisation',
          '409 `stale` when expectedUpdatedAt is not current. Same email-domain rules as create.',
        ),
        params: adminIdParamSchema,
        body: updateOrganizationSchema,
        response: { 200: organizationResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await clients().update(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/archive',
    {
      schema: {
        ...adminSchema(
          'Archive a client organisation',
          'Its clients keep read access but can’t raise tickets, reply or upload; sign-ups stop matching its domains. Nothing is removed.',
        ),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: organizationResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await clients().archive(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/restore',
    {
      schema: {
        ...adminSchema('Restore an archived client organisation'),
        params: adminIdParamSchema,
        body: archiveBodySchema,
        response: { 200: organizationResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await clients().restore(adminContext(req), req.params.id, req.body) }),
  );

  // ───────────── Sites ─────────────

  app.post(
    '/:id/sites',
    {
      schema: {
        ...adminSchema(
          'Add a site to an organisation',
          'The key is generated from the name when omitted (unique per organisation).',
        ),
        params: adminIdParamSchema,
        body: createSiteSchema,
        response: { 201: siteResponseSchema, ...adminErrorResponses },
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send({ item: await clients().createSite(adminContext(req), req.params.id, req.body) }),
  );

  app.post(
    '/:id/sites/reorder',
    {
      schema: {
        ...adminSchema('Reorder the organisation’s active sites', '409 `order_changed`.'),
        params: adminIdParamSchema,
        body: reorderBodySchema,
        response: { 204: z.undefined(), ...adminErrorResponses },
      },
    },
    async (req, reply) => {
      await clients().reorderSites(adminContext(req), req.params.id, req.body);
      return reply.code(204).send();
    },
  );

  app.patch(
    '/:id/sites/:siteId',
    {
      schema: {
        ...adminSchema('Update a site', '409 `stale` when expectedUpdatedAt is not current.'),
        params: organizationSiteParamSchema,
        body: updateSiteSchema,
        response: { 200: siteResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await clients().updateSite(
        adminContext(req),
        req.params.id,
        req.params.siteId,
        req.body,
      ),
    }),
  );

  app.post(
    '/:id/sites/:siteId/archive',
    {
      schema: {
        ...adminSchema(
          'Archive a site',
          'It leaves the New ticket form; old tickets keep showing it (marked archived).',
        ),
        params: organizationSiteParamSchema,
        body: archiveBodySchema,
        response: { 200: siteResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await clients().archiveSite(
        adminContext(req),
        req.params.id,
        req.params.siteId,
        req.body,
      ),
    }),
  );

  app.post(
    '/:id/sites/:siteId/restore',
    {
      schema: {
        ...adminSchema('Restore an archived site'),
        params: organizationSiteParamSchema,
        body: archiveBodySchema,
        response: { 200: siteResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await clients().restoreSite(
        adminContext(req),
        req.params.id,
        req.params.siteId,
        req.body,
      ),
    }),
  );
};
