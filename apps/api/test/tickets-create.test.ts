import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeDueDates,
  formContextSchema,
  ticketFormConfigSchema,
  ticketResponseSchema,
} from '@loons/shared';
import { TICKET_RATE_LIMITS } from '../src/routes/tickets.ts';
import { createTestContext, rand, randomIp, type TestContext } from './helpers.ts';
import {
  apiAs,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

const MIN = 60_000;

describe('ticket configuration, form context and creation', () => {
  let ctx: TestContext;
  let w: World;
  let catC: Awaited<ReturnType<TestContext['fixtures']['category']>>;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    catC = await ctx.fixtures.category({
      teamId: w.teamA.id,
      subtypes: [{ defaultPriority: 'P4' }],
      fields: [
        { type: 'TEXT', required: true },
        { type: 'NUMBER' },
        { type: 'DROPDOWN', required: true, options: ['red', 'green'] },
        { type: 'MULTI_SELECT', options: ['a', 'b', 'c'] },
        { type: 'DATE' },
        { type: 'YES_NO', required: true },
        { type: 'ASSET_ID' },
        { type: 'TEXT', isActive: false },
      ],
    });
    await ctx.app.services.ticketConfig.invalidate();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const fieldKey = (i: number) => catC.fields[i]!.key;

  describe('GET /config/ticket-form', () => {
    it('returns the active config (categories, sub-types, fields, SLA policies)', async () => {
      const res = await apiAs(ctx, w.clientX).get('/config/ticket-form');
      expect(res.statusCode).toBe(200);
      const config = ticketFormConfigSchema.parse(res.json());
      expect(config.securityCategoryKey).toBe('cyber');
      expect(config.socPhone).toEqual(expect.any(String));
      expect(config.slaPolicies.map((p) => p.priority)).toEqual(['P1', 'P2', 'P3', 'P4']);
      const a = config.categories.find((c) => c.id === w.catA.category.id);
      expect(a?.team.id).toBe(w.teamA.id);
      // Only the four active sub-types.
      expect(a?.subtypes.map((s) => s.id)).toEqual(w.catA.subtypes.slice(0, 4).map((s) => s.id));
      expect(config.categories.some((c) => c.id === w.catArchived.category.id)).toBe(false);
      const c = config.categories.find((x) => x.id === catC.category.id);
      // The archived field is left out; options come through.
      expect(c?.fields.map((f) => f.key)).toEqual(catC.fields.slice(0, 7).map((f) => f.key));
      expect(c?.fields[2]?.options.map((o) => o.value)).toEqual(['red', 'green']);
      // Seeded categories are there too, test categories sort last.
      expect(config.categories[0]?.key).toBe('cyber');
    });

    it('is cached in Redis until invalidated', async () => {
      const api = apiAs(ctx, w.agentA);
      const before = ticketFormConfigSchema.parse((await api.get('/config/ticket-form')).json());
      expect(await ctx.redis.exists(`${ctx.config.redisPrefix}config:ticket-form`)).toBe(1);
      const extra = await ctx.fixtures.category({ teamId: w.teamB.id });
      const cached = ticketFormConfigSchema.parse((await api.get('/config/ticket-form')).json());
      expect(cached.version).toBe(before.version);
      expect(cached.categories.some((c) => c.id === extra.category.id)).toBe(false);

      await ctx.app.services.ticketConfig.invalidate();
      const fresh = ticketFormConfigSchema.parse((await api.get('/config/ticket-form')).json());
      expect(fresh.version).not.toBe(before.version);
      expect(fresh.categories.some((c) => c.id === extra.category.id)).toBe(true);
    });

    it('401 without a token; 403 for pending and unverified accounts', async () => {
      expect((await apiAs(ctx).get('/config/ticket-form')).statusCode).toBe(401);
      expect((await apiAs(ctx, w.pending).get('/config/ticket-form')).statusCode).toBe(403);
      const unverified = await apiAs(ctx, w.unverified).get('/config/ticket-form');
      expect(unverified.statusCode).toBe(403);
      expect(unverified.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });
  });

  describe('GET /tickets/form-context', () => {
    it('client: themselves, their organisation and its active sites', async () => {
      const res = await apiAs(ctx, w.clientX).get('/tickets/form-context');
      expect(res.statusCode).toBe(200);
      const body = formContextSchema.parse(res.json());
      expect(body.requester).toEqual({
        id: w.clientX.id,
        name: w.clientX.name,
        email: w.clientX.email,
      });
      expect(body.org).toMatchObject({ id: w.orgX.id, contractType: 'AMC' });
      expect(body.sites.map((s) => s.id).sort()).toEqual([w.siteX1.id, w.siteX2.id].sort());
    });

    it('client asking for someone else → 403', async () => {
      const res = await apiAs(ctx, w.clientX).get(
        `/tickets/form-context?requesterId=${w.clientX2.id}`,
      );
      expect(res.statusCode).toBe(403);
    });

    it('staff: requesterId required; returns that client’s organisation and sites', async () => {
      const missing = await apiAs(ctx, w.agentA).get('/tickets/form-context');
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe('VALIDATION_FAILED');
      const res = await apiAs(ctx, w.agentA).get(
        `/tickets/form-context?requesterId=${w.clientY.id}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().org.id).toBe(w.orgY.id);
      expect(res.json().sites.map((s: { id: string }) => s.id)).toEqual([w.siteY1.id]);
    });

    it('staff: an unverified, pending or staff "requester" → 404', async () => {
      for (const id of [w.unverified.id, w.pending.id, w.agentB.id, randomUUID()]) {
        const res = await apiAs(ctx, w.agentA).get(`/tickets/form-context?requesterId=${id}`);
        expect(res.statusCode, id).toBe(404);
      }
    });
  });

  describe('GET /requesters', () => {
    it('staff search active, verified clients by name or email', async () => {
      const res = await apiAs(ctx, w.agentA).get(
        `/requesters?search=${encodeURIComponent(w.clientX.email)}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        {
          id: w.clientX.id,
          name: w.clientX.name,
          email: w.clientX.email,
          org: { id: w.orgX.id, name: w.orgX.name, nameAr: null, contractType: 'AMC' },
        },
      ]);
      const domain = w.clientX.email.split('@')[1]!;
      const byDomain = await apiAs(ctx, w.agentA).get(`/requesters?search=${domain}&limit=50`);
      const ids = byDomain.json().items.map((i: { id: string }) => i.id);
      expect(ids).toContain(w.clientX2.id);
      expect(ids).not.toContain(w.unverified.id); // unverified clients are never offered
    });

    it('LIKE wildcards in the search are literal', async () => {
      const tag = rand(3);
      const literal = await w.newClientX(`Wild_card ${tag}`);
      await w.newClientX(`Wildxcard ${tag}`);
      const res = await apiAs(ctx, w.agentA).get(`/requesters?search=d_card%20${tag}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([literal.id]);
      const percent = await apiAs(ctx, w.agentA).get('/requesters?search=%25%25');
      expect(percent.json().items).toEqual([]);
    });

    it('clients → 403', async () => {
      expect((await apiAs(ctx, w.clientX).get('/requesters')).statusCode).toBe(403);
    });

    it('control characters in the search are ignored, never a 500 (review SEC-API-2)', async () => {
      const res = await apiAs(ctx, w.agentA).get(
        `/requesters?search=%00${encodeURIComponent(w.clientX.email)}%07`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((i: { id: string }) => i.id)).toEqual([w.clientX.id]);
    });
  });

  describe('POST /tickets', () => {
    it('client: NEW, PORTAL, routed to the category team, default priority, SLA due dates', async () => {
      const res = await apiAs(ctx, w.clientX).post('/tickets', ticketBody(w, { assetId: 'DR-2' }));
      expect(res.statusCode).toBe(201);
      const { ticket } = ticketResponseSchema.parse(res.json());
      expect(ticket).toMatchObject({
        status: 'NEW',
        channel: 'PORTAL',
        priority: 'P3',
        type: 'INCIDENT',
        team: { id: w.teamA.id },
        org: { id: w.orgX.id },
        site: { id: w.siteX1.id },
        requester: { id: w.clientX.id, email: w.clientX.email },
        assignee: null,
        assetId: 'DR-2',
        tags: [],
        preview: 'The access door on level 2 does not open with a valid card.',
        firstRepliedAt: null,
        solvedAt: null,
        slaPausedAt: null,
        requesterCard: { org: { id: w.orgX.id }, sitesCount: 2, otherTicketsCount: 0 },
        sla: { priority: 'P3', businessHoursOnly: true },
      });
      expect(ticket.ref).toBe(`LG-${ticket.number}`);
      expect(ticket.lastMessageAt).toBe(ticket.createdAt);

      // Due dates: the shared SLA arithmetic with the calendar from the database.
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      expect(calendar.timeZone).toBe('Asia/Qatar');
      const policy = await ctx.prisma.slaPolicy.findUniqueOrThrow({ where: { priority: 'P3' } });
      const due = computeDueDates(new Date(ticket.createdAt), policy, calendar);
      expect(ticket.firstReplyDueAt).toBe(due.firstReplyDueAt.toISOString());
      expect(ticket.resolveDueAt).toBe(due.resolveDueAt.toISOString());

      // The description is the first PUBLIC message, by the client; CREATED event.
      const messages = await ctx.prisma.message.findMany({ where: { ticketId: ticket.id } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'PUBLIC', authorId: w.clientX.id });
      const events = await ctx.prisma.ticketEvent.findMany({ where: { ticketId: ticket.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'CREATED',
        actorId: w.clientX.id,
        toValue: 'NEW',
        meta: {
          priority: 'P3',
          type: 'INCIDENT',
          category: w.catA.category.key,
          subtype: w.catA.subtypes[0]!.key,
          channel: 'PORTAL',
        },
      });
    });

    it('priority override: P1 runs 24/7 (15 min / 4 h from creation)', async () => {
      const res = await apiAs(ctx, w.clientX).post('/tickets', ticketBody(w, { priority: 'P1' }));
      expect(res.statusCode).toBe(201);
      const { ticket } = res.json();
      const created = Date.parse(ticket.createdAt);
      expect(ticket.priority).toBe('P1');
      expect(Date.parse(ticket.firstReplyDueAt) - created).toBe(15 * MIN);
      expect(Date.parse(ticket.resolveDueAt) - created).toBe(240 * MIN);
      expect(ticket.sla).toEqual({
        priority: 'P1',
        firstReplyMins: 15,
        resolveMins: 240,
        businessHoursOnly: false,
      });
    });

    it('sub-type default priority applies when no override is sent', async () => {
      const res = await apiAs(ctx, w.clientX).post(
        '/tickets',
        ticketBody(w, { subtypeId: w.catA.subtypes[1]!.id }),
      );
      expect(res.json().ticket.priority).toBe('P1');
    });

    it('staff on the team: OPEN, PHONE, assigned to the caller; description authored by staff', async () => {
      const res = await apiAs(ctx, w.agentA).post(
        '/tickets',
        ticketBody(w, { requesterId: w.clientX.id }),
      );
      expect(res.statusCode).toBe(201);
      const { ticket } = res.json();
      expect(ticket).toMatchObject({
        status: 'OPEN',
        channel: 'PHONE',
        requester: { id: w.clientX.id },
        assignee: { id: w.agentA.id, name: w.agentA.name },
      });
      const events = await ctx.prisma.ticketEvent.findMany({
        where: { ticketId: ticket.id },
        orderBy: { type: 'asc' },
      });
      expect(events.map((e) => [e.type, e.toValue, e.actorId])).toEqual([
        ['CREATED', 'OPEN', w.agentA.id],
        ['ASSIGNEE_CHANGED', w.agentA.id, w.agentA.id],
      ]);
      const message = await ctx.prisma.message.findFirstOrThrow({ where: { ticketId: ticket.id } });
      expect(message.authorId).toBe(w.agentA.id);
    });

    it('staff not on the routed team: the ticket stays unassigned', async () => {
      const res = await apiAs(ctx, w.agentB).post(
        '/tickets',
        ticketBody(w, { requesterId: w.clientX.id }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().ticket.assignee).toBeNull();
    });

    it('staff: requesterId required and must be an active, verified client', async () => {
      const missing = await apiAs(ctx, w.agentA).post('/tickets', ticketBody(w));
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.details).toContainEqual(
        expect.objectContaining({ path: ['requesterId'], message: 'validation.required' }),
      );
      for (const requesterId of [w.unverified.id, w.pending.id, w.agentB.id, randomUUID()]) {
        const res = await apiAs(ctx, w.agentA).post('/tickets', ticketBody(w, { requesterId }));
        expect(res.statusCode, requesterId).toBe(400);
        expect(res.json().error.details).toContainEqual(
          expect.objectContaining({ path: ['requesterId'] }),
        );
      }
    });

    it('a client raising a ticket for someone else → 403', async () => {
      const res = await apiAs(ctx, w.clientX).post(
        '/tickets',
        ticketBody(w, { requesterId: w.clientX2.id }),
      );
      expect(res.statusCode).toBe(403);
    });

    it('pending / unverified accounts → 403; no token → 401', async () => {
      expect((await apiAs(ctx, w.pending).post('/tickets', ticketBody(w))).statusCode).toBe(403);
      expect((await apiAs(ctx, w.unverified).post('/tickets', ticketBody(w))).statusCode).toBe(403);
      expect((await apiAs(ctx).post('/tickets', ticketBody(w))).statusCode).toBe(401);
    });

    it.each([
      ['archived category', { categoryId: 'archived' }, ['categoryId']],
      ['sub-type of another category', { subtypeId: 'catB' }, ['subtypeId']],
      ['archived sub-type', { subtypeId: 'inactive' }, ['subtypeId']],
      ['site of another organisation', { siteId: 'siteY1' }, ['siteId']],
      ['archived site', { siteId: 'archivedSite' }, ['siteId']],
    ])('%s → 400 VALIDATION_FAILED on the field', async (_name, override, path) => {
      const refs: Record<string, string> = {
        archived: w.catArchived.category.id,
        catB: w.catB.subtypes[0]!.id,
        inactive: w.catA.subtypes[4]!.id,
        siteY1: w.siteY1.id,
        archivedSite: w.siteXArchived.id,
      };
      const body = ticketBody(
        w,
        Object.fromEntries(Object.entries(override).map(([k, v]) => [k, refs[v]])),
      );
      const res = await apiAs(ctx, w.clientX).post('/tickets', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      expect(res.json().error.details).toContainEqual(expect.objectContaining({ path }));
    });

    it('per-user limit on creation, then 429 RATE_LIMITED (other users unaffected)', async () => {
      const heavy = await w.newClientX();
      // Passes the schema, fails the business rules: still counts as an attempt.
      const bad = ticketBody(w, { siteId: w.siteY1.id });
      for (let i = 0; i < TICKET_RATE_LIMITS.create.max; i++) {
        expect((await apiAs(ctx, heavy).post('/tickets', bad)).statusCode).toBe(400);
      }
      const limited = await apiAs(ctx, heavy).post('/tickets', ticketBody(w));
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await apiAs(ctx, w.clientX2).post('/tickets', ticketBody(w))).statusCode).toBe(201);
    });

    it('control characters are dropped, never stored or sent to Postgres (review SEC-API-2)', async () => {
      const as = await w.newClientX();
      const res = await apiAs(ctx, as).post(
        '/tickets',
        ticketBody(w, {
          subject: 'Door\u0000 stuck\u0007',
          description: 'The access door \u0000on level 2\u001b does not open.\r\nSecond\tline.',
          assetId: 'RDR\u0000-203',
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const { ticket } = res.json();
      expect(ticket.subject).toBe('Door stuck');
      expect(ticket.description).toBe('The access door on level 2 does not open.\r\nSecond\tline.');
      expect(ticket.assetId).toBe('RDR-203');
      const messages = (await apiAs(ctx, as).get(`/tickets/${ticket.id}/messages`)).json().items;
      expect(messages[0].body).toBe(ticket.description);
      // Nothing but control characters is an empty subject: the usual 400.
      const empty = await apiAs(ctx, as).post(
        '/tickets',
        ticketBody(w, { subject: '\u0000\u0000' }),
      );
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.details[0].message).toBe('validation.subjectRequired');
    });

    it('clients of a deactivated organisation cannot raise tickets (review SEC-API-3)', async () => {
      const other = await ctx.fixtures.client({ name: 'Olga Offboarded' });
      const site = await ctx.fixtures.site(other.org.id);
      const client = await persona(ctx, other.user);
      const body = ticketBody(w, { siteId: site.id });
      expect((await apiAs(ctx, client).post('/tickets', body)).statusCode).toBe(201);
      await ctx.prisma.organization.update({
        where: { id: other.org.id },
        data: { isActive: false },
      });
      const res = await apiAs(ctx, client).post('/tickets', body);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
      // Same rule as for staff raising a ticket for them, and as the form context.
      const staff = await apiAs(ctx, w.agentA).post('/tickets', {
        ...body,
        requesterId: client.id,
      });
      expect(staff.statusCode).toBe(400);
      expect((await apiAs(ctx, client).get('/tickets/form-context')).statusCode).toBe(404);
      // Their history stays readable.
      expect((await apiAs(ctx, client).get('/tickets')).json().items).toHaveLength(1);
    });

    it('schema errors carry the i18n keys (subject, description)', async () => {
      const res = await apiAs(ctx, w.clientX).post(
        '/tickets',
        ticketBody(w, { subject: '   ', description: 'short' }),
      );
      expect(res.statusCode).toBe(400);
      const messages = res.json().error.details.map((d: { message: string }) => d.message);
      expect(messages).toEqual(
        expect.arrayContaining(['validation.subjectRequired', 'validation.descriptionMin']),
      );
    });

    describe('Security Incident', () => {
      const cyber = async () => {
        const config = await ctx.app.services.ticketConfig.getFormConfig();
        const category = config.categories.find((c) => c.key === config.securityCategoryKey)!;
        return category;
      };

      it('outside the security category → 400 (security_category)', async () => {
        const res = await apiAs(ctx, w.clientX).post(
          '/tickets',
          ticketBody(w, { type: 'SECURITY_INCIDENT' }),
        );
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details).toContainEqual(
          expect.objectContaining({ path: ['categoryId'], code: 'security_category' }),
        );
      });

      it('in Cybersecurity / SOC: routed to its team and tagged "security"', async () => {
        const category = await cyber();
        const res = await apiAs(ctx, w.clientX).post(
          '/tickets',
          ticketBody(w, {
            type: 'SECURITY_INCIDENT',
            categoryId: category.id,
            subtypeId: category.subtypes[0]!.id,
          }),
        );
        expect(res.statusCode).toBe(201);
        expect(res.json().ticket).toMatchObject({
          type: 'SECURITY_INCIDENT',
          category: { key: 'cyber' },
          team: { id: category.team.id },
          tags: ['security'],
          priority: category.subtypes[0]!.defaultPriority,
        });
      });
    });

    describe('custom fields', () => {
      let cf: Persona;
      beforeAll(async () => {
        cf = await w.newClientX();
      });

      const body = (customFields: Record<string, unknown>) =>
        ticketBody(w, {
          categoryId: catC.category.id,
          subtypeId: catC.subtypes[0]!.id,
          customFields,
        });
      const valid = () => ({
        [fieldKey(0)]: '  Panel 3  ',
        [fieldKey(1)]: '42',
        [fieldKey(2)]: 'green',
        [fieldKey(3)]: ['a', 'c', 'a'],
        [fieldKey(4)]: '2026-12-01',
        [fieldKey(5)]: false,
        [fieldKey(6)]: 'CAM-014',
      });

      it('valid values are normalised and returned with their labels', async () => {
        const res = await apiAs(ctx, cf).post('/tickets', body(valid()));
        expect(res.statusCode).toBe(201);
        const { ticket } = res.json();
        expect(ticket.priority).toBe('P4');
        expect(
          ticket.customFields.map((f: { key: string; value: unknown }) => [f.key, f.value]),
        ).toEqual([
          [fieldKey(0), 'Panel 3'],
          [fieldKey(1), 42],
          [fieldKey(2), 'green'],
          [fieldKey(3), ['a', 'c']],
          [fieldKey(4), '2026-12-01'],
          [fieldKey(5), false],
          [fieldKey(6), 'CAM-014'],
        ]);
        expect(ticket.customFields[0]).toMatchObject({ labelEn: 'Field TEXT', type: 'TEXT' });
      });

      it('lone UTF-16 surrogates become U+FFFD, never a 500 (jsonb refuses them; RR-SEC-3)', async () => {
        // The raw JSON escape reaches the parser as the probe sent it.
        const json = JSON.stringify(
          body({ ...valid(), [fieldKey(0)]: 'x__LONE__y', [fieldKey(6)]: 'A__LONE__' }),
        ).replaceAll('__LONE__', '\\ud800');
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/tickets',
          headers: { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' },
          remoteAddress: randomIp(),
          payload: json,
        });
        expect(res.statusCode, res.body).toBe(201);
        const values = Object.fromEntries(
          res
            .json()
            .ticket.customFields.map((f: { key: string; value: unknown }) => [f.key, f.value]),
        );
        expect(values[fieldKey(0)]).toBe('x�y');
        expect(values[fieldKey(6)]).toBe('A�');
        const stored = await ctx.prisma.ticket.findUniqueOrThrow({
          where: { id: res.json().ticket.id },
          select: { customFields: true },
        });
        expect(stored.customFields).toMatchObject({ [fieldKey(0)]: 'x�y' });
      });

      it('text values lose control characters (NUL cannot be stored in jsonb)', async () => {
        const res = await apiAs(ctx, cf).post(
          '/tickets',
          body({
            ...valid(),
            [fieldKey(0)]: 'Pa\u0000nel\u0008 3',
            [fieldKey(6)]: 'CAM\u0000-014',
          }),
        );
        expect(res.statusCode, res.body).toBe(201);
        const values = Object.fromEntries(
          res
            .json()
            .ticket.customFields.map((f: { key: string; value: unknown }) => [f.key, f.value]),
        );
        expect(values[fieldKey(0)]).toBe('Panel 3');
        expect(values[fieldKey(6)]).toBe('CAM-014');
        // A multi-select value with a NUL is simply not one of the options.
        const bad = await apiAs(ctx, cf).post(
          '/tickets',
          body({ ...valid(), [fieldKey(3)]: ['a\u0000'] }),
        );
        expect(bad.statusCode).toBe(400);
      });

      it('optional fields may be left out or blank', async () => {
        const res = await apiAs(ctx, cf).post(
          '/tickets',
          body({
            [fieldKey(0)]: 'x',
            [fieldKey(2)]: 'red',
            [fieldKey(5)]: true,
            [fieldKey(1)]: '',
          }),
        );
        expect(res.statusCode).toBe(201);
        expect(res.json().ticket.customFields).toHaveLength(3);
      });

      it('required fields missing → validation.required per field', async () => {
        const res = await apiAs(ctx, cf).post('/tickets', body({ [fieldKey(0)]: '   ' }));
        expect(res.statusCode).toBe(400);
        const details = res.json().error.details;
        for (const i of [0, 2, 5]) {
          expect(details).toContainEqual(
            expect.objectContaining({
              path: ['customFields', fieldKey(i)],
              message: 'validation.required',
            }),
          );
        }
      });

      it.each([
        ['TEXT over 500 characters', 0, 'x'.repeat(501), 'validation.tooLong'],
        ['NUMBER not a number', 1, 'forty', 'validation.invalid'],
        ['NUMBER infinite', 1, 'Infinity', 'validation.invalid'],
        ['DROPDOWN outside the options', 2, 'blue', 'validation.invalid'],
        ['MULTI_SELECT outside the options', 3, ['a', 'z'], 'validation.invalid'],
        ['MULTI_SELECT not a list', 3, 'a', 'validation.invalid'],
        ['DATE not an ISO date', 4, '01/12/2026', 'validation.invalid'],
        ['DATE impossible', 4, '2026-02-30', 'validation.invalid'],
        ['YES_NO not a boolean', 5, 'yes', 'validation.invalid'],
        ['ASSET_ID over 500 characters', 6, 'A'.repeat(501), 'validation.tooLong'],
      ])('%s → 400', async (_name, index, value, message) => {
        const res = await apiAs(ctx, cf).post(
          '/tickets',
          body({ ...valid(), [fieldKey(index)]: value }),
        );
        expect(res.statusCode).toBe(400);
        const issue = res
          .json()
          .error.details.find(
            (d: { path: unknown[] }) =>
              d.path[0] === 'customFields' && d.path[1] === fieldKey(index),
          );
        expect(issue?.message).toBe(message);
      });

      it('fields not linked to the category (or archived) → 400 unknown_field', async () => {
        for (const key of [fieldKey(7), 'camera_id', `nope_${rand(3)}`]) {
          const res = await apiAs(ctx, cf).post('/tickets', body({ ...valid(), [key]: 'x' }));
          expect(res.statusCode, key).toBe(400);
          expect(res.json().error.details).toContainEqual(
            expect.objectContaining({ path: ['customFields', key], code: 'unknown_field' }),
          );
        }
      });
    });

    describe('attachments', () => {
      let att: Persona;
      beforeAll(async () => {
        att = await w.newClientX();
      });

      async function attachment(
        uploaderId: string,
        data: { status?: 'PENDING' | 'UPLOADED' | 'CLEAN' | 'REJECTED'; sizeBytes?: number } = {},
      ) {
        return ctx.prisma.attachment.create({
          data: {
            uploaderId,
            storageKey: `test/${randomUUID()}/f.pdf`,
            fileName: 'f.pdf',
            mimeType: 'application/pdf',
            sizeBytes: data.sizeBytes ?? 1000,
            status: data.status ?? 'CLEAN',
          },
        });
      }

      it('the caller’s confirmed uploads are linked to the first message', async () => {
        const a = await attachment(att.id);
        const res = await apiAs(ctx, att).post(
          '/tickets',
          ticketBody(w, { attachmentIds: [a.id] }),
        );
        expect(res.statusCode).toBe(201);
        const { ticket } = res.json();
        expect(ticket.attachments.map((x: { id: string }) => x.id)).toEqual([a.id]);
        const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: a.id } });
        const first = await ctx.prisma.message.findFirstOrThrow({ where: { ticketId: ticket.id } });
        expect(row).toMatchObject({ ticketId: ticket.id, messageId: first.id });
      });

      it('someone else’s, unfinished, rejected or already linked uploads → 400', async () => {
        const foreign = await attachment(w.clientX2.id);
        const pending = await attachment(att.id, { status: 'PENDING' });
        const rejected = await attachment(att.id, { status: 'REJECTED' });
        const used = await attachment(att.id);
        await apiAs(ctx, att).post('/tickets', ticketBody(w, { attachmentIds: [used.id] }));
        for (const a of [foreign, pending, rejected, used]) {
          const res = await apiAs(ctx, att).post(
            '/tickets',
            ticketBody(w, { attachmentIds: [a.id] }),
          );
          expect(res.statusCode, a.status).toBe(400);
          expect(res.json().error.details).toContainEqual(
            expect.objectContaining({ path: ['attachmentIds', 0], code: 'attachment' }),
          );
        }
        // Nothing was created for the failed attempts.
        expect(
          await ctx.prisma.attachment.count({
            where: { id: foreign.id, messageId: { not: null } },
          }),
        ).toBe(0);
      });

      it('more than 25 MB in total → 400', async () => {
        const big1 = await attachment(att.id, { sizeBytes: 20 * 1024 * 1024 });
        const big2 = await attachment(att.id, { sizeBytes: 6 * 1024 * 1024 });
        const res = await apiAs(ctx, att).post(
          '/tickets',
          ticketBody(w, { attachmentIds: [big1.id, big2.id] }),
        );
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details).toContainEqual(
          expect.objectContaining({ code: 'attachments_too_large' }),
        );
      });
    });
  });
});
