import { describe, expect, it } from 'vitest';
import { API_TOKEN_TTL, DEFAULT_UPLOAD_DAILY_BYTES_PER_USER } from '@loons/shared';
import {
  ConfigError,
  DEFAULT_SMS_MAX_PER_RECIPIENT_PER_HOUR,
  DEFAULT_TEAMS_TIMEOUT_MS,
  DEFAULT_TEAMS_WEBHOOK_HOSTS,
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
      expect(problemsOf({ ...base, TRUST_PROXY: '11' })).toEqual([
        'TRUST_PROXY hop count must be between 1 and 10',
      ]);
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
