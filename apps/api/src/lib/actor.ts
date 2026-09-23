import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { PrismaClient } from '@loons/db';
import { LOCALES, ROLES, TEAM_MEMBER_ROLES, USER_STATUSES, type Actor, type AuthUser } from '@loons/shared';
import type { AppLogger as Logger } from './logger.ts';

// The authenticated principal, reloaded from the database for every request (token claims are
// only a hint). A ≤30 s Redis cache absorbs bursts; PATCH /me, session revocation and admin
// changes invalidate it.

export const PRINCIPAL_CACHE_TTL_SECONDS = 30;

/**
 * Lifetime of a user's cache generation counter (bumped by every invalidation). It only has to
 * outlive a single in-flight `load()`, so a few minutes is plenty.
 */
const PRINCIPAL_GENERATION_TTL_SECONDS = 300;

/**
 * Writes the cache entry only if no invalidation happened since the loader read the generation:
 * a request that read the database just before a change committed can't put the old principal
 * (e.g. an old `sessionVersion`) back after the invalidation.
 * KEYS[1] = entry, KEYS[2] = generation; ARGV = generation seen, JSON, TTL seconds.
 */
const SET_IF_GENERATION_UNCHANGED = `
if (redis.call('GET', KEYS[2]) or '') == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
end
return 0
`;

const principalSchema = z.object({
  id: z.string(),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  orgId: z.string().nullable(),
  locale: z.enum(LOCALES),
  /** API tokens carry the version they were minted for (`sv`); a mismatch means revoked. */
  sessionVersion: z.number().int().nonnegative(),
  teams: z.array(z.object({ teamId: z.string(), role: z.enum(TEAM_MEMBER_ROLES) })),
});

/** What the cache holds: no email, name or other contact data. */
export type Principal = z.infer<typeof principalSchema>;

export function toActor(p: Principal): Actor {
  return {
    id: p.id,
    role: p.role,
    status: p.status,
    orgId: p.orgId,
    teamIds: p.teams.map((t) => t.teamId),
    leadTeamIds: p.teams.filter((t) => t.role === 'LEAD').map((t) => t.teamId),
  };
}

/** Prisma `select` for everything AuthUser needs. */
export const authUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  orgId: true,
  locale: true,
  sessionVersion: true,
  teamMemberships: { select: { teamId: true, role: true } },
} as const;

export interface AuthUserRow {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  status: AuthUser['status'];
  orgId: string | null;
  locale: AuthUser['locale'];
  sessionVersion: number;
  teamMemberships: Array<{ teamId: string; role: 'MEMBER' | 'LEAD' }>;
}

export function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    orgId: row.orgId,
    locale: row.locale,
    teamIds: row.teamMemberships.map((m) => m.teamId),
    sessionVersion: row.sessionVersion,
  };
}

export interface PrincipalLoadOptions {
  /** Skip the cache and read the database (the fresh value is cached again). */
  fresh?: boolean;
}

export interface PrincipalStore {
  load(userId: string, options?: PrincipalLoadOptions): Promise<Principal | null>;
  /** Drops the cached principal; call after committing any change to it (incl. sessionVersion). */
  invalidate(userId: string): Promise<void>;
}

export function createPrincipalStore(deps: {
  prisma: PrismaClient;
  redis: Redis;
  prefix: string;
  logger: Logger;
  ttlSeconds?: number;
}): PrincipalStore {
  const { prisma, redis, logger } = deps;
  const ttl = Math.min(deps.ttlSeconds ?? PRINCIPAL_CACHE_TTL_SECONDS, PRINCIPAL_CACHE_TTL_SECONDS);
  const keyOf = (userId: string) => `${deps.prefix}principal:${userId}`;
  const generationKeyOf = (userId: string) => `${deps.prefix}principal-gen:${userId}`;

  async function fromDb(userId: string): Promise<Principal | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
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
    if (!user) return null;
    return {
      id: user.id,
      role: user.role,
      status: user.status,
      orgId: user.orgId,
      locale: user.locale,
      sessionVersion: user.sessionVersion,
      teams: user.teamMemberships.map((m) => ({ teamId: m.teamId, role: m.role })),
    };
  }

  return {
    async load(userId, options = {}) {
      // The generation is read before the database so a concurrent invalidation is detected.
      let generation: string | null = null;
      try {
        const [cached, gen] = await redis.mget(keyOf(userId), generationKeyOf(userId));
        generation = gen ?? '';
        if (cached && !options.fresh) {
          // Entries in an older shape (e.g. without sessionVersion) fail here → database.
          const parsed = principalSchema.safeParse(JSON.parse(cached));
          if (parsed.success && parsed.data.id === userId) return parsed.data;
        }
      } catch (err) {
        logger.warn({ err }, 'principal cache read failed; using the database');
      }

      const principal = await fromDb(userId);
      if (principal && ttl > 0 && generation !== null) {
        try {
          await redis.eval(
            SET_IF_GENERATION_UNCHANGED,
            2,
            keyOf(userId),
            generationKeyOf(userId),
            generation,
            JSON.stringify(principal),
            ttl,
          );
        } catch (err) {
          logger.warn({ err }, 'principal cache write failed');
        }
      }
      return principal;
    },

    async invalidate(userId) {
      try {
        const generationKey = generationKeyOf(userId);
        const results = await redis
          .multi()
          .incr(generationKey)
          .expire(generationKey, PRINCIPAL_GENERATION_TTL_SECONDS)
          .del(keyOf(userId))
          .exec();
        const failed = results?.find(([err]) => err)?.[0];
        if (!results || failed) throw failed ?? new Error('principal cache invalidation aborted');
      } catch (err) {
        logger.warn({ err }, 'principal cache invalidation failed');
      }
    },
  };
}
