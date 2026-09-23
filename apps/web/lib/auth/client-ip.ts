// End-user IP forwarded to the API (header `x-client-ip`) for per-IP rate limiting.
//
// X-Forwarded-For is a list the CLIENT can pre-fill; each proxy appends the address it saw.
// Next.js only fills it in (from the socket) when it is absent, and a load balancer such as
// AWS ALB appends the real client address. So the trustworthy entry is the one added by our
// outermost trusted proxy: `trustedHops` from the right (1 = the last entry).

const IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/;

/** Normalises one address: strips an IPv4 port / IPv6 brackets and rejects anything odd. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value || value.toLowerCase() === 'unknown') return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value))
    value = value.slice(0, value.lastIndexOf(':'));
  return IP_CHARS.test(value) ? value : null;
}

/**
 * The client address as seen by the outermost trusted proxy (`trustedHops` entries from the
 * right of X-Forwarded-For), else `x-real-ip`.
 */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'>, trustedHops = 1): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    const index = Math.max(0, hops.length - Math.max(1, Math.floor(trustedHops)));
    const ip = normalizeIp(hops[index]);
    if (ip) return ip;
  }
  return normalizeIp(headers.get('x-real-ip'));
}
