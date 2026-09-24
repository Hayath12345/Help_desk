import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders, normalizeIp } from './client-ip';

describe('clientIpFromHeaders', () => {
  it('uses the address appended by the trusted proxy (rightmost by default)', () => {
    // A client can pre-fill X-Forwarded-For; the load balancer appends what it really saw.
    const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.7');
  });

  it('counts trusted hops from the right', () => {
    const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' });
    expect(clientIpFromHeaders(headers, 2)).toBe('203.0.113.7');
    expect(clientIpFromHeaders(headers, 3)).toBe('6.6.6.6');
    expect(clientIpFromHeaders(headers, 10)).toBe('6.6.6.6');
  });

  it('handles the single value Next.js fills in from the socket', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '::1' }))).toBe('::1');
  });

  it('falls back to x-real-ip', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'garbage', 'x-real-ip': '::1' })),
    ).toBe('::1');
  });

  it('knows no IP when nothing appends to X-Forwarded-For (TRUSTED_PROXY_HOPS=0)', () => {
    // Without a proxy the client writes every forwarding header itself.
    const headers = new Headers({ 'x-forwarded-for': '192.0.2.77', 'x-real-ip': '192.0.2.78' });
    expect(clientIpFromHeaders(headers, 0)).toBeNull();
    expect(clientIpFromHeaders(headers, Number.NaN)).toBeNull();
  });

  it('returns null without usable headers', () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'unknown' }))).toBeNull();
  });
});

describe('normalizeIp', () => {
  it('strips ports and IPv6 brackets', () => {
    expect(normalizeIp('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('rejects header-injection attempts and junk', () => {
    expect(normalizeIp('1.2.3.4\r\nx-evil: 1')).toBeNull();
    expect(normalizeIp('<script>')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});
