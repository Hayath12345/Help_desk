import { DEFAULT_STAFF_EMAIL_DOMAIN } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import { seedOptions } from './options.ts';

describe('seedOptions', () => {
  it('demo data is opt-in: off unless SEED_DEMO_DATA is true', () => {
    const dev = { NODE_ENV: 'development' };
    expect(seedOptions(dev).demo).toBe(false);
    expect(seedOptions({ ...dev, SEED_DEMO_DATA: '' }).demo).toBe(false);
    expect(seedOptions({ ...dev, SEED_DEMO_DATA: 'false' }).demo).toBe(false);
    expect(seedOptions({ ...dev, SEED_DEMO_DATA: 'true' }).demo).toBe(true);
    expect(seedOptions({ SEED_DEMO_DATA: ' YES ', NODE_ENV: ' Development ' }).demo).toBe(true);
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: 'test' }).demo).toBe(true);
  });

  it('seeds demo data only when NODE_ENV is explicitly development or test (RR-SEC-3)', () => {
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: 'production' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: ' Production ' }).demo).toBe(false);
    // Unset, blank or unknown counts as production.
    expect(seedOptions({ SEED_DEMO_DATA: 'true' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: '' }).demo).toBe(false);
    expect(seedOptions({ SEED_DEMO_DATA: 'true', NODE_ENV: 'staging' }).demo).toBe(false);
  });

  it('rejects a SEED_DEMO_DATA typo instead of guessing', () => {
    expect(() => seedOptions({ SEED_DEMO_DATA: 'maybe', NODE_ENV: 'production' })).toThrow(
      'SEED_DEMO_DATA must be true or false',
    );
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
