import { randomUUID } from 'node:crypto';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { Role } from '@loons/shared';
import { mintToken, randomIp, testEmail, type TestContext } from './helpers.ts';

// A self-contained ticket world for the Phase 2 tests: two test teams with their own categories,
// two client organisations with sites, and one persona per role. Everything is created with
// unique keys and removed by the fixtures' cleanup.

export interface Persona {
  id: string;
  name: string;
  email: string;
  role: Role;
  token: string;
}

export interface Api {
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown): Promise<LightMyRequestResponse>;
}

/** HTTP calls as `persona` (a random source address, so the global per-IP limit never trips). */
export function apiAs(ctx: TestContext, persona?: Pick<Persona, 'token'> | null): Api {
  const headers: Record<string, string> = persona
    ? { authorization: `Bearer ${persona.token}` }
    : {};
  const send = (method: InjectOptions['method'], url: string, body?: unknown) =>
    ctx.app.inject({
      method,
      url,
      headers,
      remoteAddress: randomIp(),
      ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
    });
  return {
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, body ?? {}),
    patch: (url, body) => send('PATCH', url, body ?? {}),
  };
}

export async function persona(
  ctx: TestContext,
  user: { id: string; name: string; email: string; role: Role },
): Promise<Persona> {
  return { ...user, token: await mintToken(ctx.config, { sub: user.id, role: user.role }) };
}

export async function createWorld(ctx: TestContext) {
  const f = ctx.fixtures;
  const staffDomain = ctx.config.staffEmailDomain;

  const teamA = await f.team();
  const teamB = await f.team();
  const inactiveTeam = await ctx.prisma.team.update({
    where: { id: (await f.team()).id },
    data: { isActive: false },
  });

  const catA = await f.category({
    teamId: teamA.id,
    subtypes: [
      { defaultPriority: 'P3' },
      { defaultPriority: 'P1' },
      { defaultPriority: 'P2' },
      { defaultPriority: 'P4' },
      { defaultPriority: 'P3', isActive: false },
    ],
  });
  const catB = await f.category({ teamId: teamB.id, subtypes: [{ defaultPriority: 'P2' }] });
  const catArchived = await f.category({ teamId: teamA.id, isActive: false });

  // Org X: two clients; org Y: one client.
  const x = await f.client({ name: 'Xena Client' });
  const orgX = x.org;
  const clientX2User = await f.user({
    email: testEmail(x.domain),
    orgId: orgX.id,
    name: 'Xavier Client',
  });
  const unverifiedUser = await f.user({
    email: testEmail(x.domain),
    orgId: orgX.id,
    emailVerified: false,
  });
  const y = await f.client({ name: 'Yusuf Client' });
  const orgY = y.org;
  const siteX1 = await f.site(orgX.id, { name: 'X HQ' });
  const siteX2 = await f.site(orgX.id, { name: 'X Branch' });
  const siteXArchived = await f.site(orgX.id, { isActive: false });
  const siteY1 = await f.site(orgY.id, { name: 'Y HQ' });

  const agentAUser = await f.staff({ staffDomain, name: 'Alice Agent' });
  await f.member(teamA.id, agentAUser.id);
  const agentA2User = await f.staff({ staffDomain, name: 'Aaron Agent' });
  await f.member(teamA.id, agentA2User.id);
  const agentBUser = await f.staff({ staffDomain, name: 'Bob Agent' });
  await f.member(teamB.id, agentBUser.id);
  const leadAUser = await f.staff({ staffDomain, role: 'TEAM_LEAD', name: 'Lena Lead' });
  await f.member(teamA.id, leadAUser.id, 'LEAD');
  const adminUser = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Ada Admin' });
  const disabledAgentUser = await f.staff({ staffDomain, status: 'DISABLED' });
  await f.member(teamA.id, disabledAgentUser.id);
  const pendingUser = await f.user({ status: 'PENDING_APPROVAL' });

  // Fresh config for this context (the fixtures were created after nothing was cached, but be sure).
  await ctx.app.services.ticketConfig.invalidate();

  const p = (u: { id: string; name: string; email: string; role: Role }) => persona(ctx, u);
  return {
    teamA,
    teamB,
    inactiveTeam,
    catA,
    catB,
    catArchived,
    orgX,
    orgY,
    siteX1,
    siteX2,
    siteXArchived,
    siteY1,
    clientX: await p(x.user),
    clientX2: await p(clientX2User),
    clientY: await p(y.user),
    unverified: await p(unverifiedUser),
    agentA: await p(agentAUser),
    agentA2: await p(agentA2User),
    agentB: await p(agentBUser),
    leadA: await p(leadAUser),
    admin: await p(adminUser),
    disabledAgent: disabledAgentUser,
    pending: await p(pendingUser),
    /** Another client of org X (per-user rate limits: spread heavy tests over several). */
    newClientX: async (name = 'Extra Client') =>
      p(await f.user({ email: testEmail(x.domain), orgId: orgX.id, name })),
  };
}

export type World = Awaited<ReturnType<typeof createWorld>>;

/** A valid POST /tickets body for org X in category A (override anything). */
export function ticketBody(w: World, overrides: Record<string, unknown> = {}) {
  return {
    type: 'INCIDENT',
    categoryId: w.catA.category.id,
    subtypeId: w.catA.subtypes[0]!.id,
    impact: 'SINGLE_USER',
    siteId: w.siteX1.id,
    subject: `Test ticket ${randomUUID().slice(0, 8)}`,
    description: 'The access door on level 2 does not open with a valid card.',
    ...overrides,
  };
}

/** Creates a ticket through the API and returns its detail DTO. */
export async function createTicket(
  ctx: TestContext,
  as: Persona,
  body: Record<string, unknown>,
): Promise<{ id: string; number: number; ref: string; [key: string]: unknown }> {
  const res = await apiAs(ctx, as).post('/tickets', body);
  if (res.statusCode !== 201) {
    throw new Error(`create ticket failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().ticket;
}

/** Posts a message; returns the response. */
export function postMessage(
  ctx: TestContext,
  as: Persona,
  ticketId: string,
  body: Record<string, unknown>,
) {
  return apiAs(ctx, as).post(`/tickets/${ticketId}/messages`, {
    type: 'PUBLIC',
    clientTempId: randomUUID(),
    ...body,
  });
}
