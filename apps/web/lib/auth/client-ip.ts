// End-user IP forwarded to the API (header `x-client-ip`) for per-IP rate limiting.
//
// X-Forwarded-For is a list the CLIENT can pre-fill; each proxy appends the address it saw.
// A load balancer such as AWS ALB appends the real client address, so the trustworthy entry is
// the one added by our outermost trusted proxy: `trustedHops` from the right (1 = the last entry).
// Next.js itself only fills the header in (from the socket) when the request has none, so with
// NO appending proxy in front (`trustedHops` 0) every forwarding header is client-controlled.

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
 * right of X-Forwarded-For), else `x-real-ip`. With `trustedHops` 0 (nothing in front of
 * Next.js) the address is unknown: null.
 */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'>, trustedHops = 1): string | null {
  const hopsToSkip = Math.floor(trustedHops);
  if (!(hopsToSkip >= 1)) return null;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    const index = Math.max(0, hops.length - hopsToSkip);
    const ip = normalizeIp(hops[index]);
    if (ip) return ip;
  }
  return normalizeIp(headers.get('x-real-ip'));
}
