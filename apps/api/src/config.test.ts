import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

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
    const c = loadConfig(base);
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
  });

  it('parses booleans from strings', () => {
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: 'TRUE' }).socketRedisAdapter).toBe(true);
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: '0' }).socketRedisAdapter).toBe(false);
    expect(loadConfig({ ...base, SOCKET_REDIS_ADAPTER: '' }).socketRedisAdapter).toBe(false);
    expect(problemsOf({ ...base, SOCKET_REDIS_ADAPTER: 'maybe' })).toEqual([
      'SOCKET_REDIS_ADAPTER must be true or false',
    ]);
  });

  it('dev staff login needs the flag AND a non-production environment', () => {
    expect(loadConfig({ ...base, AUTH_DEV_STAFF_LOGIN: 'true' }).devStaffLogin).toBe(true);
    expect(loadConfig({ ...base, AUTH_DEV_STAFF_LOGIN: 'false' }).devStaffLogin).toBe(false);
    expect(loadConfig({ ...base, AUTH_DEV_STAFF_LOGIN: 'true', NODE_ENV: 'production' }).devStaffLogin).toBe(false);
  });

  it('TRUST_PROXY accepts booleans or IP / CIDR lists', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(problemsOf({ ...base, TRUST_PROXY: '2' })).toHaveLength(1);
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

  it('refuses placeholder secrets in production and identical secrets anywhere', () => {
    expect(
      problemsOf({ ...base, NODE_ENV: 'production', API_JWT_SECRET: 'replace-me-with-32+-random-bytes-xxxxxx' }),
    ).toEqual(['API_JWT_SECRET still has the placeholder value']);
    expect(problemsOf({ ...base, INTERNAL_API_KEY: base.API_JWT_SECRET })).toEqual([
      'API_JWT_SECRET and INTERNAL_API_KEY must be different secrets',
    ]);
  });

  it('requires provider regions for AWS transports and paired S3 keys', () => {
    expect(problemsOf({ ...base, EMAIL_PROVIDER: 'ses' })).toEqual(['SES_REGION is required when EMAIL_PROVIDER=ses']);
    expect(problemsOf({ ...base, SMS_PROVIDER: 'sns' })).toEqual(['SNS_REGION is required when SMS_PROVIDER=sns']);
    expect(problemsOf({ ...base, S3_ACCESS_KEY_ID: 'only-one' })).toHaveLength(1);
  });
});
