import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@loons/db';
import { createPrincipalStore } from '../src/lib/actor.ts';
import { AppError } from '../src/lib/errors.ts';
import { createTestContext, mintToken, rand, type TestContext } from './helpers.ts';

describe('/me', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const getMe = (token?: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('valid token → user, organisation and teams', async () => {
    const { user, org } = await ctx.fixtures.client();
    const res = await getMe(await mintToken(ctx.config, { sub: user.id }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'CLIENT',
        status: 'ACTIVE',
        orgId: org.id,
        locale: 'en',
        teamIds: [],
        sessionVersion: 0,
        emailVerified: true,
      },
      org: { id: org.id, name: org.name },
      teams: [],
    });
  });

  it('staff member → teams with membership role', async () => {
    const staff = await ctx.fixtures.staff({
      staffDomain: ctx.config.staffEmailDomain,
      role: 'TEAM_LEAD',
    });
    const team = await ctx.fixtures.team();
    await ctx.fixtures.member(team.id, staff.id, 'LEAD');
    const res = await getMe(await mintToken(ctx.config, { sub: staff.id, role: 'TEAM_LEAD' }));
    expect(res.statusCode).toBe(200);
    expect(res.json().org).toBeNull();
    expect(res.json().teams).toEqual([
      { id: team.id, key: team.key, nameEn: team.nameEn, nameAr: team.nameAr, role: 'LEAD' },
    ]);
  });

  it('missing token → 401 UNAUTHENTICATED', async () => {
    const res = await getMe();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('malformed Authorization header → 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('tampered token → 401', async () => {
    const { user } = await ctx.fixtures.client();
    const token = await mintToken(ctx.config, { sub: user.id });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.role = 'SUPER_ADMIN';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect((await getMe(forged)).statusCode).toBe(401);
  });

  it('token signed with another secret → 401', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await getMe(
      await mintToken(ctx.config, { sub: user.id }, { secret: 'x'.repeat(48) }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('expired token → 401', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await getMe(
      await mintToken(ctx.config, { sub: user.id }, { issuedAt: -1000, expiresIn: 900 }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('token older than the TTL (even with a far exp) → 401', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await getMe(
      await mintToken(ctx.config, { sub: user.id }, { issuedAt: -7200, expiresIn: 86_400 }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('wrong audience or issuer → 401', async () => {
    const { user } = await ctx.fixtures.client();
    expect(
      (await getMe(await mintToken(ctx.config, { sub: user.id }, { audience: 'someone-else' })))
        .statusCode,
    ).toBe(401);
    expect(
      (await getMe(await mintToken(ctx.config, { sub: user.id }, { issuer: 'someone-else' })))
        .statusCode,
    ).toBe(401);
  });

  it('other algorithm (HS512) → 401', async () => {
    const { user } = await ctx.fixtures.client();
    expect(
      (await getMe(await mintToken(ctx.config, { sub: user.id }, { alg: 'HS512' }))).statusCode,
    ).toBe(401);
  });

  it('unknown user → 401', async () => {
    expect((await getMe(await mintToken(ctx.config, { sub: randomUUID() }))).statusCode).toBe(401);
  });

  it('disabled user → 401 ACCOUNT_DISABLED', async () => {
    const { user } = await ctx.fixtures.client({ status: 'DISABLED' });
    const res = await getMe(await mintToken(ctx.config, { sub: user.id }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ACCOUNT_DISABLED');
  });

  it('disabling a user takes effect once the principal cache is invalidated', async () => {
    const { user } = await ctx.fixtures.client();
    const token = await mintToken(ctx.config, { sub: user.id });
    expect((await getMe(token)).statusCode).toBe(200);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    await ctx.app.principals.invalidate(user.id);
    expect((await getMe(token)).statusCode).toBe(401);
  });

  describe('session version (revocation)', () => {
    const principalKey = (userId: string) => `${ctx.config.redisPrefix}principal:${userId}`;

    it('a token whose sv differs from the user’s sessionVersion → 401 UNAUTHENTICATED', async () => {
      const { user } = await ctx.fixtures.client();
      await ctx.prisma.user.update({ where: { id: user.id }, data: { sessionVersion: 2 } });

      const current = await getMe(await mintToken(ctx.config, { sub: user.id, sv: 2 }));
      expect(current.statusCode).toBe(200);
      expect(current.json().user.sessionVersion).toBe(2);

      for (const sv of [0, 1, 3]) {
        const res = await getMe(await mintToken(ctx.config, { sub: user.id, sv }));
        expect(res.statusCode, `sv ${sv}`).toBe(401);
        expect(res.json().error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('a token without an sv claim → 401', async () => {
      const { user } = await ctx.fixtures.client();
      const res = await getMe(await mintToken(ctx.config, { sub: user.id, sv: null }));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('the principal cache carries sessionVersion', async () => {
      const { user } = await ctx.fixtures.client();
      expect((await getMe(await mintToken(ctx.config, { sub: user.id }))).statusCode).toBe(200);
      const cached = JSON.parse((await ctx.redis.get(principalKey(user.id))) ?? 'null');
      expect(cached).toMatchObject({ id: user.id, sessionVersion: 0 });
    });

    it('revokeUserSessions: increments the version, clears the cache; old tokens 401, new ones work', async () => {
      const { user } = await ctx.fixtures.client();
      const oldToken = await mintToken(ctx.config, { sub: user.id, sv: 0 });
      expect((await getMe(oldToken)).statusCode).toBe(200); // warms the principal cache

      await expect(ctx.app.services.sessions.revokeUserSessions(user.id)).resolves.toBe(1);
      expect(
        (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion,
      ).toBe(1);
      expect(await ctx.redis.get(principalKey(user.id))).toBeNull();

      const stale = await getMe(oldToken);
      expect(stale.statusCode).toBe(401);
      expect(stale.json().error.code).toBe('UNAUTHENTICATED');
      const fresh = await getMe(await mintToken(ctx.config, { sub: user.id, sv: 1 }));
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().user.sessionVersion).toBe(1);

      await expect(ctx.app.services.sessions.revokeUserSessions(user.id)).resolves.toBe(2);
      expect((await getMe(await mintToken(ctx.config, { sub: user.id, sv: 1 }))).statusCode).toBe(
        401,
      );
    });

    it('revokeUserSessions for an unknown user → NOT_FOUND', async () => {
      await expect(ctx.app.services.sessions.revokeUserSessions(randomUUID())).rejects.toSatisfy(
        (err) => err instanceof AppError && err.code === 'NOT_FOUND',
      );
    });

    it('a stale cache entry never rejects a newer token, and never lets an older one through', async () => {
      const { user } = await ctx.fixtures.client();
      expect((await getMe(await mintToken(ctx.config, { sub: user.id }))).statusCode).toBe(200);
      // The version changes behind the cache's back (as if the invalidation had failed).
      await ctx.prisma.user.update({ where: { id: user.id }, data: { sessionVersion: 1 } });
      expect(JSON.parse((await ctx.redis.get(principalKey(user.id)))!).sessionVersion).toBe(0);

      expect((await getMe(await mintToken(ctx.config, { sub: user.id, sv: 1 }))).statusCode).toBe(
        200,
      );
      // The newer token forced a database read, which refreshed the cache.
      expect(JSON.parse((await ctx.redis.get(principalKey(user.id)))!).sessionVersion).toBe(1);
      expect((await getMe(await mintToken(ctx.config, { sub: user.id, sv: 0 }))).statusCode).toBe(
        401,
      );
    });

    it('a load that read the database before an invalidation does not re-cache the old principal', async () => {
      const { user } = await ctx.fixtures.client();
      const row = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          id: true,
          role: true,
          status: true,
          orgId: true,
          locale: true,
          sessionVersion: true,
          teamMemberships: { select: { teamId: true, role: true } },
        },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reads = 0;
      // The first read returns the pre-revocation row, but only after the revocation happened.
      const slowPrisma = {
        user: {
          findUnique: async () => {
            reads += 1;
            if (reads === 1) {
              await gate;
              return row;
            }
            return { ...row, sessionVersion: row.sessionVersion + 1 };
          },
        },
      } as unknown as PrismaClient;
      const store = createPrincipalStore({
        prisma: slowPrisma,
        redis: ctx.redis,
        prefix: `${ctx.config.redisPrefix}race-${rand()}:`,
        logger: ctx.app.log,
      });

      const inFlight = store.load(user.id);
      await new Promise((resolve) => setTimeout(resolve, 50)); // the loader is now waiting on the "database"
      await store.invalidate(user.id); // the revocation commits and clears the cache
      release();
      expect((await inFlight)?.sessionVersion).toBe(0); // this request saw the old row…
      // …but did not cache it: the next load reads the database again and sees the new version.
      expect((await store.load(user.id))?.sessionVersion).toBe(1);
      expect(reads).toBe(2);
      expect((await store.load(user.id))?.sessionVersion).toBe(1);
      expect(reads).toBe(2); // now served from the cache
    });
  });

  it('pending-approval user can read /me', async () => {
    const user = await ctx.fixtures.user({ status: 'PENDING_APPROVAL' });
    const res = await getMe(await mintToken(ctx.config, { sub: user.id }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { status: 'PENDING_APPROVAL' }, org: null });
  });

  it('PATCH /me updates the locale (204) and GET /me reflects it immediately', async () => {
    const { user } = await ctx.fixtures.client();
    const token = await mintToken(ctx.config, { sub: user.id });
    expect((await getMe(token)).json().user.locale).toBe('en'); // warms the principal cache

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { locale: 'ar' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).locale).toBe('ar');
    expect((await getMe(token)).json().user.locale).toBe('ar');
  });

  it('PATCH /me with an unsupported locale → 400 VALIDATION_FAILED', async () => {
    const { user } = await ctx.fixtures.client();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: { authorization: `Bearer ${await mintToken(ctx.config, { sub: user.id })}` },
      payload: { locale: 'fr' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});
