import { describe, expect, it } from 'vitest';
import {
  awsRuntimeProblems,
  isLocalHostname,
  isPlaceholderSecret,
  MAX_TRUSTED_PROXY_HOPS,
  parseApiTokenTtl,
  parseBooleanEnv,
  parseStaffEmailDomain,
  runsOnAwsRuntime,
} from './env.ts';

describe('parseBooleanEnv', () => {
  it('accepts the usual spellings and falls back when blank', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'On'])
      expect(parseBooleanEnv('X', v, false)).toBe(true);
    for (const v of ['false', '0', 'no', 'OFF']) expect(parseBooleanEnv('X', v, true)).toBe(false);
    expect(parseBooleanEnv('X', undefined, true)).toBe(true);
    expect(parseBooleanEnv('X', '  ', false)).toBe(false);
  });

  it('rejects typos instead of guessing', () => {
    expect(() => parseBooleanEnv('AUTH_DEV_STAFF_LOGIN', 'ture', false)).toThrow(
      /AUTH_DEV_STAFF_LOGIN/,
    );
  });
});

describe('parseApiTokenTtl', () => {
  it('defaults to 900 and enforces 60–3600', () => {
    expect(parseApiTokenTtl(undefined)).toBe(900);
    expect(parseApiTokenTtl('')).toBe(900);
    expect(parseApiTokenTtl('600')).toBe(600);
    expect(() => parseApiTokenTtl('45')).toThrow();
    expect(() => parseApiTokenTtl('86400')).toThrow();
    expect(() => parseApiTokenTtl('9.5')).toThrow();
  });
});

describe('parseStaffEmailDomain', () => {
  it('treats blank as the default and validates the rest', () => {
    expect(parseStaffEmailDomain('')).toBe('loonsgroup.com');
    expect(parseStaffEmailDomain(' LoonsGroup.com ')).toBe('loonsgroup.com');
    expect(() => parseStaffEmailDomain('not a domain')).toThrow();
  });
});

describe('isPlaceholderSecret', () => {
  it('flags the .env.example placeholders and empty values', () => {
    expect(isPlaceholderSecret('replace-me-with-32+-random-bytes')).toBe(true);
    expect(isPlaceholderSecret('')).toBe(true);
    expect(isPlaceholderSecret('q3J9vX1-8k2mZr6Tn0wYp4sL7cQe5hBa')).toBe(false);
  });
});

describe('runsOnAwsRuntime', () => {
  it('is true for each ECS / AWS runtime marker and false without one', () => {
    expect(runsOnAwsRuntime({})).toBe(false);
    expect(runsOnAwsRuntime({ AWS_EXECUTION_ENV: '' })).toBe(false);
    expect(runsOnAwsRuntime({ AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE' })).toBe(true);
    expect(runsOnAwsRuntime({ ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' })).toBe(
      true,
    );
    expect(runsOnAwsRuntime({ ECS_CONTAINER_METADATA_URI: 'http://169.254.170.2/v3/x' })).toBe(
      true,
    );
  });
});

describe('isLocalHostname', () => {
  it('recognises this machine in every spelling a URL can have', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      '0.0.0.0',
      '[::1]',
      '[::]',
      '[::ffff:7f00:1]',
      '[::ffff:0:0]',
    ]) {
      expect(isLocalHostname(host), host).toBe(true);
    }
  });

  it('does not flag public hosts and addresses', () => {
    for (const host of [
      'help.example.com',
      'localhost.example.com',
      'notlocalhost',
      '128.0.0.1',
      '10.0.0.5',
      '8.8.8.8',
      '[2001:db8::1]',
      '[::ffff:808:808]',
    ]) {
      expect(isLocalHostname(host), host).toBe(false);
    }
  });
});

describe('MAX_TRUSTED_PROXY_HOPS', () => {
  it('covers one load balancer behind a CDN, and no more', () => {
    expect(MAX_TRUSTED_PROXY_HOPS).toBe(3);
  });
});

describe('awsRuntimeProblems', () => {
  const ecs = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' };

  it('is silent without an AWS runtime marker, whatever the settings', () => {
    expect(awsRuntimeProblems({ NODE_ENV: 'development', DEPLOY_PROFILE: 'rehearsal' })).toEqual(
      [],
    );
  });

  it('refuses a NODE_ENV other than production and the rehearsal profile on an AWS runtime', () => {
    expect(awsRuntimeProblems({ ...ecs, NODE_ENV: 'development' })).toEqual([
      expect.stringMatching(/^NODE_ENV must be production on AWS/),
    ]);
    expect(awsRuntimeProblems({ ...ecs, NODE_ENV: 'test', DEPLOY_PROFILE: ' Rehearsal ' })).toEqual(
      [
        expect.stringMatching(/^NODE_ENV must be production on AWS/),
        expect.stringMatching(/^DEPLOY_PROFILE must be aws on AWS/),
      ],
    );
    expect(
      awsRuntimeProblems({ AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE', DEPLOY_PROFILE: 'rehearsal' }),
    ).toHaveLength(1);
  });

  it('accepts production (also unset, which means production) with the aws profile', () => {
    expect(awsRuntimeProblems({ ...ecs, NODE_ENV: 'production', DEPLOY_PROFILE: 'aws' })).toEqual(
      [],
    );
    expect(awsRuntimeProblems({ ...ecs })).toEqual([]);
    expect(awsRuntimeProblems({ ...ecs, NODE_ENV: '', DEPLOY_PROFILE: '' })).toEqual([]);
  });
});
