// callbackUrl sanitising: only same-origin relative paths survive (no open redirects).

const PLACEHOLDER_ORIGIN = 'http://loons.invalid';
const MAX_LENGTH = 2048;

/** Paths a sign-in must never bounce back to (loops or Auth.js endpoints). */
const DISALLOWED_PREFIXES = ['/api/', '/_next/'];

/**
 * Returns `raw` normalised to `/path?query#hash` when it is a safe same-origin relative path,
 * otherwise `null`. Rejects absolute URLs, protocol-relative `//host`, backslash tricks
 * (`/\host`), control characters, and anything that resolves to a different origin.
 */
export function safeCallbackUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // Browsers treat "\" like "/" in URLs, so "/\evil.com" would be protocol-relative.
  if (value.includes('\\')) return null;
  // Control characters (tabs/newlines are stripped by URL parsers, enabling "/\t/evil.com").
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  // A path whose encoded form decodes to "//host" is still dangerous once re-emitted.
  if (url.pathname.startsWith('//')) return null;
  if (
    DISALLOWED_PREFIXES.some((p) => url.pathname === p.slice(0, -1) || url.pathname.startsWith(p))
  ) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The first value of a search param (Next gives `string | string[] | undefined`). */
export function firstParam(value: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}
