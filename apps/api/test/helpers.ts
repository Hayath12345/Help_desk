import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Redis } from 'ioredis';
import { createPrismaClient, hashPassword, type PrismaClient } from '@loons/db';
import type { Locale, Role, TeamMemberRole, UserStatus } from '@loons/shared';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createQueues, type AppQueues } from '../src/lib/queues.ts';
import { closeRedis, createRedisClient } from '../src/lib/redis.ts';

export const TEST_PASSWORD = 'Correct-Horse-42';

export function rand(bytes = 5): string {
  return randomBytes(bytes).toString('hex');
}

/** Real config from the repo .env, quiet logs, isolated Redis key prefix. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ ...process.env, LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent' });
  return { ...base, redisPrefix: `loons-test:${rand()}:`, ...overrides };
}

/** Unique non-staff email on a unique domain: t-<rand>@test-<rand>.example */
export function testEmail(domain = `test-${rand()}.example`): string {
  return `t-${rand()}@${domain}`;
}

export function testDomain(): string {
  return `test-${rand()}.example`;
}

/** Test rows created here (or through the API) — deleted in `cleanup()`, seed rows never touched. */
export class Fixtures {
  private readonly userIds = new Set<string>();
  private readonly emails = new Set<string>();
  private readonly orgIds = new Set<string>();
  private readonly teamIds = new Set<string>();

  constructor(readonly prisma: PrismaClient) {}

  /** Remember an email whose user the API will create (register / OAuth). */
  trackEmail(email: string): string {
    this.emails.add(email.toLowerCase());
    return email;
  }

  async org(options: { domains?: string[]; isActive?: boolean } = {}) {
    const key = `test-${rand()}`;
    const org = await this.prisma.organization.create({
      data: { key, name: `Test Org ${key}`, emailDomains: options.domains ?? [], isActive: options.isActive ?? true },
    });
    this.orgIds.add(org.id);
    return org;
  }

  async team() {
    const key = `test-${rand()}`;
    const team = await this.prisma.team.create({ data: { key, nameEn: `Team ${key}`, nameAr: `فريق ${key}` } });
    this.teamIds.add(team.id);
    return team;
  }

  async member(teamId: string, userId: string, role: TeamMemberRole = 'MEMBER') {
    return this.prisma.teamMember.create({ data: { teamId, userId, role } });
  }

  async user(
    options: {
      email?: string;
      name?: string;
      role?: Role;
      status?: UserStatus;
      orgId?: string | null;
      locale?: Locale;
      /** null = SSO-only account (no password). */
      password?: string | null;
    } = {},
  ) {
    const email = (options.email ?? testEmail()).toLowerCase();
    const password = options.password === undefined ? TEST_PASSWORD : options.password;
    const user = await this.prisma.user.create({
      data: {
        email,
        name: options.name ?? 'Test User',
        role: options.role ?? 'CLIENT',
        status: options.status ?? 'ACTIVE',
        orgId: options.orgId ?? null,
        locale: options.locale ?? 'en',
        passwordHash: password === null ? null : await hashPassword(password),
      },
    });
    this.userIds.add(user.id);
    this.emails.add(email);
    return user;
  }

  /** A client in a fresh organisation. */
  async client(options: Parameters<Fixtures['user']>[0] = {}) {
    const domain = testDomain();
    const org = await this.org({ domains: [domain] });
    const user = await this.user({ email: testEmail(domain), orgId: org.id, ...options });
    return { user, org, domain };
  }

  async staff(options: Parameters<Fixtures['user']>[0] & { staffDomain: string }) {
    const { staffDomain, ...rest } = options;
    return this.user({ email: `t-${rand()}@${staffDomain}`, role: 'AGENT', ...rest });
  }

  async cleanup(): Promise<void> {
    const emails = [...this.emails];
    const ids = [...this.userIds];
    if (emails.length || ids.length) {
      await this.prisma.user.deleteMany({ where: { OR: [{ id: { in: ids } }, { email: { in: emails } }] } });
    }
    if (this.teamIds.size) await this.prisma.team.deleteMany({ where: { id: { in: [...this.teamIds] } } });
    if (this.orgIds.size) await this.prisma.organization.deleteMany({ where: { id: { in: [...this.orgIds] } } });
  }
}

export interface TestContext {
  app: App;
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  queues: AppQueues;
  fixtures: Fixtures;
  internalHeaders(clientIp?: string): Record<string, string>;
  close(): Promise<void>;
}

async function deleteKeys(redis: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}

/**
 * A fully wired app on the real database / Redis with isolated key prefixes (rate limits,
 * caches, queues) so tests never collide with each other or a running dev stack.
 */
export async function createTestContext(
  options: { config?: Partial<AppConfig>; beforeReady?: (app: App) => void | Promise<void> } = {},
): Promise<TestContext> {
  const config = testConfig(options.config);
  const prisma = createPrismaClient({ url: config.databaseUrl, poolSize: 4 });
  const redis = createRedisClient(config.redisUrl);
  const queuePrefix = `${config.redisPrefix}bull`;
  const queues = createQueues({ connection: redis, prefix: queuePrefix });
  const app = await buildApp({
    config,
    prisma,
    redis,
    queues,
    rateLimitNamespace: `${config.redisPrefix}rl:`,
  });
  await options.beforeReady?.(app);
  await app.ready();
  const fixtures = new Fixtures(prisma);

  return {
    app,
    config,
    prisma,
    redis,
    queues,
    fixtures,
    internalHeaders(clientIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`) {
      return { 'x-internal-api-key': config.internalApiKey, 'x-client-ip': clientIp };
    },
    async close() {
      await app.close();
      await fixtures.cleanup();
      await Promise.allSettled([queues.email, queues.notifications, queues.sla].map((q) => q.obliterate({ force: true })));
      await queues.close();
      await deleteKeys(redis, `${config.redisPrefix}*`);
      await closeRedis(redis);
      await prisma.$disconnect();
    },
  };
}

/** An access token like the web server mints (HS256, iss/aud from config; `sv` defaults to 0). */
export async function mintToken(
  config: AppConfig,
  claims: { sub: string; role?: Role; sv?: number | null },
  options: {
    secret?: string;
    issuer?: string;
    audience?: string;
    /** Seconds relative to now. */
    issuedAt?: number;
    expiresIn?: number;
    alg?: 'HS256' | 'HS512';
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // sv: null → no sv claim at all (tokens minted before session versions existed).
  const sv = claims.sv === undefined ? 0 : claims.sv;
  return new SignJWT({ role: claims.role ?? 'CLIENT', ...(sv === null ? {} : { sv }) })
    .setProtectedHeader({ alg: options.alg ?? 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(options.issuer ?? config.jwt.issuer)
    .setAudience(options.audience ?? config.jwt.audience)
    .setIssuedAt(now + (options.issuedAt ?? 0))
    .setExpirationTime(now + (options.issuedAt ?? 0) + (options.expiresIn ?? config.jwt.ttlSeconds))
    .setJti(rand(8))
    .sign(new TextEncoder().encode(options.secret ?? config.jwt.secret));
}

export function randomIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
}
