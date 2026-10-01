import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  acknowledgeTicketResponseSchema,
  bulkTicketResultSchema,
  bulkTicketsSchema,
  createMessageResponseSchema,
  createMessageSchema,
  createTicketSchema,
  formContextQuerySchema,
  formContextSchema,
  idParamSchema,
  listMessagesQuerySchema,
  listTicketsQuerySchema,
  messageListSchema,
  queueCountsQuerySchema,
  queueCountsSchema,
  queueFilterOptionsSchema,
  ticketCountsSchema,
  ticketEventListSchema,
  ticketEventsQuerySchema,
  ticketListSchema,
  ticketRefParamSchema,
  ticketResponseSchema,
  updateTicketSchema,
  workloadSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { MINUTE, limitGuard, type LimitRule } from '../lib/rate-limit.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Per-user caps (spec §12: rate limiting on ticket creation). */
export const TICKET_RATE_LIMITS = {
  create: { max: 30, windowMs: 10 * MINUTE },
  message: { max: 120, windowMs: MINUTE },
  acknowledge: { max: 60, windowMs: MINUTE },
  /** Team queue bulk actions (F6): up to 50 tickets each, so at most 500 ticket updates a minute. */
  bulk: { max: 10, windowMs: MINUTE },
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
  const acknowledgeLimit = limitGuard(
    app,
    [{ name: 'tickets:ack:user', ...TICKET_RATE_LIMITS.acknowledge, key: perUser }],
    { onStoreError: 'allow' },
  );
  const messageLimit = limitGuard(
    app,
    [{ name: 'tickets:message:user', ...TICKET_RATE_LIMITS.message, key: perUser }],
    { onStoreError: 'allow' },
  );
  const bulkLimit = limitGuard(
    app,
    [{ name: 'tickets:bulk:user', ...TICKET_RATE_LIMITS.bulk, key: perUser }],
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
          'Clients: `tab` over the tickets they requested (`scope=mine`, default) or their organisation (`scope=org`), sorted by `recent` by default. Staff: `view`, `teamId`, `priority`, `categoryId`, `assigneeId` (`none` = unassigned), `orgId` and `requesterId`, each ANDed within what the caller can see; sorted by `sla` by default (`priority`: P1 → P4, then the next due date; `recent`: last updated first).',
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

  // ───────────── Team queue (Phase 5 F3–F6; staff only) ─────────────

  app.get(
    '/tickets/queue-counts',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Team queue tab counts for the list filters and search (staff)',
        description:
          'Tabs: `open` (NEW, OPEN, PENDING), `unassigned`, `breaching` (the Inbox "SLA at risk" rule) and `solved` (SOLVED, CLOSED). Each count equals the length of `GET /tickets` with the same filters and the tab’s view (`QUEUE_TAB_VIEWS`), within what the caller can see. Clients get 403.',
        security,
        querystring: queueCountsQuerySchema,
        response: { 200: queueCountsSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.queue.counts(actorOf(req), req.query),
  );

  app.get(
    '/tickets/workload',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Team queue agent cards: open and at-risk tickets per staff member (staff)',
        description:
          'One entry per active staff member of the active teams the caller belongs to (super admins: every active team), with their open assigned tickets the caller can see and how many are breaching soon; most loaded first, then by name. `capacity` is AGENT_QUEUE_CAPACITY. Clients get 403.',
        security,
        response: { 200: workloadSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => app.services.queue.workload(actorOf(req)),
  );

  app.get(
    '/tickets/filter-options',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'Team queue Category filter: active categories, then archived ones in use (staff)',
        description:
          'Every active category in admin order, then archived categories that still have a ticket the caller can see (`isActive: false`). Clients get 403.',
        security,
        response: { 200: queueFilterOptionsSchema, ...errorResponses(401, 403, 429) },
      },
    },
    async (req) => app.services.queue.filterOptions(actorOf(req)),
  );

  app.post(
    '/tickets/bulk',
    {
      preHandler: [auth, bulkLimit],
      schema: {
        tags: ['tickets'],
        summary: 'Bulk "Assign to me" or "Mark solved" on up to 50 tickets (staff)',
        description:
          'Runs the single-ticket update (PATCH /tickets/:id) for each id in turn — same permissions, TicketEvents, notifications and realtime — and answers per ticket. Assigning a NEW ticket also opens it. Unknown and invisible tickets are `not_found` (existence is never revealed). Ids must be unique; per-user limit of 10 requests a minute. Clients get 403.',
        security,
        body: bulkTicketsSchema,
        response: { 200: bulkTicketResultSchema, ...errorResponses(400, 401, 403, 429) },
      },
    },
    async (req) => app.services.queue.bulk(actorOf(req), req.body),
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

  app.post(
    '/tickets/:id/acknowledge',
    {
      preHandler: [auth, acknowledgeLimit],
      schema: {
        tags: ['tickets'],
        summary: 'Acknowledge a P1 ticket (stops its escalation chain)',
        description:
          'Staff who can see the ticket; no body. Idempotent: when the P1 was already acknowledged the answer is 200 with `alreadyAcknowledged: true` and the first acknowledger (`p1AckedBy` / `p1AckedAt`). A ticket that is not P1, or a closed one, is 409 CONFLICT; clients get 403. Nothing acknowledges on GET (links in emails, Teams and SMS open the console).',
        security,
        params: idParamSchema,
        response: {
          200: acknowledgeTicketResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (req) => app.services.tickets.acknowledge(actorOf(req), req.params.id),
  );

  app.get(
    '/tickets/:id/events',
    {
      preHandler: auth,
      schema: {
        tags: ['tickets'],
        summary: 'The ticket’s activity timeline, newest first (staff)',
        description:
          'Every recorded change (status, priority, assignee, team, category, SLA at risk / breached, escalation steps, acknowledgement, auto-close…) with who and when; ids resolved to labels, archived items included. Cursor-paged. Clients get 403; a ticket the caller can’t see is 404.',
        security,
        params: idParamSchema,
        querystring: ticketEventsQuerySchema,
        response: { 200: ticketEventListSchema, ...errorResponses(400, 401, 403, 404, 429) },
      },
    },
    async (req) => app.services.ticketEvents.list(actorOf(req), req.params.id, req.query),
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
