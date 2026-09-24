import proxyAddr from '@fastify/proxy-addr';
import { z } from 'zod';
import {
  isPlaceholderSecret,
  parseApiTokenTtl,
  parseBooleanEnv,
  parseStaffEmailDomain,
} from '@loons/shared';

// Environment → typed config. Validated once at startup; the process refuses to start on any
// problem (fail fast). Error messages name the variables, never their values.

/** Empty strings in .env mean "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

function requiredString(minLength = 1) {
  return z
    .string({ error: 'is required' })
    .trim()
    .min(minLength, { error: minLength > 1 ? `must be at least ${minLength} characters` : 'is required' });
}

/**
 * A variable parsed by one of the shared `@loons/shared` env parsers (the web app and the seed use
 * the same ones, so a value means the same thing everywhere). Their error becomes a config issue;
 * the issue path already names the variable, so it is dropped from the message.
 */
function sharedEnv<T>(name: string, parse: (value: string | undefined) => T) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parse(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'is invalid';
        ctx.addIssue({
          code: 'custom',
          message: message.startsWith(`${name} `) ? message.slice(name.length + 1) : message,
        });
        return z.NEVER;
      }
    });
}

/** Booleans: true/false, 1/0, yes/no, on/off (any case); blank → `defaultValue`. */
function envBool(name: string, defaultValue: boolean) {
  return sharedEnv(name, (value) => parseBooleanEnv(name, value, defaultValue));
}

function envInt(defaultValue: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });
}

const httpUrl = z
  .string({ error: 'is required' })
  .trim()
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { error: 'must be an http(s) URL' },
  );

/** Largest accepted TRUST_PROXY hop count. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/**
 * Which proxies in front of the API may set X-Forwarded-For (they decide `request.ip`, which the
 * rate limits and the logs use):
 * - blank / false / 0: none (the default; right for API_INTERNAL_URL traffic)
 * - a hop count, e.g. `1` for one load balancer: the connecting peer and the next n-1 addresses
 *   are trusted (only safe when the API can't be reached except through those proxies)
 * - a comma-separated list of proxy IPs / CIDRs (e.g. the VPC range): only those are trusted
 * `true` (trust every hop) is refused: a client could then pick its own address by sending an
 * X-Forwarded-For header.
 */
export type TrustProxy = false | number | string[];

const trustProxySchema = z
  .string()
  .optional()
  .transform((value, ctx): TrustProxy => {
    const v = value?.trim().toLowerCase() ?? '';
    if (['', 'false', '0', 'no', 'off'].includes(v)) return false;
    if (['true', 'yes', 'on'].includes(v)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must not be true: that trusts any X-Forwarded-For a client sends. Use the number of proxies in front of the API (e.g. 1 behind one load balancer) or their IPs / CIDRs',
      });
      return z.NEVER;
    }
    if (/^\d+$/.test(v)) {
      const hops = Number(v);
      if (hops > MAX_TRUSTED_PROXY_HOPS) {
        ctx.addIssue({ code: 'custom', message: `hop count must be between 1 and ${MAX_TRUSTED_PROXY_HOPS}` });
        return z.NEVER;
      }
      return hops;
    }
    const list = (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Checked with the parser Fastify itself applies at startup (address family, prefix length…).
    const invalid = list.findIndex((entry) => {
      try {
        proxyAddr.compile([entry]);
        return false;
      } catch {
        return true;
      }
    });
    if (invalid !== -1) {
      ctx.addIssue({
        code: 'custom',
        message: `entry ${invalid + 1} is not a valid IP address or CIDR range (use false, a hop count or a list of IPs / CIDRs)`,
      });
      return z.NEVER;
    }
    return list;
  });

/** Fastify's `trustProxy` option for a parsed TRUST_PROXY value. */
export function fastifyTrustProxy(
  trust: TrustProxy,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof trust !== 'number') return trust;
  // Fastify treats a bare number as "trust nothing", so the hop count is a trust function: hop 0
  // is the connecting peer; the first `trust` addresses are proxies, the next one is the client.
  return (_address, hop) => hop < trust;
}

const envSchema = z.object({
  // Unset means production (fail safe); the dev and test scripts set development / test.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: optionalString,
  npm_package_version: optionalString,

  APP_URL: httpUrl,
  API_HOST: z.string().trim().default('0.0.0.0'),
  API_PORT: envInt(4000, 0, 65535),
  CORS_ORIGINS: z.string({ error: 'is required' }),
  TRUST_PROXY: trustProxySchema,

  DATABASE_URL: requiredString(),
  DATABASE_POOL_SIZE: envInt(10, 1, 100),
  REDIS_URL: requiredString(),
  SOCKET_REDIS_ADAPTER: envBool('SOCKET_REDIS_ADAPTER', false),

  API_JWT_SECRET: requiredString(32),
  API_JWT_ISSUER: requiredString(),
  API_JWT_AUDIENCE: requiredString(),
  API_TOKEN_TTL_SECONDS: sharedEnv('API_TOKEN_TTL_SECONDS', parseApiTokenTtl),
  INTERNAL_API_KEY: requiredString(32),
  STAFF_EMAIL_DOMAIN: sharedEnv('STAFF_EMAIL_DOMAIN', parseStaffEmailDomain),
  AUTH_DEV_STAFF_LOGIN: envBool('AUTH_DEV_STAFF_LOGIN', false),

  S3_REGION: requiredString(),
  S3_BUCKET: requiredString(),
  S3_ENDPOINT: optionalString,
  S3_FORCE_PATH_STYLE: envBool('S3_FORCE_PATH_STYLE', false),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  UPLOAD_MAX_BYTES: envInt(25 * 1024 * 1024, 1, 5 * 1024 * 1024 * 1024),

  EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
  EMAIL_FROM: requiredString(),
  SMTP_HOST: z.string().trim().default('localhost'),
  SMTP_PORT: envInt(1025, 1, 65535),
  SMTP_SECURE: envBool('SMTP_SECURE', false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SES_REGION: optionalString,

  SMS_PROVIDER: z.enum(['console', 'sns']).default('console'),
  SNS_REGION: optionalString,
  SMS_SENDER_ID: optionalString,
});

type Env = z.infer<typeof envSchema>;

function parseOrigins(raw: string): { origins: string[]; invalid: boolean } {
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    if (value === '*') return { origins, invalid: true };
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { origins, invalid: true };
      origins.push(url.origin);
    } catch {
      return { origins, invalid: true };
    }
  }
  return { origins, invalid: origins.length === 0 };
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  version: string;
  logLevel: Env['LOG_LEVEL'];
  appUrl: string;
  host: string;
  port: number;
  corsOrigins: string[];
  trustProxy: TrustProxy;
  databaseUrl: string;
  databasePoolSize: number;
  redisUrl: string;
  socketRedisAdapter: boolean;
  /** Key prefix for everything this app stores in Redis (cache, rate limits, queues…). */
  redisPrefix: string;
  jwt: { secret: string; issuer: string; audience: string; ttlSeconds: number };
  internalApiKey: string;
  staffEmailDomain: string;
  /** Password sign-in for staff: only when AUTH_DEV_STAFF_LOGIN=true AND not production. */
  devStaffLogin: boolean;
  s3: {
    region: string;
    bucket: string;
    endpoint: string | undefined;
    forcePathStyle: boolean;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    uploadMaxBytes: number;
  };
  email: {
    provider: 'smtp' | 'ses';
    from: string;
    smtp: { host: string; port: number; secure: boolean; user: string | undefined; password: string | undefined };
    sesRegion: string | undefined;
  };
  sms: { provider: 'console' | 'sns'; snsRegion: string | undefined; senderId: string | undefined };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'} ${issue.message}`),
    );
  }
  const env = parsed.data;
  const problems: string[] = [];
  const isProduction = env.NODE_ENV === 'production';

  const cors = parseOrigins(env.CORS_ORIGINS);
  if (cors.invalid) problems.push('CORS_ORIGINS must be a comma-separated list of http(s) origins (no "*")');

  // The placeholder values in .env.example are public: refused everywhere except the test suite.
  if (env.NODE_ENV !== 'test') {
    for (const key of ['API_JWT_SECRET', 'INTERNAL_API_KEY'] as const) {
      if (isPlaceholderSecret(env[key])) problems.push(`${key} still has the placeholder value`);
    }
  }
  if (env.API_JWT_SECRET === env.INTERNAL_API_KEY) {
    problems.push('API_JWT_SECRET and INTERNAL_API_KEY must be different secrets');
  }
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
    problems.push('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together (or both left empty)');
  }
  if (env.S3_ENDPOINT) {
    try {
      new URL(env.S3_ENDPOINT);
    } catch {
      problems.push('S3_ENDPOINT must be a URL');
    }
  }
  if (env.EMAIL_PROVIDER === 'ses' && !env.SES_REGION) problems.push('SES_REGION is required when EMAIL_PROVIDER=ses');
  if (env.SMS_PROVIDER === 'sns' && !env.SNS_REGION) problems.push('SNS_REGION is required when SMS_PROVIDER=sns');
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: env.NODE_ENV,
    isProduction,
    version: env.APP_VERSION ?? env.npm_package_version ?? '0.0.0',
    logLevel: env.LOG_LEVEL,
    appUrl: env.APP_URL.replace(/\/+$/, ''),
    host: env.API_HOST,
    port: env.API_PORT,
    corsOrigins: cors.origins,
    trustProxy: env.TRUST_PROXY,
    databaseUrl: env.DATABASE_URL,
    databasePoolSize: env.DATABASE_POOL_SIZE,
    redisUrl: env.REDIS_URL,
    socketRedisAdapter: env.SOCKET_REDIS_ADAPTER,
    redisPrefix: 'loons:',
    jwt: {
      secret: env.API_JWT_SECRET,
      issuer: env.API_JWT_ISSUER,
      audience: env.API_JWT_AUDIENCE,
      ttlSeconds: env.API_TOKEN_TTL_SECONDS,
    },
    internalApiKey: env.INTERNAL_API_KEY,
    staffEmailDomain: env.STAFF_EMAIL_DOMAIN,
    devStaffLogin: env.AUTH_DEV_STAFF_LOGIN && !isProduction,
    s3: {
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      uploadMaxBytes: env.UPLOAD_MAX_BYTES,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      from: env.EMAIL_FROM,
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
      },
      sesRegion: env.SES_REGION,
    },
    sms: { provider: env.SMS_PROVIDER, snsRegion: env.SNS_REGION, senderId: env.SMS_SENDER_ID },
  };
}
