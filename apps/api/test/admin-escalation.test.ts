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
import {
  escalationListSchema,
  escalationRuleResponseSchema,
  type EscalationRuleAdminDto,
} from '@loons/shared';
import { escalationWarnings } from '../src/services/admin/escalation.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';
import { testPhone } from './worker-helpers.ts';

// Admin — Escalation rules (spec §10.6; D3, E5, E13): super admins only; P1 chains, global and per
// team; ON_CALL / ROLE / USER targets with the matching field; channels; the step number is unique
// per chain across archived rules (409 duplicate + existingId: restore it); reorder renumbers the
// active rules 1…n and moves archived ones after them; warnings for TEAMS without a webhook, ON_CALL
// without an on-call user or phone, an inactive USER target or one without a phone for SMS.
// Writes go to test teams' own chains; the global chain (shared dev data) is only read, and
// refused writes are checked against it.

describe('admin escalation rules', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let bare: { id: string; nameEn: string }; // no webhook, no on-call user
  let ready: { id: string }; // webhook + on-call user with a phone
  let archivedTeam: { id: string };
  let phoned: { id: string };
  let noPhone: { id: string };
  let disabled: { id: string };
  let broadcast: MockInstance<(event: string, payload: unknown) => void>;

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    bare = await f.team();
    const readyTeam = await f.team();
    archivedTeam = await f.team();
    await ctx.prisma.team.update({ where: { id: archivedTeam.id }, data: { isActive: false } });
    phoned = await f.staff({ staffDomain });
    await ctx.prisma.user.update({ where: { id: phoned.id }, data: { phone: testPhone() } });
    noPhone = await f.staff({ staffDomain });
    disabled = await f.staff({ staffDomain, status: 'DISABLED' });
    await f.member(readyTeam.id, phoned.id);
    ready = await ctx.prisma.team.update({
      where: { id: readyTeam.id },
      data: {
        onCallUserId: phoned.id,
        teamsWebhookUrl: 'https://contoso.webhook.office.com/webhookb2/test',
      },
    });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    await f.member(bare.id, tl.id, 'LEAD');
    superAdmin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, await f.staff({ staffDomain }));
    client = await persona(ctx, (await f.client()).user);
    // Rules cascade with their team; their audit rows are the actor's (removed by the fixtures).
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(() => broadcast.mockClear());

  const scopes = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const api = () => apiAs(ctx, superAdmin);
  async function create(body: Record<string, unknown>): Promise<EscalationRuleAdminDto> {
    const res = await api().post('/admin/escalation', {
      afterMins: 0,
      channels: ['EMAIL'],
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return escalationRuleResponseSchema.parse(res.json()).item;
  }
  async function list(query = ''): Promise<EscalationRuleAdminDto[]> {
    const res = await api().get(`/admin/escalation${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return escalationListSchema.parse(res.json()).items;
  }
  async function freshTeam() {
    return ctx.fixtures.team();
  }

  it('401 without a token; 403 for clients, agents and team leads (even on their own team)', async () => {
    expect((await apiAs(ctx).get('/admin/escalation')).statusCode).toBe(401);
    const rule = await create({ teamId: bare.id, step: 1, targetType: 'ON_CALL' });
    for (const who of [client, agent, teamLead]) {
      const as = apiAs(ctx, who);
      expect((await as.get('/admin/escalation')).statusCode, who.role).toBe(403);
      expect(
        (
          await as.post('/admin/escalation', {
            teamId: bare.id,
            step: 9,
            targetType: 'ON_CALL',
            afterMins: 1,
            channels: ['EMAIL'],
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await as.patch(`/admin/escalation/${rule.id}`, {
            expectedUpdatedAt: rule.updatedAt,
            afterMins: 3,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await as.post(`/admin/escalation/${rule.id}/archive`, {
            expectedUpdatedAt: rule.updatedAt,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await as.post('/admin/escalation/reorder', {
            teamId: bare.id,
            expectedIds: [rule.id],
            ids: [rule.id],
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(await ctx.prisma.escalationRule.count({ where: { teamId: bare.id } })).toBe(1);
    await ctx.prisma.escalationRule.delete({ where: { id: rule.id } });
  });

  it('creates steps with warnings, an audit row and the escalation scope', async () => {
    const team = await freshTeam();
    const onCall = await create({
      teamId: team.id,
      step: 1,
      targetType: 'ON_CALL',
      channels: ['SMS', 'EMAIL', 'TEAMS'],
    });
    expect(onCall).toMatchObject({
      priority: 'P1',
      teamId: team.id,
      team: { id: team.id, isActive: true },
      step: 1,
      targetRole: null,
      targetUser: null,
      channels: ['EMAIL', 'TEAMS', 'SMS'],
      isActive: true,
    });
    expect(onCall.warnings.sort()).toEqual(['on_call_missing', 'teams_no_webhook']);
    expect(scopes()).toEqual(['escalation']);
    const audit = await ctx.prisma.adminAuditLog.findMany({ where: { entityId: onCall.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'CREATE',
      entity: 'EscalationRule',
      actorId: superAdmin.id,
      after: { step: 1, targetType: 'ON_CALL', teamId: team.id, afterMins: 0 },
    });

    const role = await create({
      teamId: team.id,
      step: 2,
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
      afterMins: 5,
    });
    expect(role).toMatchObject({ targetRole: 'TEAM_LEAD', warnings: [] });
    const user = await create({
      teamId: team.id,
      step: 3,
      targetType: 'USER',
      targetUserId: noPhone.id,
      afterMins: 15,
      channels: ['EMAIL', 'SMS'],
    });
    expect(user.targetUser).toMatchObject({ id: noPhone.id, isActive: true });
    expect(user.warnings).toEqual(['target_user_no_phone']);

    // A configured team gets no warnings.
    const fine = await create({
      teamId: ready.id,
      step: 1,
      targetType: 'ON_CALL',
      channels: ['EMAIL', 'TEAMS', 'SMS'],
    });
    expect(fine.warnings).toEqual([]);
    // An on-call user without a usable phone, when SMS is chosen.
    await ctx.prisma.user.update({ where: { id: phoned.id }, data: { phone: '5550 1234' } });
    const [warned] = (await list(`?teamId=${ready.id}`)).filter((r) => r.id === fine.id);
    expect(warned?.warnings).toEqual(['on_call_no_phone']);
    await ctx.prisma.user.update({ where: { id: phoned.id }, data: { phone: testPhone() } });

    // The list of one chain, in step order.
    expect((await list(`?teamId=${team.id}`)).map((r) => r.step)).toEqual([1, 2, 3]);
  });

  it('validates targets, channels, steps, delays, the team and the target user', async () => {
    const team = await freshTeam();
    const base = { teamId: team.id, step: 1, afterMins: 0, channels: ['EMAIL'] };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ targetType: 'ROLE' }, 'validation.targetMismatch'],
      [{ targetType: 'USER' }, 'validation.targetMismatch'],
      [{ targetType: 'ON_CALL', targetRole: 'TEAM_LEAD' }, 'validation.targetMismatch'],
      [{ targetType: 'ON_CALL', targetUserId: phoned.id }, 'validation.targetMismatch'],
      [{ targetType: 'ROLE', targetRole: 'AGENT' }, ''],
      [{ targetType: 'ON_CALL', channels: [] }, 'validation.required'],
      [{ targetType: 'ON_CALL', channels: ['EMAIL', 'EMAIL'] }, 'validation.duplicateValue'],
      [{ targetType: 'ON_CALL', channels: ['FAX'] }, ''],
      [{ targetType: 'ON_CALL', step: 0 }, ''],
      [{ targetType: 'ON_CALL', step: 21 }, ''],
      [{ targetType: 'ON_CALL', afterMins: -1 }, ''],
      [{ targetType: 'ON_CALL', afterMins: 10_081 }, 'validation.tooLarge'],
      [{ targetType: 'USER', targetUserId: disabled.id }, 'target_user'],
      [{ targetType: 'USER', targetUserId: client.id }, 'target_user'],
      [{ targetType: 'USER', targetUserId: randomUUID() }, 'target_user'],
      [{ targetType: 'ON_CALL', teamId: archivedTeam.id }, 'team'],
      [{ targetType: 'ON_CALL', teamId: randomUUID() }, 'team'],
    ];
    for (const [changes, expected] of cases) {
      const res = await api().post('/admin/escalation', { ...base, ...changes });
      expect(res.statusCode, JSON.stringify(changes)).toBe(400);
      if (expected) expect(JSON.stringify(res.json().error.details)).toContain(expected);
    }
    expect(await ctx.prisma.escalationRule.count({ where: { teamId: team.id } })).toBe(0);
    expect(scopes()).toEqual([]);
  });

  it('a taken step is 409 duplicate with the rule to restore (archived rules too)', async () => {
    const team = await freshTeam();
    const one = await create({ teamId: team.id, step: 1, targetType: 'ON_CALL' });
    const again = await api().post('/admin/escalation', {
      teamId: team.id,
      step: 1,
      targetType: 'ROLE',
      targetRole: 'SUPER_ADMIN',
      afterMins: 1,
      channels: ['EMAIL'],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details).toEqual({
      reason: 'duplicate',
      fields: ['step'],
      existingId: one.id,
      existingIsActive: true,
    });
    const archived = await api().post(`/admin/escalation/${one.id}/archive`, {
      expectedUpdatedAt: one.updatedAt,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().item.isActive).toBe(false);
    const onArchived = await api().post('/admin/escalation', {
      teamId: team.id,
      step: 1,
      targetType: 'ON_CALL',
      afterMins: 0,
      channels: ['EMAIL'],
    });
    expect(onArchived.statusCode).toBe(409);
    expect(onArchived.json().error.details).toMatchObject({
      existingId: one.id,
      existingIsActive: false,
    });
    const restored = await api().post(`/admin/escalation/${one.id}/restore`, {
      expectedUpdatedAt: archived.json().item.updatedAt,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().item.isActive).toBe(true);
    const actions = (
      await ctx.prisma.adminAuditLog.findMany({
        where: { entityId: one.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(['CREATE', 'ARCHIVE', 'RESTORE']);

    // The global chain's seeded step 1 is taken too (nothing is written there).
    const global = await list('?teamId=global&status=all');
    expect(global.every((r) => r.teamId === null && r.team === null)).toBe(true);
    const step1 = global.find((r) => r.step === 1);
    if (step1) {
      const dup = await api().post('/admin/escalation', {
        teamId: null,
        step: 1,
        targetType: 'ON_CALL',
        afterMins: 0,
        channels: ['EMAIL'],
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.details.existingId).toBe(step1.id);
    }
  });

  it('updates the target (the other field is cleared), delay and channels; stale is 409', async () => {
    const team = await freshTeam();
    const rule = await create({
      teamId: team.id,
      step: 1,
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
    });
    broadcast.mockClear();
    const res = await api().patch(`/admin/escalation/${rule.id}`, {
      expectedUpdatedAt: rule.updatedAt,
      targetType: 'USER',
      targetUserId: phoned.id,
      afterMins: 12,
      channels: ['SMS', 'EMAIL'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const item = escalationRuleResponseSchema.parse(res.json()).item;
    expect(item).toMatchObject({
      targetType: 'USER',
      targetRole: null,
      targetUser: { id: phoned.id },
      afterMins: 12,
      channels: ['EMAIL', 'SMS'],
    });
    expect(scopes()).toEqual(['escalation']);
    const audit = await ctx.prisma.adminAuditLog.findFirstOrThrow({
      where: { entityId: rule.id, action: 'UPDATE' },
    });
    expect(audit.before).toMatchObject({
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
      afterMins: 0,
    });
    expect(audit.after).toMatchObject({
      targetType: 'USER',
      targetUserId: phoned.id,
      afterMins: 12,
    });

    // A role on a USER rule, a USER type without a user: 400.
    for (const body of [{ targetRole: 'SUPER_ADMIN' }, { targetType: 'ROLE' }]) {
      const bad = await api().patch(`/admin/escalation/${rule.id}`, {
        expectedUpdatedAt: item.updatedAt,
        ...body,
      });
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await api().patch(`/admin/escalation/${rule.id}`, { expectedUpdatedAt: item.updatedAt }))
        .statusCode,
    ).toBe(400); // nothing to change
    // Switching to ON_CALL clears the user.
    broadcast.mockClear();
    const onCall = await api().patch(`/admin/escalation/${rule.id}`, {
      expectedUpdatedAt: item.updatedAt,
      targetType: 'ON_CALL',
    });
    expect(onCall.statusCode, onCall.body).toBe(200);
    expect(onCall.json().item).toMatchObject({ targetType: 'ON_CALL', targetUser: null });
    // From the old version: stale.
    const stale = await api().patch(`/admin/escalation/${rule.id}`, {
      expectedUpdatedAt: item.updatedAt,
      afterMins: 99,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.reason).toBe('stale');
    expect(scopes()).toEqual(['escalation']);
    // The same values again: no audit row, no announcement.
    broadcast.mockClear();
    const same = await api().patch(`/admin/escalation/${rule.id}`, {
      expectedUpdatedAt: onCall.json().item.updatedAt,
      afterMins: 12,
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().item.updatedAt).toBe(onCall.json().item.updatedAt);
    expect(scopes()).toEqual([]);
    expect(
      (
        await api().patch(`/admin/escalation/${randomUUID()}`, {
          expectedUpdatedAt: item.updatedAt,
          afterMins: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('reorder renumbers active steps 1…n, moves archived ones after them, and checks the order', async () => {
    const team = await freshTeam();
    const a = await create({ teamId: team.id, step: 1, targetType: 'ON_CALL' });
    const b = await create({
      teamId: team.id,
      step: 2,
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
      afterMins: 5,
    });
    const c = await create({
      teamId: team.id,
      step: 3,
      targetType: 'USER',
      targetUserId: phoned.id,
      afterMins: 15,
    });
    const bArchived = await api().post(`/admin/escalation/${b.id}/archive`, {
      expectedUpdatedAt: b.updatedAt,
    });
    broadcast.mockClear();
    // Someone else's view of the chain: 409 order_changed, nothing moves.
    const wrong = await api().post('/admin/escalation/reorder', {
      teamId: team.id,
      expectedIds: [a.id, b.id, c.id],
      ids: [c.id, b.id, a.id],
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.details.reason).toBe('order_changed');
    const res = await api().post('/admin/escalation/reorder', {
      teamId: team.id,
      expectedIds: [a.id, c.id],
      ids: [c.id, a.id],
    });
    expect(res.statusCode, res.body).toBe(204);
    const rows = await ctx.prisma.escalationRule.findMany({
      where: { teamId: team.id },
      orderBy: { step: 'asc' },
    });
    expect(rows.map((r) => [r.id, r.step, r.isActive])).toEqual([
      [c.id, 1, true],
      [a.id, 2, true],
      [b.id, 3, false],
    ]);
    // Each step keeps its time slot: c now fires at once, a after 15 (a changed delay moves
    // updatedAt); a rule only renumbered keeps it (an open edit sheet still saves).
    expect(rows.map((r) => r.afterMins)).toEqual([0, 15, 5]);
    expect(rows.find((r) => r.id === b.id)?.updatedAt.toISOString()).toBe(
      bArchived.json().item.updatedAt,
    );
    expect(scopes()).toEqual(['escalation']);
    const audit = await ctx.prisma.adminAuditLog.findFirstOrThrow({
      where: { entity: 'EscalationRule', entityId: team.id, action: 'REORDER' },
    });
    expect(audit).toMatchObject({
      before: { order: [a.id, c.id] },
      after: { order: [c.id, a.id] },
    });
    // Restoring b puts it back at the end of the chain, once its delay fits there (5 < 15: 400).
    const bRow = rows.find((r) => r.id === b.id)!;
    const early = await api().post(`/admin/escalation/${b.id}/restore`, {
      expectedUpdatedAt: bRow.updatedAt.toISOString(),
    });
    expect(early.statusCode).toBe(400);
    const later = await api().patch(`/admin/escalation/${b.id}`, {
      expectedUpdatedAt: bRow.updatedAt.toISOString(),
      afterMins: 30,
    });
    expect(later.statusCode, later.body).toBe(200);
    await api().post(`/admin/escalation/${b.id}/restore`, {
      expectedUpdatedAt: later.json().item.updatedAt,
    });
    expect((await list(`?teamId=${team.id}`)).map((r) => r.id)).toEqual([c.id, a.id, b.id]);
    // The same order again: 204 and nothing announced.
    broadcast.mockClear();
    const same = await api().post('/admin/escalation/reorder', {
      teamId: team.id,
      expectedIds: [c.id, a.id, b.id],
      ids: [c.id, a.id, b.id],
    });
    expect(same.statusCode).toBe(204);
    expect(scopes()).toEqual([]);

    // The global chain: a stale order is refused and nothing changes there.
    const global = await ctx.prisma.escalationRule.findMany({
      where: { teamId: null, priority: 'P1' },
      orderBy: { step: 'asc' },
    });
    const bogus = await api().post('/admin/escalation/reorder', {
      teamId: null,
      expectedIds: [randomUUID()],
      ids: [randomUUID()],
    });
    expect(bogus.statusCode).toBe(400); // ids must be a permutation of expectedIds
    const id = randomUUID();
    const refused = await api().post('/admin/escalation/reorder', {
      teamId: null,
      expectedIds: [id],
      ids: [id],
    });
    expect(refused.statusCode).toBe(409);
    expect(
      await ctx.prisma.escalationRule.findMany({
        where: { teamId: null, priority: 'P1' },
        orderBy: { step: 'asc' },
      }),
    ).toEqual(global);
  });

  it('a failed audit insert leaves no rule behind (same transaction)', async () => {
    const team = await freshTeam();
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
      ctx.app.services.admin.escalation.create(ghost, {
        teamId: team.id,
        step: 1,
        targetType: 'ON_CALL',
        targetRole: null,
        targetUserId: null,
        afterMins: 0,
        channels: ['EMAIL'],
      }),
    ).rejects.toThrow();
    expect(await ctx.prisma.escalationRule.count({ where: { teamId: team.id } })).toBe(0);
    expect(scopes()).toEqual([]);
  });

  describe('warnings of a global rule (the teams that follow the global chain)', () => {
    const facts = (
      entries: Array<
        [
          string,
          Partial<{
            hasWebhook: boolean;
            onCall: { phoneValid: boolean } | null;
            usesGlobalChain: boolean;
          }>,
        ]
      >,
    ) =>
      new Map(
        entries.map(([id, f]) => [
          id,
          { id, hasWebhook: true, onCall: { phoneValid: true }, usesGlobalChain: true, ...f },
        ]),
      );
    const rule = (overrides: Record<string, unknown> = {}) => ({
      teamId: null,
      targetType: 'ON_CALL' as const,
      channels: ['EMAIL', 'TEAMS', 'SMS'] as Array<'EMAIL' | 'TEAMS' | 'SMS'>,
      targetUser: null,
      ...overrides,
    });

    it('warns when any team on the global chain lacks a webhook / on-call user / phone', () => {
      expect(
        escalationWarnings(
          rule(),
          facts([
            ['a', {}],
            ['b', {}],
          ]),
        ),
      ).toEqual([]);
      expect(
        escalationWarnings(
          rule(),
          facts([
            ['a', {}],
            ['b', { hasWebhook: false }],
          ]),
        ),
      ).toEqual(['teams_no_webhook']);
      expect(escalationWarnings(rule(), facts([['a', { onCall: null }]]))).toEqual([
        'on_call_missing',
      ]);
      expect(escalationWarnings(rule(), facts([['a', { onCall: { phoneValid: false } }]]))).toEqual(
        ['on_call_no_phone'],
      );
      // Without SMS the phone does not matter; teams with their own chain are not counted.
      expect(
        escalationWarnings(
          rule({ channels: ['EMAIL'] }),
          facts([['a', { onCall: { phoneValid: false } }]]),
        ),
      ).toEqual([]);
      expect(
        escalationWarnings(
          rule(),
          facts([['a', { onCall: null, hasWebhook: false, usesGlobalChain: false }]]),
        ),
      ).toEqual([]);
    });

    it('checks a USER target itself: disabled or not staff, or no phone for SMS', () => {
      const user = (u: Record<string, unknown>) =>
        rule({
          targetType: 'USER',
          targetUser: { status: 'ACTIVE', role: 'AGENT', phone: '+97455501000', ...u },
        });
      expect(escalationWarnings(user({}), new Map())).toEqual([]);
      expect(escalationWarnings(user({ status: 'DISABLED' }), new Map())).toEqual([
        'target_user_inactive',
      ]);
      expect(escalationWarnings(user({ role: 'CLIENT' }), new Map())).toEqual([
        'target_user_inactive',
      ]);
      expect(escalationWarnings(rule({ targetType: 'USER', targetUser: null }), new Map())).toEqual(
        ['target_user_inactive'],
      );
      expect(escalationWarnings(user({ phone: '5550' }), new Map())).toEqual([
        'target_user_no_phone',
      ]);
    });
  });
});
