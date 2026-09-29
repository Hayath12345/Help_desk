import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  postMessage,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';

// Permission matrix (spec §5, contract "Visibility"): clients see their organisation, agents and
// team leads their teams plus tickets assigned to them, super admins everything. Anything else is
// 404 — never 403 — so ticket existence is not revealed.

describe('ticket access (permission matrix)', () => {
  let ctx: TestContext;
  let w: World;
  const tag = rand(4);
  const tickets: Record<'tX' | 'tX2' | 'tY' | 'tAssigned', { id: string; number: number }> =
    {} as never;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const subject = (name: string) => `Access ${tag} ${name}`;
    // Org X, team A (requested by clientX).
    tickets.tX = await createTicket(ctx, w.clientX, ticketBody(w, { subject: subject('tX') }));
    // Org X, team B (requested by clientX2).
    tickets.tX2 = await createTicket(
      ctx,
      w.clientX2,
      ticketBody(w, {
        subject: subject('tX2'),
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      }),
    );
    // Org Y, team A.
    tickets.tY = await createTicket(
      ctx,
      w.clientY,
      ticketBody(w, { subject: subject('tY'), siteId: w.siteY1.id }),
    );
    // Org Y, team B, assigned to agentA (who is not on team B).
    tickets.tAssigned = await createTicket(
      ctx,
      w.clientY,
      ticketBody(w, {
        subject: subject('tAssigned'),
        siteId: w.siteY1.id,
        categoryId: w.catB.category.id,
        subtypeId: w.catB.subtypes[0]!.id,
      }),
    );
    await ctx.prisma.ticket.update({
      where: { id: tickets.tAssigned.id },
      data: { assigneeId: w.agentA.id },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  type Name = keyof typeof tickets;
  const ALL: Name[] = ['tX', 'tX2', 'tY', 'tAssigned'];
  const matrix = (): Array<[string, Persona, Name[]]> => [
    ['client (org X)', w.clientX, ['tX', 'tX2']],
    ['client (org Y)', w.clientY, ['tY', 'tAssigned']],
    ['agent (team A, + assigned)', w.agentA, ['tX', 'tY', 'tAssigned']],
    ['agent (team B)', w.agentB, ['tX2', 'tAssigned']],
    ['team lead (team A)', w.leadA, ['tX', 'tY']],
    ['super admin', w.admin, ALL],
  ];

  it('GET /tickets/:ref — visible → 200, everything else → 404', async () => {
    for (const [who, persona, visible] of matrix()) {
      for (const name of ALL) {
        const res = await apiAs(ctx, persona).get(`/tickets/${tickets[name].id}`);
        expect(res.statusCode, `${who} → ${name}`).toBe(visible.includes(name) ? 200 : 404);
        if (res.statusCode === 404) expect(res.json().error.code).toBe('NOT_FOUND');
      }
    }
  });

  it('GET /tickets/:ref accepts the LG number (either form) with the same rule', async () => {
    const { number } = tickets.tX;
    for (const ref of [`LG-${number}`, `lg-${number}`, `${number}`]) {
      const res = await apiAs(ctx, w.clientX2).get(`/tickets/${ref}`);
      expect(res.statusCode, ref).toBe(200);
      expect(res.json().ticket.id).toBe(tickets.tX.id);
      expect((await apiAs(ctx, w.clientY).get(`/tickets/${ref}`)).statusCode).toBe(404);
    }
    for (const ref of [randomUUID(), 'LG-999999999', 'not-a-ref', 'LG-99999999999']) {
      expect((await apiAs(ctx, w.admin).get(`/tickets/${ref}`)).statusCode, ref).toBe(404);
    }
  });

  it('GET /tickets/:id/messages follows the same matrix', async () => {
    for (const [who, persona, visible] of matrix()) {
      for (const name of ALL) {
        const res = await apiAs(ctx, persona).get(`/tickets/${tickets[name].id}/messages`);
        expect(res.statusCode, `${who} → ${name}`).toBe(visible.includes(name) ? 200 : 404);
      }
    }
  });

  it('POST /tickets/:id/messages (public reply): invisible → 404', async () => {
    for (const [who, persona, visible] of matrix()) {
      for (const name of ALL) {
        if (visible.includes(name)) continue;
        const res = await postMessage(ctx, persona, tickets[name].id, { body: 'Hello there' });
        expect(res.statusCode, `${who} → ${name}`).toBe(404);
      }
    }
    // One allowed reply per role class.
    expect(
      (await postMessage(ctx, w.clientX2, tickets.tX.id, { body: 'Org reply' })).statusCode,
    ).toBe(201);
    expect(
      (await postMessage(ctx, w.agentA, tickets.tAssigned.id, { body: 'On it' })).statusCode,
    ).toBe(201);
    expect(
      (await postMessage(ctx, w.admin, tickets.tX2.id, { body: 'Admin here' })).statusCode,
    ).toBe(201);
  });

  it('internal notes: clients → 403 on a visible ticket, 404 on an invisible one', async () => {
    const own = await postMessage(ctx, w.clientX, tickets.tX.id, { type: 'INTERNAL', body: 'x' });
    expect(own.statusCode).toBe(403);
    const other = await postMessage(ctx, w.clientX, tickets.tY.id, { type: 'INTERNAL', body: 'x' });
    expect(other.statusCode).toBe(404);
    const andSolve = await postMessage(ctx, w.clientX, tickets.tX.id, {
      body: 'x',
      andSolve: true,
    });
    expect(andSolve.statusCode).toBe(403);
    const staff = await postMessage(ctx, w.leadA, tickets.tY.id, {
      type: 'INTERNAL',
      body: 'note',
    });
    expect(staff.statusCode).toBe(201);
  });

  it('PATCH: staff outside the ticket → 404; clients may only change the status', async () => {
    const res = await apiAs(ctx, w.agentB).patch(`/tickets/${tickets.tX.id}`, { priority: 'P2' });
    expect(res.statusCode).toBe(404);
    const invisible = await apiAs(ctx, w.clientY).patch(`/tickets/${tickets.tX.id}`, {
      status: 'SOLVED',
    });
    expect(invisible.statusCode).toBe(404);
    for (const body of [{ priority: 'P1' }, { assigneeId: w.agentA.id }, { tags: ['x'] }]) {
      const forbidden = await apiAs(ctx, w.clientX).patch(`/tickets/${tickets.tX.id}`, body);
      expect(forbidden.statusCode, JSON.stringify(body)).toBe(403);
    }
    const lead = await apiAs(ctx, w.leadA).patch(`/tickets/${tickets.tX.id}`, {
      impact: 'DEPARTMENT',
    });
    expect(lead.statusCode).toBe(200);
    const admin = await apiAs(ctx, w.admin).patch(`/tickets/${tickets.tX2.id}`, {
      impact: 'DEPARTMENT',
    });
    expect(admin.statusCode).toBe(200);
    const assigned = await apiAs(ctx, w.agentA).patch(`/tickets/${tickets.tAssigned.id}`, {
      impact: 'DEPARTMENT',
    });
    expect(assigned.statusCode).toBe(200);
  });

  it('GET /tickets lists exactly the visible tickets (staff: all visible; clients: scope)', async () => {
    const listed = async (persona: Persona, query = '') => {
      const res = await apiAs(ctx, persona).get(`/tickets?search=${tag}&limit=100${query}`);
      expect(res.statusCode).toBe(200);
      const ids: string[] = res.json().items.map((t: { id: string }) => t.id);
      return ALL.filter((name) => ids.includes(tickets[name].id)).sort();
    };
    for (const [who, persona, visible] of matrix()) {
      if (persona.role === 'CLIENT') continue;
      expect(await listed(persona), who).toEqual([...visible].sort());
    }
    // Clients: tickets they requested by default, their organisation with scope=org.
    expect(await listed(w.clientX)).toEqual(['tX']);
    expect(await listed(w.clientX2)).toEqual(['tX2']);
    expect(await listed(w.clientX, '&scope=org')).toEqual(['tX', 'tX2']);
    expect(await listed(w.clientY, '&scope=org')).toEqual(['tAssigned', 'tY']);
  });

  it('staff-only endpoints: clients → 403', async () => {
    for (const url of ['/macros', '/teams', '/requesters']) {
      expect((await apiAs(ctx, w.clientX).get(url)).statusCode, url).toBe(403);
      expect((await apiAs(ctx, w.agentA).get(url)).statusCode, url).toBe(200);
    }
  });

  it('pending and unverified accounts → 403 everywhere; no token → 401', async () => {
    const id = tickets.tX.id;
    const calls: Array<[string, (p?: Persona) => ReturnType<ReturnType<typeof apiAs>['get']>]> = [
      ['list', (p) => apiAs(ctx, p).get('/tickets')],
      ['counts', (p) => apiAs(ctx, p).get('/tickets/counts')],
      ['detail', (p) => apiAs(ctx, p).get(`/tickets/${id}`)],
      ['messages', (p) => apiAs(ctx, p).get(`/tickets/${id}/messages`)],
      [
        'reply',
        (p) =>
          apiAs(ctx, p).post(`/tickets/${id}/messages`, {
            type: 'PUBLIC',
            body: 'x',
            clientTempId: randomUUID(),
          }),
      ],
      ['patch', (p) => apiAs(ctx, p).patch(`/tickets/${id}`, { status: 'SOLVED' })],
      ['form-context', (p) => apiAs(ctx, p).get('/tickets/form-context')],
      [
        'presign',
        (p) =>
          apiAs(ctx, p).post('/attachments/presign', {
            fileName: 'a.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
          }),
      ],
      ['download', (p) => apiAs(ctx, p).get(`/attachments/${randomUUID()}/download`)],
      ['macros', (p) => apiAs(ctx, p).get('/macros')],
      ['teams', (p) => apiAs(ctx, p).get('/teams')],
    ];
    for (const [name, call] of calls) {
      expect((await call(w.pending)).statusCode, `pending ${name}`).toBe(403);
      const unverified = await call(w.unverified);
      expect(unverified.statusCode, `unverified ${name}`).toBe(403);
      expect(unverified.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect((await call(undefined)).statusCode, `anonymous ${name}`).toBe(401);
    }
  });

  it('GET /teams: active teams with active staff members; GET /macros: global + own teams', async () => {
    const teams = (await apiAs(ctx, w.agentA).get('/teams')).json().items as Array<{
      id: string;
      members: Array<{ id: string; role: string }>;
    }>;
    const a = teams.find((t) => t.id === w.teamA.id);
    expect(a?.members.map((m) => m.id).sort()).toEqual(
      [w.agentA.id, w.agentA2.id, w.leadA.id].sort(), // the disabled agent is left out
    );
    expect(teams.some((t) => t.id === w.inactiveTeam.id)).toBe(false);

    const own = await ctx.prisma.macro.create({
      data: { key: `test-${rand()}`, teamId: w.teamA.id, titleEn: 'A only', bodyEn: 'Hi' },
    });
    const other = await ctx.prisma.macro.create({
      data: { key: `test-${rand()}`, teamId: w.teamB.id, titleEn: 'B only', bodyEn: 'Hi' },
    });
    const macroIds = async (p: Persona) =>
      (await apiAs(ctx, p).get('/macros')).json().items as Array<{
        id: string;
        teamId: string | null;
      }>;
    const forA = await macroIds(w.agentA);
    expect(forA.some((m) => m.id === own.id)).toBe(true);
    expect(forA.some((m) => m.id === other.id)).toBe(false);
    expect(forA.some((m) => m.teamId === null)).toBe(true); // seeded global macros
    const forAdmin = await macroIds(w.admin);
    expect(forAdmin.some((m) => m.id === other.id)).toBe(true);
  });
});
