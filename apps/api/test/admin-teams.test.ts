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
import { teamAdminListSchema, teamMemberResponseSchema, teamResponseSchema } from '@loons/shared';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Teams & members (spec §10.3; E5, E7, E17, E18, E19): every route × role (a team lead on
// another team, super-admin-only fields), validation, archive guards, stale 409, audit rows, the
// masked Teams webhook, principal invalidation on member changes and the `teams` scope broadcast.

const WEBHOOK = 'https://contoso.webhook.office.com/webhookb2/SECRET-TOKEN-123';

describe('admin teams', () => {
  let ctx: TestContext;
  let admin: Persona;
  let lead: Persona;
  let agent: Persona;
  let client: Persona;
  let teamA: { id: string };
  let teamB: { id: string };
  let memberWithPhone: { id: string; name: string };
  let memberNoPhone: { id: string };
  let outsider: { id: string; name: string };
  let broadcast: MockInstance;
  let invalidate: MockInstance;

  const scopesSent = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });
  const teamRow = (id: string) => ctx.prisma.team.findUniqueOrThrow({ where: { id } });

  // Names of teams a refused request must not create (removed in cleanup if a bug creates them).
  const refused = (name: string) => `${name} ${runTag}`;
  const runTag = rand(4);

  beforeAll(async () => {
    ctx = await createTestContext();
    ctx.fixtures.onCleanup(() =>
      ctx.prisma.team.deleteMany({ where: { nameEn: { endsWith: ` ${runTag}` } } }),
    );
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    teamA = await f.team();
    teamB = await f.team();
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Sam Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD', name: 'Tia Lead' });
    const ag = await f.staff({ staffDomain, name: 'Ali Agent' });
    memberWithPhone = await f.staff({ staffDomain, name: 'Mona Member' });
    memberNoPhone = await f.staff({ staffDomain, name: 'Nabil Nophone' });
    outsider = await f.staff({ staffDomain, name: 'Omar Outsider' });
    await ctx.prisma.user.updateMany({
      where: { id: { in: [memberWithPhone.id, outsider.id] } },
      data: { phone: '+97455501234' },
    });
    await f.member(teamA.id, tl.id, 'LEAD');
    await f.member(teamA.id, memberWithPhone.id);
    await f.member(teamA.id, memberNoPhone.id);
    await f.member(teamB.id, ag.id);
    admin = await persona(ctx, sa);
    lead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, (await f.client()).user);
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
    invalidate = vi.spyOn(ctx.app.principals, 'invalidate');
  });
  beforeEach(() => {
    broadcast.mockClear();
    invalidate.mockClear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  describe('GET /admin/teams', () => {
    it('401 without a token; 403 for agents and clients', async () => {
      expect((await apiAs(ctx).get('/admin/teams')).statusCode).toBe(401);
      for (const who of [agent, client]) {
        expect((await apiAs(ctx, who).get('/admin/teams')).statusCode).toBe(403);
      }
    });

    it('super admins see every team with members, counts and a masked webhook', async () => {
      await ctx.prisma.team.update({ where: { id: teamA.id }, data: { teamsWebhookUrl: WEBHOOK } });
      const res = await apiAs(ctx, admin).get('/admin/teams?status=all');
      expect(res.statusCode).toBe(200);
      const { items } = teamAdminListSchema.parse(res.json());
      const a = items.find((t) => t.id === teamA.id);
      expect(items.some((t) => t.id === teamB.id)).toBe(true);
      expect(a?.teamsWebhook).toEqual({ configured: true, host: 'contoso.webhook.office.com' });
      expect(a?.members.map((m) => [m.name, m.memberRole])).toEqual([
        ['Tia Lead', 'LEAD'],
        ['Mona Member', 'MEMBER'],
        ['Nabil Nophone', 'MEMBER'],
      ]);
      expect(a?.members.find((m) => m.name === 'Mona Member')).toMatchObject({
        hasPhone: true,
        phoneValid: true,
      });
      expect(res.body).not.toContain('SECRET-TOKEN');
      expect(res.body).not.toContain('+97455501234');
      await ctx.prisma.team.update({ where: { id: teamA.id }, data: { teamsWebhookUrl: null } });
    });

    it('team leads see only the teams they lead (E7)', async () => {
      for (const status of ['active', 'all', 'archived']) {
        const res = await apiAs(ctx, lead).get(`/admin/teams?status=${status}`);
        expect(res.statusCode).toBe(200);
        const ids = teamAdminListSchema.parse(res.json()).items.map((t) => t.id);
        expect(ids).toEqual(status === 'archived' ? [] : [teamA.id]);
      }
    });
  });

  describe('POST /admin/teams', () => {
    it('creates a team: key from the English name, emails lower-cased and de-duplicated, webhook host only', async () => {
      const name = `Night Shift ${rand(3)}`;
      const res = await apiAs(ctx, admin).post('/admin/teams', {
        nameEn: name,
        nameAr: 'النوبة الليلية',
        emails: ['Ops@Example.com', 'ops@example.com', 'noc@example.com'],
        teamsWebhookUrl: WEBHOOK,
      });
      expect(res.statusCode).toBe(201);
      const { item } = teamResponseSchema.parse(res.json());
      ctx.fixtures.trackTeam(item.id);
      expect(item.key).toBe(name.toLowerCase().replace(/ /g, '-'));
      expect(item.emails).toEqual(['ops@example.com', 'noc@example.com']);
      expect(item.teamsWebhook).toEqual({ configured: true, host: 'contoso.webhook.office.com' });
      expect(res.body).not.toContain('SECRET-TOKEN');
      expect((await teamRow(item.id)).teamsWebhookUrl).toBe(WEBHOOK);
      const [row] = await auditRows(item.id);
      expect(row).toMatchObject({
        action: 'CREATE',
        entity: 'Team',
        actorId: admin.id,
        entityLabel: name,
        after: { teamsWebhookHost: 'contoso.webhook.office.com', nameEn: name },
      });
      expect(JSON.stringify(row)).not.toContain('SECRET-TOKEN');
      expect(scopesSent()).toEqual(['teams']);
      // Super admins join the rooms of every active team: re-synced.
      expect(invalidate).toHaveBeenCalledWith(admin.id);
    });

    it('refuses a webhook host outside TEAMS_WEBHOOK_HOSTS and non-https URLs (400)', async () => {
      const bad = await apiAs(ctx, admin).post('/admin/teams', {
        nameEn: refused('Bad hook'),
        teamsWebhookUrl: 'https://evil.example.com/hook',
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.details).toEqual([
        expect.objectContaining({
          path: ['teamsWebhookUrl'],
          code: 'teams_webhook_host',
          message: 'validation.webhookHost',
        }),
      ]);
      const http = await apiAs(ctx, admin).post('/admin/teams', {
        nameEn: refused('Bad hook'),
        teamsWebhookUrl: 'http://contoso.webhook.office.com/x',
      });
      expect(http.statusCode).toBe(400);
      expect(JSON.stringify(http.json().error.details)).toContain('validation.webhookUrl');
      const invalidEmail = await apiAs(ctx, admin).post('/admin/teams', {
        nameEn: refused('Bad list'),
        emails: ['not-an-email'],
      });
      expect(invalidEmail.statusCode).toBe(400);
      expect(
        await ctx.prisma.team.count({
          where: { nameEn: { in: [refused('Bad hook'), refused('Bad list')] } },
        }),
      ).toBe(0);
    });

    it('409 duplicate for a taken key; team leads may not create teams', async () => {
      const taken = await teamRow(teamA.id);
      const dup = await apiAs(ctx, admin).post('/admin/teams', {
        key: taken.key,
        nameEn: refused('Dup'),
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.details).toMatchObject({ reason: 'duplicate', fields: ['key'] });
      expect(
        (await apiAs(ctx, lead).post('/admin/teams', { nameEn: refused('Mine') })).statusCode,
      ).toBe(403);
    });

    it('super-admin-only routes refuse team leads before reading the body (403, never 400)', async () => {
      const as = apiAs(ctx, lead);
      const member = `/admin/teams/${teamA.id}/members/${crypto.randomUUID()}`;
      const calls = [
        as.post('/admin/teams', {}),
        as.post('/admin/teams/reorder', {}),
        as.post(`/admin/teams/${teamA.id}/archive`, {}),
        as.post(`/admin/teams/${teamA.id}/restore`, {}),
        as.patch(member, {}),
        as.post('/admin/teams', { nameEn: 42 }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('PATCH /admin/teams/:id', () => {
    it('team leads get 403, never 400, for super-admin fields, other teams and LEAD rows (E7)', async () => {
      const as = apiAs(ctx, lead);
      const now = new Date().toISOString();
      const calls = [
        as.patch(`/admin/teams/${teamA.id}`, {
          expectedUpdatedAt: now,
          teamsWebhookUrl: 'http://10.0.0.1/x',
        }),
        as.patch(`/admin/teams/${teamA.id}`, { expectedUpdatedAt: now, emails: ['nope'] }),
        as.patch(`/admin/teams/${teamA.id}`, { expectedUpdatedAt: now, nameEn: '' }),
        as.patch(`/admin/teams/${teamA.id}`, { nameAr: 42 }),
        as.patch(`/admin/teams/${teamB.id}`, { expectedUpdatedAt: 'x', onCallUserId: 'nope' }),
        as.patch('/admin/teams/not-a-team', { onCallUserId: null }),
        as.post(`/admin/teams/${teamA.id}/members`, { userId: 'x', memberRole: 'LEAD' }),
        as.post(`/admin/teams/${teamB.id}/members`, { userId: 'x' }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      // What they may send is still validated as usual.
      const ownField = await as.patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt: now,
        onCallUserId: 'nope',
      });
      expect(ownField.statusCode).toBe(400);
      const ownMember = await as.post(`/admin/teams/${teamA.id}/members`, { userId: 'x' });
      expect(ownMember.statusCode).toBe(400);
      expect((await teamRow(teamA.id)).teamsWebhookUrl).toBeNull();
    });

    it('super admins rename; a stale expectedUpdatedAt is 409 and changes nothing', async () => {
      const team = await ctx.fixtures.team();
      const start = await teamRow(team.id);
      const res = await apiAs(ctx, admin).patch(`/admin/teams/${team.id}`, {
        expectedUpdatedAt: start.updatedAt.toISOString(),
        nameEn: 'Renamed',
        nameAr: 'معاد تسميته',
        teamsWebhookUrl: WEBHOOK,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item).toMatchObject({ nameEn: 'Renamed', nameAr: 'معاد تسميته' });
      expect(scopesSent()).toEqual(['teams']);
      const [row] = await auditRows(team.id);
      expect(row).toMatchObject({
        action: 'UPDATE',
        before: { nameEn: start.nameEn, nameAr: start.nameAr, teamsWebhookHost: null },
        after: {
          nameEn: 'Renamed',
          nameAr: 'معاد تسميته',
          teamsWebhookHost: 'contoso.webhook.office.com',
        },
      });
      broadcast.mockClear();
      const stale = await apiAs(ctx, admin).patch(`/admin/teams/${team.id}`, {
        expectedUpdatedAt: start.updatedAt.toISOString(),
        nameEn: 'Lost update',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details).toMatchObject({ reason: 'stale' });
      expect((await teamRow(team.id)).nameEn).toBe('Renamed');
      expect(await auditRows(team.id)).toHaveLength(1);
      expect(scopesSent()).toEqual([]);
      // null clears the webhook; omitted leaves it.
      const current = await teamRow(team.id);
      const cleared = await apiAs(ctx, admin).patch(`/admin/teams/${team.id}`, {
        expectedUpdatedAt: current.updatedAt.toISOString(),
        teamsWebhookUrl: null,
      });
      expect(cleared.json().item.teamsWebhook).toEqual({ configured: false, host: null });
      const nothing = await apiAs(ctx, admin).patch(`/admin/teams/${team.id}`, {
        expectedUpdatedAt: (await teamRow(team.id)).updatedAt.toISOString(),
      });
      expect(nothing.statusCode).toBe(400);
    });

    it('team leads set the on-call user of their team (a member with an E.164 phone) and nothing else', async () => {
      const start = await teamRow(teamA.id);
      const expectedUpdatedAt = start.updatedAt.toISOString();
      const settings = await apiAs(ctx, lead).patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt,
        nameEn: 'Mine now',
      });
      expect(settings.statusCode).toBe(403);
      const withOnCall = await apiAs(ctx, lead).patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt,
        onCallUserId: memberWithPhone.id,
        emails: ['x@example.com'],
      });
      expect(withOnCall.statusCode).toBe(403);
      const notMember = await apiAs(ctx, lead).patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt,
        onCallUserId: outsider.id,
      });
      expect(notMember.statusCode).toBe(400);
      expect(notMember.json().error.details[0]).toMatchObject({
        path: ['onCallUserId'],
        message: 'validation.onCallMember',
      });
      const noPhone = await apiAs(ctx, lead).patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt,
        onCallUserId: memberNoPhone.id,
      });
      expect(noPhone.statusCode).toBe(400);
      expect(noPhone.json().error.details[0].message).toBe('validation.onCallPhone');
      const ok = await apiAs(ctx, lead).patch(`/admin/teams/${teamA.id}`, {
        expectedUpdatedAt,
        onCallUserId: memberWithPhone.id,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().item.onCallUser).toEqual({
        id: memberWithPhone.id,
        name: 'Mona Member',
        phoneValid: true,
        isMember: true,
        isActive: true,
      });
      const [row] = await auditRows(teamA.id);
      expect(row).toMatchObject({
        actorId: lead.id,
        before: { onCallUserId: null },
        after: { onCallUserId: memberWithPhone.id },
      });
    });

    it('a team lead is refused on a team they do not lead (403)', async () => {
      const b = await teamRow(teamB.id);
      const res = await apiAs(ctx, lead).patch(`/admin/teams/${teamB.id}`, {
        expectedUpdatedAt: b.updatedAt.toISOString(),
        onCallUserId: null,
      });
      expect(res.statusCode).toBe(403);
    });

    it('404 for an unknown team', async () => {
      const res = await apiAs(ctx, admin).patch(`/admin/teams/${crypto.randomUUID()}`, {
        expectedUpdatedAt: new Date().toISOString(),
        nameEn: 'Ghost',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('members', () => {
    it('team leads add and remove MEMBER rows of their team; the principal is invalidated', async () => {
      const added = await apiAs(ctx, lead).post(`/admin/teams/${teamA.id}/members`, {
        userId: outsider.id,
      });
      expect(added.statusCode).toBe(201);
      expect(teamMemberResponseSchema.parse(added.json()).item).toMatchObject({
        userId: outsider.id,
        memberRole: 'MEMBER',
        phoneValid: true,
      });
      expect(invalidate).toHaveBeenCalledWith(outsider.id);
      expect(scopesSent()).toEqual(['teams']);
      const principal = await ctx.app.principals.load(outsider.id);
      expect(principal?.teams).toContainEqual({ teamId: teamA.id, role: 'MEMBER' });
      const [row] = await auditRows(`${teamA.id}:${outsider.id}`);
      expect(row).toMatchObject({
        action: 'CREATE',
        entity: 'TeamMember',
        actorId: lead.id,
        entityLabel: expect.stringContaining('Omar Outsider'),
      });

      const dup = await apiAs(ctx, lead).post(`/admin/teams/${teamA.id}/members`, {
        userId: outsider.id,
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.details).toMatchObject({ reason: 'duplicate' });

      invalidate.mockClear();
      const removed = await apiAs(ctx, lead).delete(
        `/admin/teams/${teamA.id}/members/${outsider.id}`,
      );
      expect(removed.statusCode).toBe(200);
      expect(invalidate).toHaveBeenCalledWith(outsider.id);
      expect(
        await ctx.prisma.teamMember.count({ where: { teamId: teamA.id, userId: outsider.id } }),
      ).toBe(0);
      const rows = await auditRows(`${teamA.id}:${outsider.id}`);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
      expect((await ctx.app.principals.load(outsider.id))?.teams).toEqual([]);
    });

    it('LEAD rows, other teams and role changes are super admin only (E7)', async () => {
      const leadRow = await apiAs(ctx, lead).post(`/admin/teams/${teamA.id}/members`, {
        userId: outsider.id,
        memberRole: 'LEAD',
      });
      expect(leadRow.statusCode).toBe(403);
      const otherTeam = await apiAs(ctx, lead).post(`/admin/teams/${teamB.id}/members`, {
        userId: outsider.id,
      });
      expect(otherTeam.statusCode).toBe(403);
      const removeLead = await apiAs(ctx, lead).delete(
        `/admin/teams/${teamA.id}/members/${lead.id}`,
      );
      expect(removeLead.statusCode).toBe(403);
      const promote = await apiAs(ctx, lead).patch(
        `/admin/teams/${teamA.id}/members/${memberNoPhone.id}`,
        { memberRole: 'LEAD' },
      );
      expect(promote.statusCode).toBe(403);
      expect(await ctx.prisma.teamMember.count({ where: { userId: outsider.id } })).toBe(0);

      const byAdmin = await apiAs(ctx, admin).patch(
        `/admin/teams/${teamA.id}/members/${memberNoPhone.id}`,
        {
          expectedUpdatedAt: (await teamRow(teamA.id)).updatedAt.toISOString(),
          memberRole: 'LEAD',
        },
      );
      expect(byAdmin.statusCode).toBe(200);
      expect(byAdmin.json().item.memberRole).toBe('LEAD');
      expect(invalidate).toHaveBeenCalledWith(memberNoPhone.id);
      const [row] = await auditRows(`${teamA.id}:${memberNoPhone.id}`);
      expect(row).toMatchObject({
        action: 'UPDATE',
        before: { memberRole: 'MEMBER' },
        after: { memberRole: 'LEAD' },
      });
      await apiAs(ctx, admin).patch(`/admin/teams/${teamA.id}/members/${memberNoPhone.id}`, {
        expectedUpdatedAt: (await teamRow(teamA.id)).updatedAt.toISOString(),
        memberRole: 'MEMBER',
      });
    });

    it('a role change sends the team’s updatedAt (E19): a stale one is 409 and changes nothing', async () => {
      const team = await ctx.fixtures.team();
      await ctx.fixtures.member(team.id, outsider.id);
      const url = `/admin/teams/${team.id}/members/${outsider.id}`;
      const start = (await teamRow(team.id)).updatedAt.toISOString();
      const missing = await apiAs(ctx, admin).patch(url, { memberRole: 'LEAD' });
      expect(missing.statusCode).toBe(400);
      const first = await apiAs(ctx, admin).patch(url, {
        expectedUpdatedAt: start,
        memberRole: 'LEAD',
      });
      expect(first.statusCode).toBe(200);
      // The role change moves the team's version, so a view of the team older than it is stale.
      const moved = (await teamRow(team.id)).updatedAt.toISOString();
      expect(moved).not.toBe(start);
      // The answer carries the team's new version: the open sheet carries on from its own write.
      expect(first.json()).toMatchObject({ item: { memberRole: 'LEAD' }, teamUpdatedAt: moved });
      // Nothing to change: the current version, unmoved.
      const same = await apiAs(ctx, admin).patch(url, {
        expectedUpdatedAt: moved,
        memberRole: 'LEAD',
      });
      expect(same.statusCode).toBe(200);
      expect(same.json().teamUpdatedAt).toBe(moved);
      const stale = await apiAs(ctx, admin).patch(url, {
        expectedUpdatedAt: start,
        memberRole: 'MEMBER',
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details).toMatchObject({ reason: 'stale' });
      expect(
        await ctx.prisma.teamMember.findUniqueOrThrow({
          where: { teamId_userId: { teamId: team.id, userId: outsider.id } },
        }),
      ).toMatchObject({ role: 'LEAD' });
      expect(await auditRows(`${team.id}:${outsider.id}`)).toHaveLength(1);
      await ctx.prisma.teamMember.deleteMany({ where: { teamId: team.id } });
    });

    it('only active staff can be added (400), unknown members are 404', async () => {
      const res = await apiAs(ctx, admin).post(`/admin/teams/${teamB.id}/members`, {
        userId: client.id,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0]).toMatchObject({
        path: ['userId'],
        message: 'validation.activeStaff',
      });
      const missing = await apiAs(ctx, admin).delete(
        `/admin/teams/${teamB.id}/members/${outsider.id}`,
      );
      expect(missing.statusCode).toBe(404);
    });

    it('the on-call member cannot be removed until someone else is on call', async () => {
      const team = await ctx.fixtures.team();
      await ctx.fixtures.member(team.id, outsider.id);
      await ctx.prisma.team.update({ where: { id: team.id }, data: { onCallUserId: outsider.id } });
      const res = await apiAs(ctx, admin).delete(`/admin/teams/${team.id}/members/${outsider.id}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details).toMatchObject({
        reason: 'guard',
        guard: 'member_is_on_call',
      });
      expect(await auditRows(`${team.id}:${outsider.id}`)).toEqual([]);
      await ctx.prisma.team.update({ where: { id: team.id }, data: { onCallUserId: null } });
      await ctx.prisma.teamMember.deleteMany({ where: { teamId: team.id } });
    });
  });

  describe('archive / restore (E5)', () => {
    it('refuses while categories route to it, tickets are open or escalation rules are active', async () => {
      const f = ctx.fixtures;
      const team = await f.team();
      const { category, subtypes } = await f.category({ teamId: team.id });
      const { user, org } = await f.client();
      const site = await f.site(org.id);
      const requester = await persona(ctx, user);
      const ticket = await apiAs(ctx, requester).post('/tickets', {
        type: 'INCIDENT',
        categoryId: category.id,
        subtypeId: subtypes[0]!.id,
        impact: 'SINGLE_USER',
        siteId: site.id,
        subject: 'Door fault on level 2',
        description: 'The access door on level 2 does not open with a valid card.',
      });
      expect(ticket.statusCode).toBe(201);
      const rule = await ctx.prisma.escalationRule.create({
        data: {
          priority: 'P1',
          teamId: team.id,
          step: 1,
          targetType: 'ON_CALL',
          afterMins: 0,
          channels: ['EMAIL'],
        },
      });
      const archive = async () =>
        apiAs(ctx, admin).post(`/admin/teams/${team.id}/archive`, {
          expectedUpdatedAt: (await teamRow(team.id)).updatedAt.toISOString(),
        });

      const expectGuard = async (guard: string) => {
        broadcast.mockClear();
        const res = await archive();
        expect(res.statusCode, guard).toBe(409);
        expect(res.json().error.details).toEqual({ reason: 'guard', guard });
        expect((await teamRow(team.id)).isActive).toBe(true);
        expect(await auditRows(team.id)).toEqual([]);
        expect(scopesSent()).toEqual([]);
      };
      await expectGuard('team_has_active_categories');
      await ctx.prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
      await expectGuard('team_has_open_tickets');
      await ctx.prisma.ticket.update({
        where: { id: ticket.json().ticket.id },
        data: { status: 'SOLVED' },
      });
      await expectGuard('team_in_escalation');
      await ctx.prisma.escalationRule.update({ where: { id: rule.id }, data: { isActive: false } });

      expect(
        (
          await apiAs(ctx, lead).post(`/admin/teams/${teamA.id}/archive`, {
            expectedUpdatedAt: (await teamRow(teamA.id)).updatedAt.toISOString(),
          })
        ).statusCode,
      ).toBe(403);

      const members = await ctx.prisma.teamMember.count({ where: { teamId: team.id } });
      const ok = await archive();
      expect(ok.statusCode).toBe(200);
      expect(ok.json().item).toMatchObject({ isActive: false, openTicketCount: 0 });
      expect(await ctx.prisma.teamMember.count({ where: { teamId: team.id } })).toBe(members);
      expect(scopesSent()).toEqual(['teams']);
      expect(invalidate).toHaveBeenCalledWith(admin.id);

      // Archived teams leave the list unless asked for; an archived team takes no new members.
      const active = teamAdminListSchema.parse(
        (await apiAs(ctx, admin).get('/admin/teams')).json(),
      ).items;
      expect(active.some((t) => t.id === team.id)).toBe(false);
      const add = await apiAs(ctx, admin).post(`/admin/teams/${team.id}/members`, {
        userId: outsider.id,
      });
      expect(add.statusCode).toBe(409);
      expect(add.json().error.details.guard).toBe('team_archived');

      const restored = await apiAs(ctx, admin).post(`/admin/teams/${team.id}/restore`, {
        expectedUpdatedAt: (await teamRow(team.id)).updatedAt.toISOString(),
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().item.isActive).toBe(true);
      expect((await auditRows(team.id)).map((r) => r.action)).toEqual(['ARCHIVE', 'RESTORE']);
    });
  });

  describe('POST /admin/teams/reorder', () => {
    it('reorders the active teams (one request per drop) and refuses a changed order', async () => {
      const original = await ctx.prisma.team.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
        select: { id: true, sortOrder: true },
      });
      // Put everyone's order back afterwards (the dev database's seeded teams included).
      ctx.fixtures.onCleanup(async () => {
        for (const t of original) {
          await ctx.prisma.team.updateMany({
            where: { id: t.id },
            data: { sortOrder: t.sortOrder },
          });
        }
      });
      const activeIds = async () =>
        (
          await ctx.prisma.team.findMany({
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
            select: { id: true },
          })
        ).map((t) => t.id);
      let ids = original.map((t) => t.id);
      let next = [...ids].reverse();
      expect(
        (await apiAs(ctx, lead).post('/admin/teams/reorder', { expectedIds: ids, ids: next }))
          .statusCode,
      ).toBe(403);
      // Other test files create and archive teams at the same time (the list is global): retry on
      // order_changed with a fresh list, and compare only the teams this request ordered.
      let res = await apiAs(ctx, admin).post('/admin/teams/reorder', {
        expectedIds: ids,
        ids: next,
      });
      for (let attempt = 0; res.statusCode === 409 && attempt < 5; attempt++) {
        ids = await activeIds();
        next = [...ids].reverse();
        res = await apiAs(ctx, admin).post('/admin/teams/reorder', { expectedIds: ids, ids: next });
      }
      expect(res.statusCode, res.body).toBe(204);
      const ordered = new Set(next);
      expect((await activeIds()).filter((id) => ordered.has(id))).toEqual(next);
      expect(scopesSent()).toEqual(['teams']);
      const [row] = await ctx.prisma.adminAuditLog.findMany({
        where: { entity: 'Team', entityId: 'teams', actorId: admin.id },
      });
      expect(row).toMatchObject({
        action: 'REORDER',
        before: { order: ids },
        after: { order: next },
      });

      const stale = await apiAs(ctx, admin).post('/admin/teams/reorder', {
        expectedIds: ids,
        ids: next,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details).toMatchObject({ reason: 'order_changed' });
    });
  });

  it('documents the routes in OpenAPI under the admin tag', async () => {
    const doc = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    expect(doc.paths['/admin/teams/']?.get?.tags ?? doc.paths['/admin/teams']?.get?.tags).toEqual([
      'admin',
    ]);
    expect(doc.paths['/admin/teams/{id}/members/{userId}']?.delete?.tags).toEqual(['admin']);
  });
});
