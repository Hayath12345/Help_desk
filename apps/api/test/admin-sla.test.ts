import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { SlaPolicy } from '@loons/db';
import {
  slaPolicyListSchema,
  slaPolicyResponseSchema,
  ticketFormConfigSchema,
} from '@loons/shared';
import { businessDayMinutes } from '../src/services/ticket-config.service.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — SLA policies (spec §10.4; E12): super admins only, edit-only (four fixed rows), minutes
// ≥ 1 and at-risk 1–99, `expectedUpdatedAt` (409 stale), an audit row in the same transaction and
// `config:updated` scope `ticket-form` after commit. The P4 policy is the one edited (and restored):
// the policies are global rows of the shared dev database.

describe('admin SLA policies', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let original: SlaPolicy;
  let broadcast: MockInstance<(event: string, payload: unknown) => void>;

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const team = await f.team();
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    await f.member(team.id, tl.id, 'LEAD');
    superAdmin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, await f.staff({ staffDomain }));
    client = await persona(ctx, (await f.client()).user);
    original = await ctx.prisma.slaPolicy.findUniqueOrThrow({ where: { priority: 'P4' } });
    // Put P4 back exactly as it was, whatever a failing test left behind.
    f.onCleanup(() =>
      ctx.prisma.slaPolicy.update({
        where: { id: original.id },
        data: {
          firstReplyMins: original.firstReplyMins,
          resolveMins: original.resolveMins,
          businessHoursOnly: original.businessHoursOnly,
          atRiskPercent: original.atRiskPercent,
        },
      }),
    );
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(() => broadcast.mockClear());

  const current = () => ctx.prisma.slaPolicy.findUniqueOrThrow({ where: { priority: 'P4' } });
  const body = (row: SlaPolicy, changes: Record<string, unknown> = {}) => ({
    expectedUpdatedAt: row.updatedAt.toISOString(),
    firstReplyMins: row.firstReplyMins,
    resolveMins: row.resolveMins,
    businessHoursOnly: row.businessHoursOnly,
    atRiskPercent: row.atRiskPercent,
    ...changes,
  });
  const scopes = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);

  it('401 without a token; 403 for clients, agents and team leads (super admins only)', async () => {
    expect((await apiAs(ctx).get('/admin/sla')).statusCode).toBe(401);
    for (const who of [client, agent, teamLead]) {
      const api = apiAs(ctx, who);
      expect((await api.get('/admin/sla')).statusCode, who.role).toBe(403);
      const res = await api.patch('/admin/sla/P4', body(await current(), { atRiskPercent: 50 }));
      expect(res.statusCode, who.role).toBe(403);
    }
    expect((await current()).atRiskPercent).toBe(original.atRiskPercent);
  });

  it('lists the four policies in priority order with the configured business-day length', async () => {
    const res = await apiAs(ctx, superAdmin).get('/admin/sla');
    expect(res.statusCode).toBe(200);
    const list = slaPolicyListSchema.parse(res.json());
    expect(list.items.map((p) => p.priority)).toEqual(['P1', 'P2', 'P3', 'P4']);
    const hours = await ctx.prisma.businessHours.findMany();
    expect(list.businessDayMinutes).toBe(businessDayMinutes(hours));
    // The same length reaches the New Ticket form (labels, E12).
    const config = ticketFormConfigSchema.parse(
      (await apiAs(ctx, client).get('/config/ticket-form')).json(),
    );
    expect(config.businessDayMinutes).toBe(list.businessDayMinutes);
  });

  it('validates: minutes ≥ 1, at risk 1–99, a known priority, every field present', async () => {
    const api = apiAs(ctx, superAdmin);
    const row = await current();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ firstReplyMins: 0 }, 'validation.minutesMin'],
      [{ resolveMins: -5 }, 'validation.minutesMin'],
      [{ resolveMins: 1.5 }, ''],
      [{ firstReplyMins: 525_601 }, 'validation.tooLarge'],
      [{ atRiskPercent: 0 }, 'validation.atRiskPercent'],
      [{ atRiskPercent: 100 }, 'validation.atRiskPercent'],
    ];
    for (const [changes, message] of cases) {
      const res = await api.patch('/admin/sla/P4', body(row, changes));
      expect(res.statusCode, JSON.stringify(changes)).toBe(400);
      if (message) expect(JSON.stringify(res.json().error.details)).toContain(message);
    }
    const { businessHoursOnly: _, ...partial } = body(row);
    expect((await api.patch('/admin/sla/P4', partial)).statusCode).toBe(400);
    expect((await api.patch('/admin/sla/P9', body(row))).statusCode).toBe(400);
    expect((await current()).updatedAt).toEqual(row.updatedAt);
    expect(scopes()).toEqual([]);
  });

  it('saves the targets, writes one audit row with the changed fields, announces ticket-form', async () => {
    const api = apiAs(ctx, superAdmin);
    const before = await current();
    const version = await ctx.app.services.ticketConfig.currentVersion();
    const res = await api.patch(
      '/admin/sla/P4',
      body(before, {
        firstReplyMins: before.firstReplyMins + 7,
        atRiskPercent: before.atRiskPercent === 60 ? 61 : 60,
      }),
    );
    expect(res.statusCode).toBe(200);
    const { item } = slaPolicyResponseSchema.parse(res.json());
    expect(item).toMatchObject({
      priority: 'P4',
      firstReplyMins: before.firstReplyMins + 7,
      resolveMins: before.resolveMins,
    });
    const rows = await ctx.prisma.adminAuditLog.findMany({
      where: { entity: 'SlaPolicy', entityId: before.id, actorId: superAdmin.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'UPDATE',
      entityLabel: 'P4',
      before: { firstReplyMins: before.firstReplyMins, atRiskPercent: before.atRiskPercent },
      after: { firstReplyMins: before.firstReplyMins + 7, atRiskPercent: item.atRiskPercent },
    });
    expect(Object.keys(rows[0]!.after as object).sort()).toEqual([
      'atRiskPercent',
      'firstReplyMins',
    ]);
    expect(scopes()).toEqual(['ticket-form']);
    expect(await ctx.app.services.ticketConfig.currentVersion()).toBeGreaterThan(version ?? 0);
    // The New Ticket form sees the new target at once (the cache was dropped).
    const config = ticketFormConfigSchema.parse(
      (await apiAs(ctx, client).get('/config/ticket-form')).json(),
    );
    expect(config.slaPolicies.find((p) => p.priority === 'P4')?.firstReplyMins).toBe(
      before.firstReplyMins + 7,
    );

    // Saving the same values again changes nothing: no audit row, no announcement.
    broadcast.mockClear();
    const again = await api.patch('/admin/sla/P4', body(await current(), {}));
    expect(again.statusCode).toBe(200);
    expect(again.json().item.updatedAt).toBe(item.updatedAt);
    expect(
      await ctx.prisma.adminAuditLog.count({
        where: { entity: 'SlaPolicy', entityId: before.id, actorId: superAdmin.id },
      }),
    ).toBe(1);
    expect(scopes()).toEqual([]);
  });

  it('refuses a save that started from an older version: 409 stale, nothing written', async () => {
    const api = apiAs(ctx, superAdmin);
    const start = await current();
    const first = await api.patch(
      '/admin/sla/P4',
      body(start, { resolveMins: start.resolveMins + 1 }),
    );
    expect(first.statusCode).toBe(200);
    broadcast.mockClear();
    const second = await api.patch('/admin/sla/P4', body(start, { resolveMins: 999 }));
    expect(second.statusCode).toBe(409);
    expect(second.json().error.details).toMatchObject({
      reason: 'stale',
      currentUpdatedAt: first.json().item.updatedAt,
    });
    expect((await current()).resolveMins).toBe(start.resolveMins + 1);
    expect(scopes()).toEqual([]);
  });

  it('the audit row is part of the change: a failed audit insert leaves the policy as it was', async () => {
    const before = await current();
    // An actor id that is not a user: the audit row's foreign key fails inside the transaction.
    const ghost = {
      actor: {
        id: randomUUID(),
        role: 'SUPER_ADMIN' as const,
        status: 'ACTIVE' as const,
        orgId: null,
        teamIds: [],
        leadTeamIds: [],
        emailVerified: true,
      },
      requestId: `req-${rand()}`,
    };
    await expect(
      ctx.app.services.admin.sla.update(ghost, 'P4', {
        ...body(before, { atRiskPercent: before.atRiskPercent === 42 ? 43 : 42 }),
      }),
    ).rejects.toThrow();
    const after = await current();
    expect(after.atRiskPercent).toBe(before.atRiskPercent);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(scopes()).toEqual([]);
  });

  it('documents the routes in OpenAPI under the admin tag', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const list = doc.paths['/admin/sla'] ?? doc.paths['/admin/sla/'];
    expect(list?.get?.tags, Object.keys(doc.paths).join()).toEqual(['admin']);
    expect(doc.paths['/admin/sla/{priority}']?.patch?.tags).toEqual(['admin']);
  });
});
