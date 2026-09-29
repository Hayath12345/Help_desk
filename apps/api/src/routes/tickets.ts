import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createMessageResponseSchema,
  createMessageSchema,
  createTicketSchema,
  formContextQuerySchema,
  formContextSchema,
  idParamSchema,
  listMessagesQuerySchema,
  listTicketsQuerySchema,
  messageListSchema,
  ticketCountsSchema,
  ticketListSchema,
  ticketRefParamSchema,
  ticketResponseSchema,
  updateTicketSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { MINUTE, limitGuard, type LimitRule } from '../lib/rate-limit.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Per-user caps (spec §12: rate limiting on ticket creation). */
export const TICKET_RATE_LIMITS = {
  create: { max: 30, windowMs: 10 * MINUTE },
  message: { max: 120, windowMs: MINUTE },
} as const;

const perUser: LimitRule['key'] = (req) => (req.actor ? `user:${req.actor.id}` : null);

/**
 * Tickets and their conversation. Every route is Bearer-authenticated; unknown tickets and tickets
 * the caller can't see are 404 (existence is never revealed). Realtime events follow each commit.
 */
export const ticketRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];
  // Fail open: a Redis outage must not stop support work (the global limit also fails open).
  const createLimit = limitGuard(
    app,
    [{ name: 'tickets:create:user', ...TICKET_RATE_LIMITS.create, key: perUser }],
    { onStoreError: 'allow' },
  );
  const messageLimit = limitGuard(
    app,
    [{ name: 'tickets:message:user', ...TICKET_RATE_LIMITS.message, key: perUser }],
    { onStoreError: 'allow' },
  );

  app.get(
    '/tickets/form-context',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Who a new ticket is for: requester, organisation and its active sites',
        description:
          'Clients omit `requesterId` (always themselves). Staff must pass the client they raise the ticket for.',
        security,
        querystring: formContextQuerySchema,
        response: { 200: formContextSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (req) => app.services.directory.formContext(actorOf(req), req.query.requesterId),
  );

  app.post(
    '/tickets',
    {
      preHandler: [auth, createLimit],
      schema: {
        tags: ['tickets'],
        summary: 'Create a ticket (validated against the live configuration)',
        description:
          'Clients raise tickets for themselves (status NEW, channel PORTAL). Staff must pass `requesterId` (status OPEN, channel PHONE, assigned to the caller when they are on the routed team). Business-rule failures are 400 VALIDATION_FAILED with per-field `details`.',
        security,
        body: createTicketSchema,
        response: {
          201: ticketResponseSchema,
          ...errorResponses(400, 401, 403, 429),
        },
      },
    },
    async (req, reply) => {
      const ticket = await app.services.tickets.create(actorOf(req), req.body);
      return reply.code(201).send({ ticket });
    },
  );

  app.get(
    '/tickets',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'List tickets the caller can see (cursor pagination)',
        description:
          'Clients: `tab` over the tickets they requested (`scope=mine`, default) or their organisation (`scope=org`), sorted by `recent` by default. Staff: `view` and/or `teamId`, sorted by `sla` by default.',
        security,
        querystring: listTicketsQuerySchema,
        response: { 200: ticketListSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.tickets.list(actorOf(req), req.query),
  );

  app.get(
    '/tickets/counts',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Console view / team counts (staff) or My tickets tab counts (clients)',
        security,
        response: { 200: ticketCountsSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => app.services.tickets.counts(actorOf(req)),
  );

  app.get(
    '/tickets/:ref',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'A ticket by id or number ("LG-4817" / "4817")',
        security,
        params: ticketRefParamSchema,
        response: { 200: ticketResponseSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (req) => ({ ticket: await app.services.tickets.get(actorOf(req), req.params.ref) }),
  );

  app.patch(
    '/tickets/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Update a ticket (staff: any field; clients: mark solved / reopen)',
        description:
          'Writes one TicketEvent per changed field. A request that changes nothing returns the ticket unchanged. Invalid status transitions and closed tickets are 409 CONFLICT.',
        security,
        params: idParamSchema,
        body: updateTicketSchema,
        response: { 200: ticketResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 429) },
      },
    },
    async (req) => ({
      ticket: await app.services.tickets.update(actorOf(req), req.params.id, req.body),
    }),
  );

  app.get(
    '/tickets/:id/messages',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'The conversation, oldest first (clients never receive internal notes)',
        description: '`after` = a message id: only newer messages (catch-up after a reconnect).',
        security,
        params: idParamSchema,
        querystring: listMessagesQuerySchema,
        response: { 200: messageListSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (req) => ({
      items: await app.services.messages.list(actorOf(req), req.params.id, req.query),
    }),
  );

  app.post(
    '/tickets/:id/messages',
    {
      preHandler: [auth, messageLimit],
      schema: {
        tags: ['tickets'],
        summary: 'Post a public reply or an internal note (idempotent on clientTempId)',
        description:
          '201 with the new message; 200 with the stored one when the same `clientTempId` was already posted by the caller. Closed tickets are 409 CONFLICT; clients may only post PUBLIC.',
        security,
        params: idParamSchema,
        body: createMessageSchema,
        response: {
          200: createMessageResponseSchema,
          201: createMessageResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (req, reply) => {
      const { created, message, ticket } = await app.services.messages.post(
        actorOf(req),
        req.params.id,
        req.body,
      );
      return reply.code(created ? 201 : 200).send({ message, ticket });
    },
  );
};
