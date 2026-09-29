import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Redis } from 'ioredis';
import { createPrismaClient, hashPassword, type PrismaClient } from '@loons/db';
import type {
  CustomFieldType,
  Locale,
  Priority,
  Role,
  TeamMemberRole,
  UserStatus,
} from '@loons/shared';
import { buildApp, type App, type AppDeps } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { createQueues, type AppQueues } from '../src/lib/queues.ts';
import { closeRedis, createRedisClient } from '../src/lib/redis.ts';

export const TEST_PASSWORD = 'Correct-Horse-42';

const passwordHashes = new Map<string, Promise<string>>();
/**
 * argon2 is slow and runs on native worker threads: each fixture password is hashed once per test
 * process and the (valid) hash reused for every user that has it.
 */
function fixturePasswordHash(password: string): Promise<string> {
  let hash = passwordHashes.get(password);
  if (!hash) {
    hash = hashPassword(password);
    passwordHashes.set(password, hash);
  }
  return hash;
}

export function rand(bytes = 5): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * A fresh Redis key prefix for a test context: `loons-test:<run>:<random>:` inside `vitest run`
 * (test/global-setup.ts removes the run's leftovers), `loons-test:<random>:` elsewhere.
 */
export function testRedisPrefix(): string {
  const run = process.env.LOONS_TEST_RUN;
  return `loons-test:${run ? `${run}:` : ''}${rand()}:`;
}

/** Real config from the repo .env, quiet logs, isolated Redis key prefix. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ ...process.env, LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent' });
  return { ...base, redisPrefix: testRedisPrefix(), ...overrides };
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
  private readonly categoryIds = new Set<string>();
  private readonly fieldIds = new Set<string>();
  private readonly tagKeys = new Set<string>();

  constructor(readonly prisma: PrismaClient) {}

  /** Remember an email whose user the API will create (register / OAuth). */
  trackEmail(email: string): string {
    this.emails.add(email.toLowerCase());
    return email;
  }

  async org(options: { domains?: string[]; isActive?: boolean } = {}) {
    const key = `test-${rand()}`;
    const org = await this.prisma.organization.create({
      data: {
        key,
        name: `Test Org ${key}`,
        emailDomains: options.domains ?? [],
        isActive: options.isActive ?? true,
      },
    });
    this.orgIds.add(org.id);
    return org;
  }

  async team() {
    const key = `test-${rand()}`;
    const team = await this.prisma.team.create({
      data: { key, nameEn: `Team ${key}`, nameAr: `فريق ${key}` },
    });
    this.teamIds.add(team.id);
    return team;
  }

  /** A site of an organisation (deleted with the organisation). */
  async site(orgId: string, options: { isActive?: boolean; name?: string } = {}) {
    const key = `site-${rand()}`;
    return this.prisma.site.create({
      data: {
        orgId,
        key,
        name: options.name ?? `Site ${key}`,
        isActive: options.isActive ?? true,
      },
    });
  }

  /**
   * A ticket category routed to `teamId`, with sub-types and custom fields. Test categories sort
   * last (sortOrder 10 000+) so they stay out of the way of anyone using the dev database.
   */
  async category(options: {
    teamId: string;
    isActive?: boolean;
    subtypes?: Array<{ defaultPriority?: Priority; isActive?: boolean }>;
    fields?: Array<{
      type: CustomFieldType;
      required?: boolean;
      isActive?: boolean;
      options?: string[];
    }>;
  }) {
    const key = `test-${rand()}`;
    const category = await this.prisma.category.create({
      data: {
        key,
        labelEn: `Test ${key}`,
        labelAr: `اختبار ${key}`,
        teamId: options.teamId,
        sortOrder: 10_000,
        isActive: options.isActive ?? true,
        assetPlaceholder: 'e.g. TST-01',
      },
    });
    this.categoryIds.add(category.id);
    const subtypes = [];
    for (const [i, st] of (options.subtypes ?? [{ defaultPriority: 'P3' }]).entries()) {
      subtypes.push(
        await this.prisma.subtype.create({
          data: {
            categoryId: category.id,
            key: `st-${i}-${rand(3)}`,
            labelEn: `Sub-type ${i}`,
            labelAr: `نوع فرعي ${i}`,
            defaultPriority: st.defaultPriority ?? 'P3',
            isActive: st.isActive ?? true,
            sortOrder: i,
          },
        }),
      );
    }
    const fields = [];
    for (const [i, f] of (options.fields ?? []).entries()) {
      const field = await this.prisma.customField.create({
        data: {
          key: `tf_${f.type.toLowerCase()}_${rand(3)}`,
          labelEn: `Field ${f.type}`,
          labelAr: `حقل ${f.type}`,
          type: f.type,
          required: f.required ?? false,
          isActive: f.isActive ?? true,
          options: f.options?.map((value) => ({ value, labelEn: value, labelAr: value })),
        },
      });
      this.fieldIds.add(field.id);
      await this.prisma.categoryField.create({
        data: { categoryId: category.id, fieldId: field.id, sortOrder: i },
      });
      fields.push(field);
    }
    return { category, subtypes, fields };
  }

  /** Tags a test creates through the API (deleted in cleanup). */
  trackTag(key: string): string {
    this.tagKeys.add(key);
    return key;
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
      /** Mailbox ownership proven (default true); unverified clients only reach /me. */
      emailVerified?: boolean;
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
        passwordHash: password === null ? null : await fixturePasswordHash(password),
        emailVerifiedAt: options.emailVerified === false ? null : new Date(),
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
    const userIds = [
      ...ids,
      ...(
        await this.prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
      ).map((u) => u.id),
    ];
    // Tickets first (messages, attachments, tags and events cascade), then what they reference.
    await this.prisma.ticket.deleteMany({
      where: {
        OR: [
          { requesterId: { in: userIds } },
          { orgId: { in: [...this.orgIds] } },
          { teamId: { in: [...this.teamIds] } },
          { categoryId: { in: [...this.categoryIds] } },
        ],
      },
    });
    await this.prisma.attachment.deleteMany({ where: { uploaderId: { in: userIds } } });
    if (this.categoryIds.size) {
      const categoryIds = [...this.categoryIds];
      await this.prisma.subtype.deleteMany({ where: { categoryId: { in: categoryIds } } });
      await this.prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
    }
    if (this.fieldIds.size)
      await this.prisma.customField.deleteMany({ where: { id: { in: [...this.fieldIds] } } });
    if (this.tagKeys.size)
      await this.prisma.tag.deleteMany({ where: { key: { in: [...this.tagKeys] } } });
    if (this.orgIds.size)
      await this.prisma.site.deleteMany({ where: { orgId: { in: [...this.orgIds] } } });
    if (emails.length || ids.length) {
      await this.prisma.user.deleteMany({
        where: { OR: [{ id: { in: ids } }, { email: { in: emails } }] },
      });
    }
    if (this.teamIds.size)
      await this.prisma.team.deleteMany({ where: { id: { in: [...this.teamIds] } } });
    if (this.orgIds.size)
      await this.prisma.organization.deleteMany({ where: { id: { in: [...this.orgIds] } } });
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
  options: {
    config?: Partial<AppConfig>;
    beforeReady?: (app: App) => void | Promise<void>;
    /** Replacement object storage / SLA arithmetic / socket limits. */
    deps?: Pick<AppDeps, 'storage' | 'sla' | 'realtimeLimits' | 'realtimeClusterTimeoutMs'>;
  } = {},
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
    ...options.deps,
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
      await Promise.allSettled(
        [queues.email, queues.notifications, queues.sla].map((q) => q.obliterate({ force: true })),
      );
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

/** Addresses handed out by `randomIp` (198.18.0.0/15, the benchmarking range; no .0 / .255). */
const IP_POOL = 2 * 256 * 254;
let ipSeq = Math.floor(Math.random() * IP_POOL);

/**
 * A client address no earlier call in this process got: per-IP rate-limit buckets of one test
 * never collide with another's. (Random picks from 250 addresses made `rate-limit.test.ts` fail
 * now and then, when two of its tests drew the same IP.)
 */
export function randomIp(): string {
  ipSeq = (ipSeq + 1) % IP_POOL;
  const host = (ipSeq % 254) + 1;
  const third = Math.floor(ipSeq / 254) % 256;
  const second = 18 + Math.floor(ipSeq / (254 * 256));
  return `198.${second}.${third}.${host}`;
}
