import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_UPLOAD_DAILY_BYTES_PER_USER,
  TICKET_LIMITS,
  uploadQuotaDetailsSchema,
} from '@loons/shared';
import { createStorage, type Storage } from '../src/lib/storage.ts';
import { closeRedis, createRedisClient } from '../src/lib/redis.ts';
import {
  UPLOAD_QUOTA_WINDOW_MS,
  createUploadQuota,
  uploadQuotaKey,
  type UploadQuota,
} from '../src/lib/upload-quota.ts';
import {
  createTestContext,
  rand,
  testConfig,
  testRedisPrefix,
  type TestContext,
} from './helpers.ts';
import { apiAs, createWorld, type Persona, type World } from './ticket-world.ts';

// The rolling daily upload budget: the Redis script on its own (fake clock), then through
// POST /attachments/presign.

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const silent = { warn: () => undefined } as unknown as Parameters<
  typeof createUploadQuota
>[0]['logger'];

describe('upload quota (Redis script)', () => {
  let redis: Redis;
  const prefix = testRedisPrefix();
  let clock = 1_800_000_000_000;
  const quota = (limitBytes: number, windowMs = UPLOAD_QUOTA_WINDOW_MS): UploadQuota =>
    createUploadQuota({ redis, prefix, limitBytes, logger: silent, windowMs, now: () => clock });
  const user = () => `user-${rand()}`;
  const id = () => `att-${rand()}`;

  beforeAll(() => {
    redis = createRedisClient(testConfig().redisUrl);
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await closeRedis(redis);
  });

  it('exactly at the limit is allowed; one byte over is refused', async () => {
    const q = quota(100);
    const u = user();
    expect(await q.reserve(u, id(), 60)).toEqual({ allowed: true });
    expect(await q.reserve(u, id(), 40)).toEqual({ allowed: true });
    const over = await q.reserve(u, id(), 1);
    expect(over).toMatchObject({ allowed: false, limitBytes: 100 });
    // A refusal records nothing.
    expect(await redis.zcard(uploadQuotaKey(prefix, u))).toBe(2);

    const v = user();
    expect(await q.reserve(v, id(), 100)).toEqual({ allowed: true });
    const w = user();
    expect(await q.reserve(w, id(), 99)).toEqual({ allowed: true });
    expect(await q.reserve(w, id(), 2)).toMatchObject({ allowed: false });
    expect(await q.reserve(w, id(), 1)).toEqual({ allowed: true });
  });

  it('retryAfterSeconds is when enough old reservations age out for THIS file', async () => {
    const q = quota(100);
    const u = user();
    const start = clock;
    expect((await q.reserve(u, id(), 40)).allowed).toBe(true); // a: t0
    clock = start + 1 * HOUR;
    expect((await q.reserve(u, id(), 30)).allowed).toBe(true); // b: t0 + 1 h
    clock = start + 2 * HOUR;
    expect((await q.reserve(u, id(), 30)).allowed).toBe(true); // c: t0 + 2 h
    clock = start + 10_000 * SECOND;
    // 10 bytes: a's 40 are enough → when a ages out.
    expect(await q.reserve(u, id(), 10)).toEqual({
      allowed: false,
      limitBytes: 100,
      retryAfterSeconds: 86_400 - 10_000,
    });
    // 50 bytes: a (40) is not enough, a + b (70) is → when b ages out.
    expect(await q.reserve(u, id(), 50)).toEqual({
      allowed: false,
      limitBytes: 100,
      retryAfterSeconds: 3_600 + 86_400 - 10_000,
    });
    // Rounded up to whole seconds, never 0.
    clock = start + 24 * HOUR - 1;
    expect(await q.reserve(u, id(), 10)).toMatchObject({ retryAfterSeconds: 1 });
    // Exactly 24 h after a: a has aged out.
    clock = start + 24 * HOUR;
    expect((await q.reserve(u, id(), 40)).allowed).toBe(true);
    clock = start + 24 * HOUR + 1 * SECOND;
    expect(await q.reserve(u, id(), 1)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1 * 3_600 + 86_400 - (86_400 + 1),
    });
    // After everything aged out the whole budget is back.
    clock = start + 48 * HOUR;
    expect((await q.reserve(u, id(), 100)).allowed).toBe(true);
    clock = start + 100 * HOUR;
  });

  it('users are counted separately; keys use the prefix and expire with the window', async () => {
    const q = quota(10, 60 * SECOND);
    const [a, b] = [user(), user()];
    expect((await q.reserve(a, id(), 10)).allowed).toBe(true);
    expect((await q.reserve(a, id(), 1)).allowed).toBe(false);
    expect((await q.reserve(b, id(), 10)).allowed).toBe(true);
    const key = uploadQuotaKey(prefix, a);
    expect(key).toBe(`${prefix}upload-quota:${a}`);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(55 * SECOND);
    expect(ttl).toBeLessThanOrEqual(60 * SECOND);
  });

  it('release gives a reservation back', async () => {
    const q = quota(10);
    const u = user();
    const first = id();
    expect((await q.reserve(u, first, 10)).allowed).toBe(true);
    expect((await q.reserve(u, id(), 5)).allowed).toBe(false);
    await q.release(u, first, 10);
    expect((await q.reserve(u, id(), 5)).allowed).toBe(true);
  });

  it('50 concurrent reservations never overshoot', async () => {
    const q = quota(1000);
    const u = user();
    const results = await Promise.all(Array.from({ length: 50 }, () => q.reserve(u, id(), 30)));
    expect(results.filter((r) => r.allowed)).toHaveLength(33);
    const members = await redis.zrange(uploadQuotaKey(prefix, u), '0', '-1');
    const total = members.reduce<number>((sum, m) => sum + Number(m.split('|')[1]), 0);
    expect(total).toBe(990);
  });

  it('uses the Redis clock when none is injected', async () => {
    const q = createUploadQuota({ redis, prefix, limitBytes: 10, logger: silent });
    const u = user();
    expect((await q.reserve(u, id(), 10)).allowed).toBe(true);
    const [, score] = await redis.zrange(uploadQuotaKey(prefix, u), '0', '-1', 'WITHSCORES');
    expect(Math.abs(Number(score) - Date.now())).toBeLessThan(5_000);
    expect(await q.reserve(u, id(), 1)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 86_400,
    });
  });

  it('refuses a size that is not a whole positive number before touching Redis', async () => {
    const q = quota(10);
    const u = user();
    for (const bytes of [1.5, -5, 0, 1e21, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(q.reserve(u, id(), bytes), String(bytes)).rejects.toThrow(TypeError);
      await expect(q.release(u, id(), bytes), String(bytes)).rejects.toThrow(TypeError);
    }
    expect(await redis.exists(uploadQuotaKey(prefix, u))).toBe(0);
    // The budget still works for this user afterwards.
    expect(await q.reserve(u, id(), 10)).toEqual({ allowed: true });
    expect(await q.reserve(u, id(), 1)).toMatchObject({ allowed: false });
  });

  it('a member whose size cannot be read counts as 0 instead of disabling the budget', async () => {
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as Parameters<
      typeof createUploadQuota
    >[0]['logger'];
    const q = createUploadQuota({ redis, prefix, limitBytes: 10, logger, now: () => clock });
    const u = user();
    // Written by hand: what an older or foreign writer could leave behind.
    await redis.zadd(uploadQuotaKey(prefix, u), clock, 'a|1.5', clock, 'b|-5', clock, 'c|1e+21');
    expect(await q.reserve(u, id(), 10)).toEqual({ allowed: true });
    expect(await q.reserve(u, id(), 1)).toMatchObject({
      allowed: false,
      limitBytes: 10,
      retryAfterSeconds: 86_400,
    });
    expect(warnings).toEqual([]);
  });

  it('fails open when Redis is unavailable', async () => {
    const broken = createRedisClient('redis://127.0.0.1:1', undefined, 'quota-down');
    try {
      const q = createUploadQuota({ redis: broken, prefix, limitBytes: 1, logger: silent });
      expect(await q.reserve(user(), id(), 1)).toEqual({ allowed: true });
    } finally {
      broken.disconnect();
    }
  });
});

describe('POST /attachments/presign — daily budget', () => {
  const LIMIT = 1000;
  let ctx: TestContext;
  let w: World;
  let clock = Date.now();
  let failNextPost = false;

  beforeAll(async () => {
    const config = testConfig({ uploads: { dailyBytesPerUser: LIMIT } });
    const real = createStorage(config.s3);
    const storage: Storage = {
      ...real,
      async createUploadPost(input) {
        if (failNextPost) {
          failNextPost = false;
          throw new Error('storage down');
        }
        return real.createUploadPost(input);
      },
    };
    ctx = await createTestContext({ config, deps: { storage, uploadQuota: { now: () => clock } } });
    w = await createWorld(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const presign = (as: Persona, sizeBytes: number, extra: Record<string, unknown> = {}) =>
    apiAs(ctx, as).post('/attachments/presign', {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes,
      ...extra,
    });
  const rows = (uploaderId: string) => ctx.prisma.attachment.count({ where: { uploaderId } });

  it('the default budget is the shared constant (2 GiB)', () => {
    expect(testConfig().uploads.dailyBytesPerUser).toBe(DEFAULT_UPLOAD_DAILY_BYTES_PER_USER);
  });

  it('up to the limit → 201; one byte over → 429 RATE_LIMITED with daily-quota details, no row', async () => {
    const u = await w.newClientX();
    expect((await presign(u, 600)).statusCode).toBe(201);
    clock += 60 * SECOND;
    expect((await presign(u, 400)).statusCode).toBe(201);
    const res = await presign(u, 1);
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    const details = uploadQuotaDetailsSchema.parse(body.error.details);
    // The first 600 bytes free up 24 h after they were reserved (60 s ago).
    expect(details).toEqual({
      reason: 'daily-quota',
      limitBytes: LIMIT,
      retryAfterSeconds: 86_400 - 60,
    });
    expect(res.headers['retry-after']).toBe(String(86_400 - 60));
    expect(await rows(u.id)).toBe(2);
    // Staff have a budget too, their own.
    expect((await presign(w.agentA, LIMIT)).statusCode).toBe(201);
    expect((await presign(w.agentA, 1, { visibility: 'internal' })).statusCode).toBe(429);
  });

  it('bytes free up as reservations age out (rolling 24 h)', async () => {
    const u = await w.newClientX();
    const start = clock;
    expect((await presign(u, 700)).statusCode).toBe(201);
    clock = start + 2 * HOUR;
    expect((await presign(u, 300)).statusCode).toBe(201);
    clock = start + 3 * HOUR;
    expect((await presign(u, 500)).json().error.details.retryAfterSeconds).toBe(21 * 3600);
    clock = start + 24 * HOUR;
    expect((await presign(u, 500)).statusCode).toBe(201);
    expect((await presign(u, 300)).json().error.details.retryAfterSeconds).toBe(2 * 3600);
    clock = start + 26 * HOUR;
    expect((await presign(u, 300)).statusCode).toBe(201);
  });

  it('per user: another user is not affected; keys use the app prefix and expire', async () => {
    const [a, b] = [await w.newClientX(), await w.newClientX()];
    expect((await presign(a, LIMIT)).statusCode).toBe(201);
    expect((await presign(a, 1)).statusCode).toBe(429);
    expect((await presign(b, LIMIT)).statusCode).toBe(201);
    const key = `${ctx.config.redisPrefix}upload-quota:${a.id}`;
    expect(await ctx.redis.zcard(key)).toBe(1);
    const ttl = await ctx.redis.pttl(key);
    expect(ttl).toBeGreaterThan(UPLOAD_QUOTA_WINDOW_MS - 60 * SECOND);
    expect(ttl).toBeLessThanOrEqual(UPLOAD_QUOTA_WINDOW_MS);
  });

  it('50 concurrent presigns never overshoot', async () => {
    const u = await w.newClientX();
    const results = await Promise.all(Array.from({ length: 50 }, () => presign(u, 30)));
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(Math.floor(LIMIT / 30));
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(50 - created.length);
    const reserved = await ctx.prisma.attachment.aggregate({
      where: { uploaderId: u.id },
      _sum: { sizeBytes: true },
    });
    expect(reserved._sum.sizeBytes).toBe(990);
  });

  it('a file bigger than the whole budget → 400 file_too_large (it could never fit)', async () => {
    const u = await w.newClientX();
    const res = await presign(u, LIMIT + 1);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toContainEqual(
      expect.objectContaining({ path: ['sizeBytes'], code: 'file_too_large' }),
    );
    expect(LIMIT + 1).toBeLessThan(TICKET_LIMITS.attachmentMaxBytes);
  });

  it('refused presigns cost nothing; a presign that fails on the server gives its bytes back', async () => {
    const u = await w.newClientX();
    // Refused before the budget: bad type, internal for a client.
    expect((await presign(u, 900, { mimeType: 'text/html' })).statusCode).toBe(400);
    expect((await presign(u, 900, { visibility: 'internal' })).statusCode).toBe(403);
    // Storage fails after the reservation: 500 and the bytes are released.
    failNextPost = true;
    expect((await presign(u, 900)).statusCode).toBe(500);
    expect(await ctx.redis.zcard(`${ctx.config.redisPrefix}upload-quota:${u.id}`)).toBe(0);
    expect((await presign(u, LIMIT)).statusCode).toBe(201);
  });
});
