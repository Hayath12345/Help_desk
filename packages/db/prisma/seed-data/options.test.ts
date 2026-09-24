import { DEFAULT_STAFF_EMAIL_DOMAIN } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import { seedOptions } from './options.ts';

describe('seedOptions', () => {
  it('demo data is opt-in: off unless SEED_DEMO_DATA is true', () => {
    expect(seedOptions({}).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: '' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'false' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'true' }).demo).toBe(true);
    expect(seedOptions({ SEED_DEMO_DATA: ' YES ', NODE_ENV: 'development' }).demo).toBe(true);
  });

  it('never seeds demo data in production', () => {
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: 'production' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: ' Production ' }).demo).toBe(false);
  });

  it('rejects a SEED_DEMO_DATA typo instead of guessing', () => {
    expect(() => seedOptions({ SEED_DEMO_DATA: 'maybe' })).toThrow(
      'SEED_DEMO_DATA must be true or false',
    );
  });

  it('a blank STAFF_EMAIL_DOMAIN means the default, like in the web app and the API', () => {
    expect(seedOptions({}).staffEmailDomain).toBe(DEFAULT_STAFF_EMAIL_DOMAIN);
    expect(seedOptions({ STAFF_EMAIL_DOMAIN: '  ' }).staffEmailDomain).toBe(
      DEFAULT_STAFF_EMAIL_DOMAIN,
    );
    expect(seedOptions({ STAFF_EMAIL_DOMAIN: ' Staff.Example.com ' }).staffEmailDomain).toBe(
      'staff.example.com',
    );
    expect(() => seedOptions({ STAFF_EMAIL_DOMAIN: 'not a domain' })).toThrow('STAFF_EMAIL_DOMAIN');
  });
});
