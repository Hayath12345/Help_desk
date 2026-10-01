import { describe, expect, it } from 'vitest';
import { API_TOKEN_TTL, DEFAULT_UPLOAD_DAILY_BYTES_PER_USER } from '@loons/shared';
import {
  ConfigError,
  DEFAULT_SMS_MAX_PER_RECIPIENT_PER_HOUR,
  DEFAULT_TEAMS_TIMEOUT_MS,
  DEFAULT_TEAMS_WEBHOOK_HOSTS,
  deployProfileWarning,
  fastifyTrustProxy,
  loadConfig,
} from './config.ts';
import { DEFAULT_REALTIME_LIMITS } from './realtime/limits.ts';

const base: NodeJS.ProcessEnv = {
  APP_URL: 'http://localhost:3000/',
  CORS_ORIGINS: 'http://localhost:3000, https://help.example.com',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  API_JWT_SECRET: 'j'.repeat(43),
  API_JWT_ISSUER: 'loons-web',
  API_JWT_AUDIENCE: 'loons-api',
  INTERNAL_API_KEY: 'k'.repeat(43),
  S3_REGION: 'me-central-1',
  S3_BUCKET: 'bucket',
  EMAIL_FROM: 'Loons Support <support@example.com>',
  // These tests use developer-machine settings (http URLs, MinIO...); the strict production
  // rules have their own tests at the end of this file.
  DEPLOY_PROFILE: 'rehearsal',
};
const dev: NodeJS.ProcessEnv = { ...base, NODE_ENV: 'development' };

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('parses a minimal environment with defaults', () => {
    const c = loadConfig(dev);
    expect(c.env).toBe('development');
    expect(c.port).toBe(4000);
    expect(c.appUrl).toBe('http://localhost:3000');
    expect(c.corsOrigins).toEqual(['http://localhost:3000', 'https://help.example.com']);
    expect(c.trustProxy).toBe(false);
    expect(c.socketRedisAdapter).toBe(false);
    expect(c.email.provider).toBe('smtp');
    expect(c.sms.provider).toBe('console');
    expect(c.s3.uploadMaxBytes).toBe(25 * 1024 * 1024);
    expect(c.staffEmailDomain).toBe('loonsgroup.com');
    expect(c.jwt.ttlSeconds).toBe(API_TOKEN_TTL.defaultSeconds);
  });

  it('an unset NODE_ENV means production (fail safe): no dev staff login', () => {
    const c = loadConfig({ ...base, AUTH_DEV_STAFF_LOGIN: 'true' });
    expect(c.env).toBe('production');
    expect(c.isProduction).toBe(true);
    expect(c.devStaffLogin).toBe(false);
  });

  it('parses booleans from strings (the shared parser)', () => {
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: 'TRUE' }).socketRedisAdapter).toBe(true);
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: '0' }).socketRedisAdapter).toBe(false);
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: '' }).socketRedisAdapter).toBe(false);
    expect(problemsOf({ ...base, SOCKET_REDIS_ADAPTER: 'maybe' })).toEqual([
      'SOCKET_REDIS_ADAPTER must be true or false',
    ]);
  });

  it('dev staff login needs the flag AND a non-production environment', () => {
    expect(loadConfig({ ...dev, AUTH_DEV_STAFF_LOGIN: 'true' }).devStaffLogin).toBe(true);
    expect(loadConfig({ ...dev, AUTH_DEV_STAFF_LOGIN: 'false' }).devStaffLogin).toBe(false);
    expect(loadConfig({ ...dev }).devStaffLogin).toBe(false);
    expect(
      loadConfig({ ...base, AUTH_DEV_STAFF_LOGIN: 'true', NODE_ENV: 'production' }).devStaffLogin,
    ).toBe(false);
  });

  it('AUTH_DEV_STAFF_LOGIN is read like the web app reads it (same parser)', () => {
    for (const on of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
      expect(loadConfig({ ...dev, AUTH_DEV_STAFF_LOGIN: on }).devStaffLogin, on).toBe(true);
    }
    expect(problemsOf({ ...dev, AUTH_DEV_STAFF_LOGIN: 'enabled' })).toEqual([
      'AUTH_DEV_STAFF_LOGIN must be true or false',
    ]);
  });

  it('STAFF_EMAIL_DOMAIN: blank means the default (like the web app and the seed)', () => {
    expect(loadConfig({ ...base, STAFF_EMAIL_DOMAIN: '' }).staffEmailDomain).toBe('loonsgroup.com');
    expect(loadConfig({ ...base, STAFF_EMAIL_DOMAIN: '   ' }).staffEmailDomain).toBe(
      'loonsgroup.com',
    );
    expect(
      loadConfig({ ...base, STAFF_EMAIL_DOMAIN: ' Staff.Example.COM ' }).staffEmailDomain,
    ).toBe('staff.example.com');
    expect(problemsOf({ ...base, STAFF_EMAIL_DOMAIN: 'not a domain' })).toEqual([
      'STAFF_EMAIL_DOMAIN must be a domain like example.com',
    ]);
  });

  it('API_TOKEN_TTL_SECONDS uses the range shared with the web app', () => {
    expect(loadConfig({ ...base, API_TOKEN_TTL_SECONDS: '60' }).jwt.ttlSeconds).toBe(60);
    expect(loadConfig({ ...base, API_TOKEN_TTL_SECONDS: '3600' }).jwt.ttlSeconds).toBe(3600);
    for (const bad of ['45', '59', '3601', '86400', '12.5', 'soon']) {
      expect(problemsOf({ ...base, API_TOKEN_TTL_SECONDS: bad }), bad).toEqual([
        `API_TOKEN_TTL_SECONDS must be an integer between ${API_TOKEN_TTL.minSeconds} and ${API_TOKEN_TTL.maxSeconds}`,
      ]);
    }
  });

  describe('TRUST_PROXY', () => {
    it('blank / false / 0 → no proxy', () => {
      for (const value of [undefined, '', 'false', '0', 'no']) {
        expect(loadConfig({ ...base, TRUST_PROXY: value }).trustProxy, String(value)).toBe(false);
      }
    });

    it('a positive integer is a hop count (1 = one load balancer), not "trust everything"', () => {
      expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
      expect(loadConfig({ ...base, TRUST_PROXY: ' 2 ' }).trustProxy).toBe(2);
      expect(loadConfig({ ...base, TRUST_PROXY: '3' }).trustProxy).toBe(3);
    });

    it('refuses more hops than one ALB behind a CDN could add (3): a typo would trust client entries', () => {
      for (const value of ['4', '10', '11', '100']) {
        expect(problemsOf({ ...base, TRUST_PROXY: value }), value).toEqual([
          'TRUST_PROXY hop count must be between 1 and 3 (one load balancer is 1; CloudFront in front of it is 2)',
        ]);
      }
    });

    it('true is refused: it would let clients choose their own IP', () => {
      for (const value of ['true', 'TRUE', 'yes']) {
        const problems = problemsOf({ ...base, TRUST_PROXY: value });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(
          /^TRUST_PROXY must not be true: that trusts any X-Forwarded-For/,
        );
      }
    });

    it('accepts IP / CIDR lists and rejects impossible ones as a ConfigError', () => {
      expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toEqual([
        '10.0.0.0/8',
        '127.0.0.1',
      ]);
      expect(loadConfig({ ...base, TRUST_PROXY: 'fd00::/8,loopback' }).trustProxy).toEqual([
        'fd00::/8',
        'loopback',
      ]);
      expect(problemsOf({ ...base, TRUST_PROXY: '10.0.0.0/99' })).toEqual([
        'TRUST_PROXY entry 1 is not a valid IP address or CIDR range (use false, a hop count or a list of IPs / CIDRs)',
      ]);
      expect(problemsOf({ ...base, TRUST_PROXY: '127.0.0.1, 10.0.0.0/33' })[0]).toMatch(
        /^TRUST_PROXY entry 2 /,
      );
      expect(problemsOf({ ...base, TRUST_PROXY: '::1/200' })).toHaveLength(1);
      expect(problemsOf({ ...base, TRUST_PROXY: 'proxy.internal' })).toHaveLength(1);
    });

    it('maps to Fastify: a hop count becomes a trust function (Fastify ignores bare numbers)', () => {
      expect(fastifyTrustProxy(false)).toBe(false);
      expect(fastifyTrustProxy(['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
      const trust = fastifyTrustProxy(1);
      expect(typeof trust).toBe('function');
      const fn = trust as (address: string, hop: number) => boolean;
      expect([fn('10.0.0.1', 0), fn('203.0.113.9', 1)]).toEqual([true, false]);
    });
  });

  it('realtime limits: the code defaults, or positive integers from REALTIME_*', () => {
    expect(loadConfig(dev).realtime).toEqual({
      socketsPerUser: DEFAULT_REALTIME_LIMITS.socketsPerUser,
      socketsPerIp: DEFAULT_REALTIME_LIMITS.socketsPerIp,
      handshakesPerIp: DEFAULT_REALTIME_LIMITS.handshakesPerIp,
      pendingConnectionsPerIp: DEFAULT_REALTIME_LIMITS.pendingConnectionsPerIp,
    });
    expect(loadConfig(dev).realtime).toEqual({
      socketsPerUser: 20,
      socketsPerIp: 500,
      handshakesPerIp: { burst: 200, perSecond: 20 },
      pendingConnectionsPerIp: 50,
    });
    const tuned = loadConfig({
      ...dev,
      REALTIME_SOCKETS_PER_USER: '30',
      REALTIME_SOCKETS_PER_IP: ' 2000 ',
      REALTIME_HANDSHAKES_PER_IP_BURST: '600',
      REALTIME_HANDSHAKES_PER_IP_PER_SECOND: '60',
      REALTIME_PENDING_CONNECTIONS_PER_IP: '100',
    });
    expect(tuned.realtime).toEqual({
      socketsPerUser: 30,
      socketsPerIp: 2000,
      handshakesPerIp: { burst: 600, perSecond: 60 },
      pendingConnectionsPerIp: 100,
    });
    // Blank means the default.
    expect(loadConfig({ ...dev, REALTIME_SOCKETS_PER_IP: '' }).realtime.socketsPerIp).toBe(500);
    for (const name of [
      'REALTIME_SOCKETS_PER_USER',
      'REALTIME_SOCKETS_PER_IP',
      'REALTIME_HANDSHAKES_PER_IP_BURST',
      'REALTIME_HANDSHAKES_PER_IP_PER_SECOND',
      'REALTIME_PENDING_CONNECTIONS_PER_IP',
    ]) {
      for (const value of ['0', '-5', '1.5', 'many', '1e9']) {
        const problems = problemsOf({ ...dev, [name]: value });
        expect(problems, `${name}=${value}`).toHaveLength(1);
        expect(problems[0], `${name}=${value}`).toMatch(new RegExp(`^${name} must be an integer`));
      }
    }
  });

  it('UPLOAD_DAILY_BYTES_PER_USER: the shared default, or a positive integer', () => {
    expect(loadConfig(dev).uploads.dailyBytesPerUser).toBe(DEFAULT_UPLOAD_DAILY_BYTES_PER_USER);
    expect(DEFAULT_UPLOAD_DAILY_BYTES_PER_USER).toBe(2 * 1024 ** 3);
    expect(loadConfig({ ...dev, UPLOAD_DAILY_BYTES_PER_USER: '' }).uploads.dailyBytesPerUser).toBe(
      DEFAULT_UPLOAD_DAILY_BYTES_PER_USER,
    );
    expect(
      loadConfig({ ...dev, UPLOAD_DAILY_BYTES_PER_USER: ' 5000000000 ' }).uploads.dailyBytesPerUser,
    ).toBe(5_000_000_000);
    for (const value of ['0', '-1', '1.5', 'lots', '2GB', '1e400']) {
      const problems = problemsOf({ ...dev, UPLOAD_DAILY_BYTES_PER_USER: value });
      expect(problems, value).toHaveLength(1);
      expect(problems[0]).toMatch(/^UPLOAD_DAILY_BYTES_PER_USER must be an integer/);
    }
  });

  it('rejects wildcard or invalid CORS origins', () => {
    expect(problemsOf({ ...base, CORS_ORIGINS: '*' })[0]).toContain('CORS_ORIGINS');
    expect(problemsOf({ ...base, CORS_ORIGINS: 'not a url' })[0]).toContain('CORS_ORIGINS');
  });

  it('fails fast listing variable names, never values', () => {
    const secret = 'short-secret';
    const problems = problemsOf({ ...base, API_JWT_SECRET: secret, DATABASE_URL: '' });
    expect(problems.some((p) => p.startsWith('API_JWT_SECRET'))).toBe(true);
    expect(problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
    expect(problems.join('\n')).not.toContain(secret);
  });

  it('refuses placeholder secrets in every environment except test, and identical secrets anywhere', () => {
    const placeholder = 'replace-me-with-32+-random-bytes';
    for (const NODE_ENV of [undefined, 'development', 'production']) {
      expect(
        problemsOf({ ...base, NODE_ENV, API_JWT_SECRET: placeholder }),
        String(NODE_ENV),
      ).toEqual(['API_JWT_SECRET still has the placeholder value']);
      expect(
        problemsOf({ ...base, NODE_ENV, INTERNAL_API_KEY: `${placeholder}-x` }),
        String(NODE_ENV),
      ).toEqual(['INTERNAL_API_KEY still has the placeholder value']);
    }
    expect(loadConfig({ ...base, NODE_ENV: 'test', API_JWT_SECRET: placeholder }).jwt.secret).toBe(
      placeholder,
    );
    expect(problemsOf({ ...base, INTERNAL_API_KEY: base.API_JWT_SECRET })).toEqual([
      'API_JWT_SECRET and INTERNAL_API_KEY must be different secrets',
    ]);
  });

  it('requires provider regions for AWS transports and paired S3 keys', () => {
    expect(problemsOf({ ...base, EMAIL_PROVIDER: 'ses' })).toEqual([
      'SES_REGION is required when EMAIL_PROVIDER=ses',
    ]);
    expect(problemsOf({ ...base, SMS_PROVIDER: 'sns' })).toEqual([
      'SNS_REGION is required when SMS_PROVIDER=sns',
    ]);
    expect(problemsOf({ ...base, S3_ACCESS_KEY_ID: 'only-one' })).toHaveLength(1);
  });

  it('Phase 3: Teams provider, webhook host allow-list, timeouts, SMS cap and worker schedulers', () => {
    const c = loadConfig(dev);
    expect(c.teams).toEqual({
      provider: 'console',
      webhookHosts: [...DEFAULT_TEAMS_WEBHOOK_HOSTS],
      timeoutMs: DEFAULT_TEAMS_TIMEOUT_MS,
    });
    expect(c.sms.maxPerRecipientPerHour).toBe(DEFAULT_SMS_MAX_PER_RECIPIENT_PER_HOUR);
    expect(c.worker.schedulers).toBe(true);

    const custom = loadConfig({
      ...dev,
      TEAMS_PROVIDER: 'webhook',
      TEAMS_WEBHOOK_HOSTS: ' Hooks.Example.com , *.logic.azure.com ',
      TEAMS_TIMEOUT_MS: '5000',
      SMS_MAX_PER_RECIPIENT_PER_HOUR: '3',
      WORKER_SCHEDULERS: 'false',
    });
    expect(custom.teams).toEqual({
      provider: 'webhook',
      webhookHosts: ['hooks.example.com', '*.logic.azure.com'],
      timeoutMs: 5000,
    });
    expect(custom.sms.maxPerRecipientPerHour).toBe(3);
    expect(custom.worker.schedulers).toBe(false);

    expect(problemsOf({ ...dev, TEAMS_PROVIDER: 'slack' })).toHaveLength(1);
    expect(
      problemsOf({ ...dev, TEAMS_WEBHOOK_HOSTS: 'hooks.example.com, https://x.com/' }),
    ).toEqual(['TEAMS_WEBHOOK_HOSTS entry 2 is not a host name or *.domain pattern']);
    expect(problemsOf({ ...dev, TEAMS_WEBHOOK_HOSTS: '*' })).toHaveLength(1);
    expect(problemsOf({ ...dev, TEAMS_TIMEOUT_MS: '100' })).toEqual([
      'TEAMS_TIMEOUT_MS must be an integer between 1000 and 60000',
    ]);
    expect(problemsOf({ ...dev, SMS_MAX_PER_RECIPIENT_PER_HOUR: '0' })).toEqual([
      'SMS_MAX_PER_RECIPIENT_PER_HOUR must be an integer between 1 and 1000',
    ]);
    expect(problemsOf({ ...dev, WORKER_SCHEDULERS: 'sometimes' })).toEqual([
      'WORKER_SCHEDULERS must be true or false',
    ]);
  });
});

// ───────────── Phase 6: production-only rules (config-production.ts) ─────────────

/** Everything a real AWS deployment sets; each test below breaks exactly one thing. */
const aws: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  APP_URL: 'https://help.example.com',
  CORS_ORIGINS: 'https://help.example.com',
  DATABASE_URL:
    'postgresql://u:p@loons.abc.me-central-1.rds.amazonaws.com:5432/loons?sslmode=verify-full&sslrootcert=/app/certs/rds.pem',
  REDIS_URL: 'rediss://master.loons.abc.mec1.cache.amazonaws.com:6379',
  SOCKET_REDIS_ADAPTER: 'true',
  TRUST_PROXY: '1',
  API_JWT_SECRET: 'j'.repeat(43),
  API_JWT_ISSUER: 'loons-web',
  API_JWT_AUDIENCE: 'loons-api',
  INTERNAL_API_KEY: 'k'.repeat(43),
  S3_REGION: 'me-central-1',
  S3_BUCKET: 'loons-helpdesk-attachments',
  EMAIL_PROVIDER: 'ses',
  EMAIL_FROM: 'Loons Support <support@example.com>',
  SES_REGION: 'me-central-1',
  SMS_PROVIDER: 'sns',
  SNS_REGION: 'me-central-1',
  TEAMS_PROVIDER: 'webhook',
};

describe('production rules (DEPLOY_PROFILE=aws, the default)', () => {
  it('accepts a complete AWS configuration', () => {
    expect(problemsOf(aws)).toEqual([]);
    const c = loadConfig(aws);
    expect(c.deployProfile).toBe('aws');
    expect(c.docsEnabled).toBe(false);
    expect(c.isProduction).toBe(true);
  });

  it('is the default when DEPLOY_PROFILE is unset or blank, and only in production', () => {
    expect(loadConfig({ ...aws, DEPLOY_PROFILE: undefined }).deployProfile).toBe('aws');
    expect(loadConfig({ ...aws, DEPLOY_PROFILE: '  ' }).deployProfile).toBe('aws');
    // An unset NODE_ENV is production: the developer-machine settings are refused.
    expect(problemsOf({ ...base, DEPLOY_PROFILE: undefined }).length).toBeGreaterThan(5);
    // Development and test are never held to them.
    expect(problemsOf({ ...base, DEPLOY_PROFILE: undefined, NODE_ENV: 'development' })).toEqual([]);
    expect(problemsOf({ ...base, DEPLOY_PROFILE: 'aws', NODE_ENV: 'test' })).toEqual([]);
  });

  it('DEPLOY_PROFILE=rehearsal switches the rules off and warns; other values are refused', () => {
    const rehearsal = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(rehearsal.deployProfile).toBe('rehearsal');
    expect(deployProfileWarning(rehearsal)).toMatch(/^DEPLOY_PROFILE=rehearsal: /);
    expect(deployProfileWarning(loadConfig(aws))).toBeUndefined();
    expect(deployProfileWarning(loadConfig(dev))).toBeUndefined();
    expect(problemsOf({ ...aws, DEPLOY_PROFILE: 'staging' })).toEqual([
      'DEPLOY_PROFILE must be one of aws, rehearsal',
    ]);
    expect(loadConfig({ ...aws, DEPLOY_PROFILE: ' AWS ' }).deployProfile).toBe('aws');
  });

  it('refuses a plain-HTTP or localhost APP_URL and CORS origin', () => {
    expect(problemsOf({ ...aws, APP_URL: 'http://help.example.com' })).toEqual([
      'APP_URL must be an https:// URL in production',
    ]);
    expect(problemsOf({ ...aws, APP_URL: 'https://localhost:3000' })).toEqual([
      'APP_URL must not point at localhost in production',
    ]);
    const cors = 'CORS_ORIGINS must list https:// origins (not localhost) in production';
    expect(problemsOf({ ...aws, CORS_ORIGINS: 'http://help.example.com' })).toEqual([cors]);
    expect(
      problemsOf({ ...aws, CORS_ORIGINS: 'https://help.example.com,http://x.example' }),
    ).toEqual([cors]);
    expect(problemsOf({ ...aws, CORS_ORIGINS: 'https://localhost:3000' })).toEqual([cors]);
    expect(
      loadConfig({ ...aws, CORS_ORIGINS: 'https://a.example.com, https://b.example.com' })
        .corsOrigins,
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('requires verified TLS to the database: only sslmode=verify-full passes', () => {
    const url = (query: string) => `postgresql://u:p@db.example.com:5432/loons${query}`;
    const message =
      'DATABASE_URL must use verified TLS in production: add sslmode=verify-full (and sslrootcert=<RDS CA bundle>)';
    for (const query of ['?sslmode=verify-full', '?a=1&sslmode=VERIFY-FULL']) {
      expect(problemsOf({ ...aws, DATABASE_URL: url(query) }), query).toEqual([]);
    }
    for (const query of [
      '',
      '?sslmode=require',
      '?sslmode=verify-ca',
      '?sslmode=disable',
      '?sslmode=prefer',
      '?sslmode=allow',
      '?ssl=true',
    ]) {
      expect(problemsOf({ ...aws, DATABASE_URL: url(query) }), query).toEqual([message]);
    }
    expect(problemsOf({ ...aws, DATABASE_URL: 'not a url' })).toEqual([message]);
  });

  it('refuses a repeated sslmode parameter whatever its values (node-postgres applies the last)', () => {
    const url = (query: string) => `postgresql://u:p@db.example.com:5432/loons?${query}`;
    const message = 'DATABASE_URL must carry exactly one sslmode parameter (sslmode=verify-full)';
    for (const query of [
      'sslmode=verify-full&sslmode=disable',
      'sslmode=disable&sslmode=verify-full',
      'sslmode=verify-full&sslmode=verify-full',
      'sslmode=verify-full&a=1&SSLMODE=x&sslmode=require',
    ]) {
      // The upper-case name is a different parameter; the others are repeats of sslmode.
      const expected = query.split('&').filter((p) => p.startsWith('sslmode=')).length > 1;
      expect(problemsOf({ ...aws, DATABASE_URL: url(query) }), query).toEqual(
        expected ? [message] : [],
      );
    }
  });

  it('requires TLS to Redis (rediss://)', () => {
    const message = 'REDIS_URL must use TLS (rediss://) in production';
    expect(problemsOf({ ...aws, REDIS_URL: 'redis://cache.example.com:6379' })).toEqual([message]);
    expect(problemsOf({ ...aws, REDIS_URL: 'REDISS://cache.example.com:6379' })).toEqual([]);
  });

  it('always needs the Socket.IO Redis adapter on AWS (a service can scale past one task at any time)', () => {
    const message =
      'SOCKET_REDIS_ADAPTER must be true in production (events would not reach users connected to another API task)';
    expect(problemsOf({ ...aws, SOCKET_REDIS_ADAPTER: 'false' })).toEqual([message]);
    expect(problemsOf({ ...aws, SOCKET_REDIS_ADAPTER: undefined })).toEqual([message]);
    // The old declared-count escape hatch no longer exists.
    expect(problemsOf({ ...aws, SOCKET_REDIS_ADAPTER: 'false', API_INSTANCE_COUNT: '1' })).toEqual([
      message,
    ]);
    expect(loadConfig(aws).socketRedisAdapter).toBe(true);
  });

  it('needs TRUST_PROXY (a hop count or proxy addresses), never "no proxy"', () => {
    for (const value of [undefined, '', 'false', '0']) {
      const problems = problemsOf({ ...aws, TRUST_PROXY: value });
      expect(problems, String(value)).toHaveLength(1);
      expect(problems[0]).toMatch(/^TRUST_PROXY must be set in production/);
    }
    expect(problemsOf({ ...aws, TRUST_PROXY: '10.0.0.0/16' })).toEqual([]);
    expect(problemsOf({ ...aws, TRUST_PROXY: '2' })).toEqual([]);
  });

  it('S3: no custom endpoint, no path-style addressing, no static keys', () => {
    expect(problemsOf({ ...aws, S3_ENDPOINT: 'http://minio:9000' })).toEqual([
      'S3_ENDPOINT must be empty in production (AWS S3 is addressed by region)',
    ]);
    expect(problemsOf({ ...aws, S3_FORCE_PATH_STYLE: 'true' })).toEqual([
      'S3_FORCE_PATH_STYLE must be false in production',
    ]);
    const keys =
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be empty in production (use the task / pod IAM role)';
    expect(problemsOf({ ...aws, S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 's' })).toEqual([
      keys,
    ]);
    // One half of a pair is wrong everywhere; in production it is also a static key.
    expect(problemsOf({ ...aws, S3_ACCESS_KEY_ID: 'AKIA' })).toHaveLength(2);
    expect(loadConfig(aws).s3).toMatchObject({
      endpoint: undefined,
      accessKeyId: undefined,
      secretAccessKey: undefined,
    });
  });

  it('allows only the ses / sns / webhook providers', () => {
    expect(problemsOf({ ...aws, EMAIL_PROVIDER: 'smtp' })).toEqual([
      'EMAIL_PROVIDER must be ses in production',
    ]);
    expect(problemsOf({ ...aws, SMS_PROVIDER: 'console' })).toEqual([
      'SMS_PROVIDER must be sns in production',
    ]);
    expect(problemsOf({ ...aws, TEAMS_PROVIDER: 'console' })).toEqual([
      'TEAMS_PROVIDER must be webhook in production',
    ]);
    // The default of each is the local one, so leaving them out is refused too.
    expect(problemsOf({ ...aws, EMAIL_PROVIDER: undefined })).toHaveLength(1);
    expect(problemsOf({ ...aws, SMS_PROVIDER: undefined })).toHaveLength(1);
    expect(problemsOf({ ...aws, TEAMS_PROVIDER: undefined })).toHaveLength(1);
  });

  it('every AWS region setting must look like a region (G8: configurable per service)', () => {
    for (const name of ['S3_REGION', 'SES_REGION', 'SNS_REGION']) {
      for (const bad of ['qatar', 'me-central', 'ME_CENTRAL_1', 'https://email.us-east-1.aws']) {
        expect(problemsOf({ ...aws, [name]: bad }), `${name}=${bad}`).toEqual([
          `${name} must be an AWS region such as me-central-1`,
        ]);
      }
      expect(loadConfig({ ...aws, [name]: 'eu-west-1' })).toBeDefined();
    }
    const c = loadConfig({ ...aws, SES_REGION: 'eu-central-1', SNS_REGION: 'eu-west-1' });
    expect([c.s3.region, c.email.sesRegion, c.sms.snsRegion]).toEqual([
      'me-central-1',
      'eu-central-1',
      'eu-west-1',
    ]);
  });

  it('lists every problem at once, naming variables and never leaking values', () => {
    const password = 'hunter2-db-password';
    const problems = problemsOf({
      ...aws,
      DATABASE_URL: `postgresql://loons:${password}@db.example.com/loons`,
      REDIS_URL: 'redis://cache.example.com',
      APP_URL: 'http://help.example.com',
      EMAIL_PROVIDER: 'smtp',
    });
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).not.toContain(password);
  });

  it('WORKER_HEARTBEAT_FILE: blank = none, otherwise the path', () => {
    expect(loadConfig(dev).worker.heartbeatFile).toBeUndefined();
    expect(loadConfig({ ...dev, WORKER_HEARTBEAT_FILE: ' /tmp/hb ' }).worker.heartbeatFile).toBe(
      '/tmp/hb',
    );
  });
});

describe('REDIS_KEY_PREFIX', () => {
  it('defaults to loons: and namespaces every Redis key when set', () => {
    expect(loadConfig(dev).redisPrefix).toBe('loons:');
    expect(loadConfig({ ...dev, REDIS_KEY_PREFIX: '  ' }).redisPrefix).toBe('loons:');
    expect(loadConfig({ ...dev, REDIS_KEY_PREFIX: 'loons-rehearsal_1' }).redisPrefix).toBe(
      'loons-rehearsal_1:',
    );
  });

  it('refuses characters that would break key patterns or the queue prefix', () => {
    for (const bad of ['a:b', 'a b', '-x', 'a*', 'a'.repeat(33), 'ü']) {
      expect(problemsOf({ ...dev, REDIS_KEY_PREFIX: bad }), bad).toEqual([
        'REDIS_KEY_PREFIX must be 1-32 letters, digits, "-" or "_" (no colon: it is added), starting with a letter or digit',
      ]);
    }
  });
});

describe('production rules: addresses, placeholders and credentials', () => {
  it('refuses every loopback / unspecified address as APP_URL and CORS origin, not only 127.0.0.1', () => {
    const cors = 'CORS_ORIGINS must list https:// origins (not localhost) in production';
    for (const host of [
      '127.0.0.2',
      '127.1.2.3',
      '0.0.0.0',
      '[::1]',
      '[::ffff:127.0.0.1]',
      'localhost',
      'app.localhost',
      '2130706433', // 127.0.0.1 as one integer: URL normalises it
    ]) {
      expect(problemsOf({ ...aws, APP_URL: `https://${host}` }), host).toEqual([
        'APP_URL must not point at localhost in production',
      ]);
      expect(problemsOf({ ...aws, CORS_ORIGINS: `https://${host}:3000` }), host).toEqual([cors]);
    }
    expect(problemsOf({ ...aws, APP_URL: 'https://128.0.0.1' })).toEqual([]);
    expect(problemsOf({ ...aws, CORS_ORIGINS: 'https://help.example.com' })).toEqual([]);
  });

  it('refuses a template placeholder left in DATABASE_URL or REDIS_URL (with its own message)', () => {
    const db = (host: string, password = 'pw') =>
      `postgresql://u:${password}@${host}:5432/loons?sslmode=verify-full`;
    const message = (name: string) =>
      `${name} still contains a placeholder (<...> or replace-me): put the real endpoint and credentials in`;
    expect(problemsOf({ ...aws, DATABASE_URL: db('<rds-endpoint>') })).toEqual([
      message('DATABASE_URL'),
    ]);
    expect(
      problemsOf({ ...aws, DATABASE_URL: db('db.example.com', 'replace-me-password') }),
    ).toEqual([message('DATABASE_URL')]);
    expect(
      problemsOf({ ...aws, REDIS_URL: 'rediss://default:tok@<elasticache-primary-endpoint>:6379' }),
    ).toEqual([message('REDIS_URL')]);
    expect(
      problemsOf({ ...aws, REDIS_URL: 'rediss://default:replace-me-token@cache.example.com:6379' }),
    ).toEqual([message('REDIS_URL')]);
    // The message never contains the value.
    expect(
      JSON.stringify(problemsOf({ ...aws, DATABASE_URL: db('<rds-endpoint>', 's3cr3t') })),
    ).not.toContain('s3cr3t');
  });

  it('refuses credentials that were not percent-encoded, and accepts encoded ones', () => {
    const encoding = (name: string) =>
      `${name} has a user name or password with characters that must be percent-encoded (@ / ? # % [ ] < > space ...: write # as %23, @ as %40, / as %2F); or use an alphanumeric password`;
    const db = (userInfo: string) =>
      `postgresql://${userInfo}@db.example.com:5432/loons?sslmode=verify-full`;
    for (const bad of [
      'u:pa#ss',
      'u:pa?ss',
      'u:pa/ss',
      'u:pa@ss',
      'u:pa ss',
      'u:100%',
      'u:p[a]ss',
      'u:p"q',
    ]) {
      expect(problemsOf({ ...aws, DATABASE_URL: db(bad) }), bad).toEqual([
        encoding('DATABASE_URL'),
      ]);
    }
    for (const good of ['u:pass', 'u:pa%23ss', 'u:pa%40ss%2F', 'u:pa-ss_1.~', 'u:a:b', 'u']) {
      expect(problemsOf({ ...aws, DATABASE_URL: db(good) }), good).toEqual([]);
    }
    expect(
      problemsOf({ ...aws, REDIS_URL: 'rediss://default:to#ken@cache.example.com:6379' }),
    ).toEqual([encoding('REDIS_URL')]);
    expect(
      problemsOf({ ...aws, REDIS_URL: 'rediss://default:to%23ken@cache.example.com:6379' }),
    ).toEqual([]);
    expect(problemsOf({ ...aws, REDIS_URL: 'rediss://:token@cache.example.com:6379' })).toEqual([]);
    // Without credentials there is nothing to encode.
    expect(problemsOf({ ...aws, REDIS_URL: 'rediss://cache.example.com:6379' })).toEqual([]);
  });
});

describe('an AWS runtime refuses developer-machine settings', () => {
  const ecs = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc' };
  const nodeEnv =
    'NODE_ENV must be production on AWS (an AWS runtime was detected): development / test switch the production rules off';
  const profile =
    'DEPLOY_PROFILE must be aws on AWS (an AWS runtime was detected): rehearsal exists for the local docker-compose rehearsal only';

  it('refuses NODE_ENV=development / test under each runtime marker', () => {
    for (const marker of [
      ecs,
      { ECS_CONTAINER_METADATA_URI: 'http://169.254.170.2/v3/abc' },
      { AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE' },
    ]) {
      for (const NODE_ENV of ['development', 'test']) {
        // `base` also carries DEPLOY_PROFILE=rehearsal; `aws` has the real profile.
        expect(problemsOf({ ...base, ...marker, NODE_ENV }), JSON.stringify(marker)).toEqual([
          nodeEnv,
          profile,
        ]);
        expect(problemsOf({ ...aws, ...marker, NODE_ENV }), JSON.stringify(marker)).toEqual([
          nodeEnv,
        ]);
      }
    }
  });

  it('refuses DEPLOY_PROFILE=rehearsal even with NODE_ENV=production', () => {
    expect(problemsOf({ ...base, ...ecs, NODE_ENV: 'production' })).toEqual([profile]);
  });

  it('accepts the real production configuration, with or without the marker', () => {
    expect(problemsOf({ ...aws, ...ecs })).toEqual([]);
    expect(problemsOf({ ...aws, ...ecs, NODE_ENV: undefined })).toEqual([]);
    expect(problemsOf({ ...aws, AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE' })).toEqual([]);
  });

  it('is silent without a marker (developer machines, the local rehearsal)', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([]);
    expect(problemsOf(dev)).toEqual([]);
  });
});

describe('API_DOCS_ENABLED (Swagger UI and the OpenAPI document)', () => {
  it('defaults to off in production and on elsewhere', () => {
    expect(loadConfig(aws).docsEnabled).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).docsEnabled).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: undefined }).docsEnabled).toBe(false);
    expect(loadConfig(dev).docsEnabled).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).docsEnabled).toBe(true);
    expect(loadConfig({ ...aws, API_DOCS_ENABLED: '' }).docsEnabled).toBe(false);
  });

  it('can be switched on in production and off elsewhere, and a typo is refused', () => {
    expect(loadConfig({ ...aws, API_DOCS_ENABLED: 'true' }).docsEnabled).toBe(true);
    expect(loadConfig({ ...aws, API_DOCS_ENABLED: ' YES ' }).docsEnabled).toBe(true);
    expect(loadConfig({ ...dev, API_DOCS_ENABLED: 'false' }).docsEnabled).toBe(false);
    expect(problemsOf({ ...aws, API_DOCS_ENABLED: 'maybe' })).toEqual([
      'API_DOCS_ENABLED must be true or false',
    ]);
  });
});
