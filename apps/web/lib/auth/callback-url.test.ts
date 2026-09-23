import { describe, expect, it } from 'vitest';
import { firstParam, safeCallbackUrl } from './callback-url';

describe('safeCallbackUrl', () => {
  it('accepts same-origin relative paths, keeping query and hash', () => {
    expect(safeCallbackUrl('/tickets')).toBe('/tickets');
    expect(safeCallbackUrl('/tickets/42?tab=active#reply')).toBe('/tickets/42?tab=active#reply');
    expect(safeCallbackUrl('  /console/inbox  ')).toBe('/console/inbox');
    expect(safeCallbackUrl('/')).toBe('/');
  });

  it('normalises dot segments without leaving the origin', () => {
    expect(safeCallbackUrl('/tickets/../admin')).toBe('/admin');
    expect(safeCallbackUrl('/../../etc')).toBe('/etc');
  });

  it.each([
    ['absolute http URL', 'https://evil.com'],
    ['absolute URL with path', 'http://evil.com/tickets'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/login'],
    ['backslash trick', '/\\evil.com'],
    ['double backslash', '\\\\evil.com'],
    ['mixed slashes', '/\\/evil.com'],
    ['javascript URL', 'javascript:alert(1)'],
    ['data URL', 'data:text/html,hi'],
    ['relative without slash', 'tickets'],
    ['tab injection', '/\t/evil.com'],
    ['newline injection', '/\n/evil.com'],
    ['null byte', '/tickets\u0000'],
    ['triple slash', '///evil.com'],
    ['API route', '/api/auth/signout'],
    ['Next internals', '/_next/static/x.js'],
  ])('rejects %s', (_label, value) => {
    expect(safeCallbackUrl(value)).toBeNull();
  });

  it('rejects non-strings, empty and oversized values', () => {
    expect(safeCallbackUrl(undefined)).toBeNull();
    expect(safeCallbackUrl(null)).toBeNull();
    expect(safeCallbackUrl(42)).toBeNull();
    expect(safeCallbackUrl(['/tickets'])).toBeNull();
    expect(safeCallbackUrl('')).toBeNull();
    expect(safeCallbackUrl(`/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('keeps percent-encoded slashes encoded (no decoding into //host)', () => {
    expect(safeCallbackUrl('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com');
  });
});

describe('firstParam', () => {
  it('returns the first value of repeated params', () => {
    expect(firstParam(['/a', '/b'])).toBe('/a');
    expect(firstParam('/a')).toBe('/a');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam(null)).toBeUndefined();
  });
});
