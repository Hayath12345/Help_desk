import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMessageResponseSchema, messageListSchema } from '@loons/shared';
import { createTestContext, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

describe('ticket messages', () => {
  let ctx: TestContext;
  let w: World;
  let requester: Persona;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    requester = await w.newClientX('Mira Messages');
  });
  afterAll(async () => {
    await ctx.close();
  });

  const newTicket = (overrides: Record<string, unknown> = {}) =>
    createTicket(ctx, requester, ticketBody(w, overrides));
  const row = (id: string) => ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });
  const events = (ticketId: string) =>
    ctx.prisma.ticketEvent.findMany({
      where: { ticketId, type: { not: 'CREATED' } },
      orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
    });

  describe('POST /tickets/:id/messages', () => {
    it('client reply: 201, message + ticket summary; NEW stays NEW; preview and lastMessageAt move', async () => {
      const t = await newTicket();
      const clientTempId = randomUUID();
      const res = await postMessage(ctx, requester, t.id, {
        body: '  Line one\n\nLine   two  ',
        clientTempId,
      });
      expect(res.statusCode).toBe(201);
      const body = createMessageResponseSchema.parse(res.json());
      expect(body.message).toMatchObject({
        ticketId: t.id,
        type: 'PUBLIC',
        body: 'Line one\n\nLine   two', // trimmed; line breaks kept
        clientTempId,
        author: { id: requester.id, name: requester.name, role: 'CLIENT' },
        attachments: [],
      });
      expect(body.ticket.status).toBe('NEW');
      expect(body.ticket.preview).toBe('Line one Line two');
      expect(body.ticket.lastMessageAt).toBe(body.message.createdAt);
    });

    it('is idempotent on clientTempId: a retry returns the stored message with 200', async () => {
      const t = await newTicket();
      const clientTempId = randomUUID();
      const first = await postMessage(ctx, requester, t.id, { body: 'Hello', clientTempId });
      expect(first.statusCode).toBe(201);
      const retry = await postMessage(ctx, requester, t.id, {
        body: 'Hello (edited)',
        clientTempId,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().message.id).toBe(first.json().message.id);
      expect(retry.json().message.body).toBe('Hello');
      expect(await ctx.prisma.message.count({ where: { ticketId: t.id, clientTempId } })).toBe(1);
    });

    it('concurrent retries of one message store it once (one 201, the rest 200)', async () => {
      const t = await newTicket();
      const clientTempId = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          postMessage(ctx, requester, t.id, { body: 'Hi', clientTempId }),
        ),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.json().message.id)).size).toBe(1);
      expect(await ctx.prisma.message.count({ where: { ticketId: t.id, clientTempId } })).toBe(1);
    });

    it('someone else replaying a clientTempId → 409 (the stored message is never returned)', async () => {
      const t = await newTicket();
      const clientTempId = randomUUID();
      await postMessage(ctx, w.agentA, t.id, {
        type: 'INTERNAL',
        body: 'secret note',
        clientTempId,
      });
      const res = await postMessage(ctx, requester, t.id, { body: 'x', clientTempId });
      expect(res.statusCode).toBe(409);
      expect(res.body).not.toContain('secret note');
    });

    it('first staff public reply: firstRepliedAt, FIRST_REPLY, → PENDING, auto-assigned', async () => {
      const t = await newTicket();
      const res = await postMessage(ctx, w.agentA, t.id, { body: 'We are on it.' });
      expect(res.statusCode).toBe(201);
      const { ticket, message } = res.json();
      expect(ticket).toMatchObject({
        status: 'PENDING',
        assignee: { id: w.agentA.id },
        firstRepliedAt: message.createdAt,
        slaPausedAt: message.createdAt,
      });
      const history = await events(t.id);
      // Same instant: compare in name order.
      expect(history.map((e) => [e.type, e.fromValue, e.toValue]).sort()).toEqual([
        ['ASSIGNEE_CHANGED', null, w.agentA.id],
        ['FIRST_REPLY', null, null],
        ['STATUS_CHANGED', 'NEW', 'PENDING'],
      ]);
      expect(history.find((e) => e.type === 'FIRST_REPLY')?.meta).toEqual({
        minutesToFirstReply: 0,
        messageId: message.id,
      });

      // A second reply: no new FIRST_REPLY, firstRepliedAt unchanged, still PENDING.
      await postMessage(ctx, w.agentA2, t.id, { body: 'Update: parts ordered.' });
      const after = await row(t.id);
      expect(after.firstRepliedAt?.toISOString()).toBe(message.createdAt);
      expect(after.assigneeId).toBe(w.agentA.id);
      expect((await events(t.id)).filter((e) => e.type === 'FIRST_REPLY')).toHaveLength(1);
    });

    it('staff outside the team replying does not take the ticket', async () => {
      const t = await newTicket();
      const res = await postMessage(ctx, w.admin, t.id, { body: 'Admin reply' });
      expect(res.json().ticket.assignee).toBeNull();
      expect(res.json().ticket.firstRepliedAt).not.toBeNull();
    });

    it('internal note: first touch NEW → OPEN; no first reply, no assignment, lastMessageAt unchanged', async () => {
      const t = await newTicket();
      const before = await row(t.id);
      const res = await postMessage(ctx, w.agentA, t.id, {
        type: 'INTERNAL',
        body: 'Check the NVR',
      });
      expect(res.statusCode).toBe(201);
      const { ticket, message } = res.json();
      expect(message.type).toBe('INTERNAL');
      expect(ticket).toMatchObject({ status: 'OPEN', firstRepliedAt: null, assignee: null });
      expect(ticket.lastMessageAt).toBe(before.lastMessageAt!.toISOString());
      expect(ticket.preview).not.toContain('NVR');
      expect((await events(t.id)).map((e) => [e.type, e.toValue])).toEqual([
        ['STATUS_CHANGED', 'OPEN'],
      ]);
      // A second note changes nothing.
      await postMessage(ctx, w.agentA, t.id, { type: 'INTERNAL', body: 'Another note' });
      expect((await events(t.id)).length).toBe(1);
    });

    it('Send & solve → SOLVED with solvedAt; a client reply then reopens (OPEN)', async () => {
      const t = await newTicket();
      const solved = await postMessage(ctx, w.agentA, t.id, { body: 'Fixed.', andSolve: true });
      expect(solved.json().ticket).toMatchObject({
        status: 'SOLVED',
        solvedAt: expect.any(String),
      });
      const reopened = await postMessage(ctx, requester, t.id, { body: 'Broken again.' });
      expect(reopened.json().ticket).toMatchObject({ status: 'OPEN', solvedAt: null });
      expect(
        (await events(t.id))
          .filter((e) => e.type === 'STATUS_CHANGED')
          .map((e) => [e.fromValue, e.toValue]),
      ).toEqual([
        ['NEW', 'SOLVED'],
        ['SOLVED', 'OPEN'],
      ]);
    });

    it('a staff reply on a SOLVED ticket → PENDING (solvedAt cleared)', async () => {
      const t = await newTicket();
      await apiAs(ctx, w.agentA).patch(`/tickets/${t.id}`, { status: 'SOLVED' });
      const res = await postMessage(ctx, w.agentA, t.id, { body: 'One more thing.' });
      expect(res.json().ticket).toMatchObject({ status: 'PENDING', solvedAt: null });
    });

    it('validation: empty body, too long, bad clientTempId → 400', async () => {
      const t = await newTicket();
      const empty = await postMessage(ctx, requester, t.id, { body: '   ' });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.details[0].message).toBe('validation.messageRequired');
      const long = await postMessage(ctx, requester, t.id, { body: 'x'.repeat(10_001) });
      expect(long.json().error.details[0].message).toBe('validation.tooLong');
      expect(
        (await postMessage(ctx, requester, t.id, { body: 'x', clientTempId: 'abc' })).statusCode,
      ).toBe(400);
      expect(
        (await postMessage(ctx, requester, t.id, { body: 'x', type: 'SYSTEM' })).statusCode,
      ).toBe(400);
    });

    it('control characters are dropped from the body (review SEC-API-2)', async () => {
      const t = await newTicket();
      const res = await postMessage(ctx, requester, t.id, { body: 'hi\u0000there\u0007\n:)' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().message.body).toBe('hithere\n:)');
      const empty = await postMessage(ctx, requester, t.id, { body: '\u0000' });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.details[0].message).toBe('validation.messageRequired');
    });

    it('clients of a deactivated organisation can read but not reply or reopen (review SEC-API-3)', async () => {
      const other = await ctx.fixtures.client({ name: 'Omar Offboarded' });
      const site = await ctx.fixtures.site(other.org.id);
      const client = await persona(ctx, other.user);
      const t = await createTicket(ctx, client, ticketBody(w, { siteId: site.id }));
      const clientTempId = randomUUID();
      expect(
        (await postMessage(ctx, client, t.id, { body: 'Before', clientTempId })).statusCode,
      ).toBe(201);
      await apiAs(ctx, client).patch(`/tickets/${t.id}`, { status: 'SOLVED' });
      await ctx.prisma.organization.update({
        where: { id: other.org.id },
        data: { isActive: false },
      });
      const reply = await postMessage(ctx, client, t.id, { body: 'After' });
      expect(reply.statusCode).toBe(403);
      expect(
        (await apiAs(ctx, client).patch(`/tickets/${t.id}`, { status: 'OPEN' })).statusCode,
      ).toBe(403);
      // An idempotent retry of a message stored before still answers with it.
      expect(
        (await postMessage(ctx, client, t.id, { body: 'Before', clientTempId })).statusCode,
      ).toBe(200);
      expect((await apiAs(ctx, client).get(`/tickets/${t.id}/messages`)).statusCode).toBe(200);
      // Staff can still answer and wrap the ticket up.
      expect((await postMessage(ctx, w.agentA, t.id, { body: 'Closing this.' })).statusCode).toBe(
        201,
      );
    });

    it('attachments are linked to the message; files presigned for another ticket are refused', async () => {
      const t = await newTicket();
      const other = await newTicket();
      const mk = (ticketId: string | null) =>
        ctx.prisma.attachment.create({
          data: {
            uploaderId: requester.id,
            ticketId,
            storageKey: `test/${randomUUID()}/p.png`,
            fileName: 'p.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            status: 'CLEAN',
          },
        });
      const own = await mk(t.id);
      const loose = await mk(null);
      const foreign = await mk(other.id);
      const res = await postMessage(ctx, requester, t.id, {
        body: 'Photos',
        attachmentIds: [own.id, loose.id],
      });
      expect(res.statusCode).toBe(201);
      expect(
        res
          .json()
          .message.attachments.map((a: { id: string }) => a.id)
          .sort(),
      ).toEqual([own.id, loose.id].sort());
      const refused = await postMessage(ctx, requester, t.id, {
        body: 'Wrong ticket',
        attachmentIds: [foreign.id],
      });
      expect(refused.statusCode).toBe(400);
      expect(
        await ctx.prisma.message.count({ where: { ticketId: t.id, body: 'Wrong ticket' } }),
      ).toBe(0);
    });
  });

  describe('GET /tickets/:id/messages', () => {
    it('oldest first; staff see notes, clients never do; `after` returns only newer ones', async () => {
      const t = await newTicket();
      const posted: string[] = [];
      for (const [as, type, body] of [
        [w.agentA, 'INTERNAL', 'note 1'],
        [w.agentA, 'PUBLIC', 'reply 1'],
        [requester, 'PUBLIC', 'reply 2'],
        [w.agentA, 'INTERNAL', 'note 2'],
      ] as const) {
        posted.push((await postMessage(ctx, as, t.id, { type, body })).json().message.id);
      }
      const staff = messageListSchema.parse(
        (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}/messages`)).json(),
      );
      expect(staff.items.map((m) => m.body)).toEqual([
        'The access door on level 2 does not open with a valid card.',
        'note 1',
        'reply 1',
        'reply 2',
        'note 2',
      ]);
      const client = messageListSchema.parse(
        (await apiAs(ctx, requester).get(`/tickets/${t.id}/messages`)).json(),
      );
      expect(client.items.map((m) => m.type)).toEqual(['PUBLIC', 'PUBLIC', 'PUBLIC']);

      const after = await apiAs(ctx, w.agentA).get(`/tickets/${t.id}/messages?after=${posted[1]}`);
      expect(after.json().items.map((m: { body: string }) => m.body)).toEqual([
        'reply 2',
        'note 2',
      ]);
      const clientAfter = await apiAs(ctx, requester).get(
        `/tickets/${t.id}/messages?after=${posted[1]}`,
      );
      expect(clientAfter.json().items.map((m: { body: string }) => m.body)).toEqual(['reply 2']);
      const limited = await apiAs(ctx, w.agentA).get(`/tickets/${t.id}/messages?limit=2`);
      expect(limited.json().items).toHaveLength(2);
    });

    it('`after` an internal note (as a client) or an unknown message → 404', async () => {
      const t = await newTicket();
      const note = (await postMessage(ctx, w.agentA, t.id, { type: 'INTERNAL', body: 'n' })).json()
        .message.id;
      expect(
        (await apiAs(ctx, requester).get(`/tickets/${t.id}/messages?after=${note}`)).statusCode,
      ).toBe(404);
      expect(
        (await apiAs(ctx, requester).get(`/tickets/${t.id}/messages?after=${randomUUID()}`))
          .statusCode,
      ).toBe(404);
      expect(
        (await apiAs(ctx, w.agentA).get(`/tickets/${t.id}/messages?after=${note}`)).statusCode,
      ).toBe(200);
    });
  });
});
