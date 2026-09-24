import { describe, expect, it } from 'vitest';
import {
  isPlaceholderSecret,
  parseApiTokenTtl,
  parseBooleanEnv,
  parseStaffEmailDomain,
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
