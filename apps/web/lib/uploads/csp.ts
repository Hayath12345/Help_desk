// Browsers upload attachments straight to storage (pre-signed POST), so the web CSP must allow
// that origin in `connect-src`. Used by next.config.ts on top of security-headers.ts.

export interface HeaderEntryLike {
  key: string;
  value: string;
}

/** NEXT_PUBLIC_UPLOAD_ORIGIN → its http(s) origin, or null when unset / not a URL. */
export function uploadOrigin(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Adds `origin` to the connect-src directive of a CSP string (no-op if already present). */
export function addConnectSrc(csp: string, origin: string): string {
  const directives = csp.split(';').map((d) => d.trim());
  const index = directives.findIndex((d) => d === 'connect-src' || d.startsWith('connect-src '));
  if (index === -1) return [...directives, `connect-src 'self' ${origin}`].join('; ');
  const sources = directives[index]!.split(/\s+/).slice(1);
  if (!sources.includes(origin)) directives[index] = ['connect-src', ...sources, origin].join(' ');
  return directives.join('; ');
}

/** Returns the headers with the upload origin allowed in the CSP's connect-src. */
export function withUploadConnectSrc<T extends HeaderEntryLike>(
  headers: readonly T[],
  uploadOriginValue: string | undefined,
): T[] {
  const origin = uploadOrigin(uploadOriginValue);
  if (!origin) return [...headers];
  return headers.map((header) =>
    header.key.toLowerCase() === 'content-security-policy'
      ? { ...header, value: addConnectSrc(header.value, origin) }
      : header,
  );
}
