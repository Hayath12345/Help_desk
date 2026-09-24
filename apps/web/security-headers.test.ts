import { describe, expect, it } from 'vitest';
import nextConfig from './next.config';
import { contentSecurityPolicy, securityHeaders } from './security-headers';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}

function headerMap(entries: { key: string; value: string }[]): Map<string, string> {
  return new Map(entries.map(({ key, value }) => [key.toLowerCase(), value]));
}

describe('securityHeaders (SEC-10 / SPEC-1)', () => {
  const production = headerMap(
    securityHeaders({ nodeEnv: 'production', apiUrl: 'https://api.loons.example' }),
  );

  it('sends the Helmet-equivalent headers', () => {
    expect(production.get('x-frame-options')).toBe('DENY');
    expect(production.get('x-content-type-options')).toBe('nosniff');
    expect(production.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(production.get('permissions-policy')).toMatch(
      /camera=\(\).*microphone=\(\).*geolocation=\(\)/,
    );
    expect(production.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('sends HSTS in production only', () => {
    expect(production.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(headerMap(securityHeaders({ nodeEnv })).has('strict-transport-security')).toBe(false);
    }
  });

  it('has a CSP that forbids framing, plugins, <base> changes and foreign form targets', () => {
    const csp = directives(production.get('content-security-policy') ?? '');
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('default-src')).toEqual(["'self'"]);
    // Only the OAuth providers the sign-in buttons redirect to.
    expect(csp.get('form-action')).toEqual([
      "'self'",
      'https://accounts.google.com',
      'https://login.microsoftonline.com',
    ]);
  });

  it('lets the browser reach the API (REST + Socket.IO) and nothing else', () => {
    const csp = directives(production.get('content-security-policy') ?? '');
    expect(csp.get('connect-src')).toEqual([
      "'self'",
      'https://api.loons.example',
      'wss://api.loons.example',
    ]);
    const local = directives(
      contentSecurityPolicy({ nodeEnv: 'production', apiUrl: 'http://localhost:4000/' }),
    );
    expect(local.get('connect-src')).toEqual([
      "'self'",
      'http://localhost:4000',
      'ws://localhost:4000',
    ]);
    const none = directives(contentSecurityPolicy({ nodeEnv: 'production', apiUrl: 'not a url' }));
    expect(none.get('connect-src')).toEqual(["'self'"]);
  });

  it('allows eval and the HMR socket in development only', () => {
    const prod = directives(contentSecurityPolicy({ nodeEnv: 'production' }));
    expect(prod.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    const dev = directives(contentSecurityPolicy({ nodeEnv: 'development' }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(expect.arrayContaining(['ws:', 'wss:']));
  });
});

describe('next.config headers()', () => {
  it('applies the security headers to every route', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('/:path*');
    const keys = rules[0]?.headers.map((header) => header.key.toLowerCase());
    expect(keys).toEqual(
      expect.arrayContaining([
        'content-security-policy',
        'x-frame-options',
        'x-content-type-options',
        'referrer-policy',
        'permissions-policy',
      ]),
    );
  });
});
