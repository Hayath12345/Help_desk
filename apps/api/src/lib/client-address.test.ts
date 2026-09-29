import { describe, expect, it } from 'vitest';
import { addressKey } from './client-address.ts';

describe('addressKey (per-address limit keys)', () => {
  it('keeps IPv4 addresses', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey(' 203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('maps IPv4-mapped IPv6 addresses to IPv4 (both notations)', () => {
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
  });

  it('keys other IPv6 addresses by their /64', () => {
    const key = addressKey('2001:db8:1:2:3:4:5:6');
    expect(key).toBe('2001:db8:1:2::');
    // Every address in the /64 shares the key; the next /64 does not.
    expect(addressKey('2001:db8:1:2::1')).toBe(key);
    expect(addressKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(addressKey('2001:db8:1:3::1')).not.toBe(key);
    expect(addressKey('fe80::1%eth0')).toBe('fe80::');
  });

  it('leaves anything else alone (lower-cased)', () => {
    expect(addressKey('unknown')).toBe('unknown');
    expect(addressKey('Garbage')).toBe('garbage');
  });
});
