import { isIP } from 'node:net';
import { normalizeIP } from '@fastify/rate-limit';

/**
 * The key per-address limits use for a client address: an IPv4 address as is, an IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`, in either notation) as its IPv4 address, and any other IPv6 address
 * as its /64 network (`2001:db8:1:2::`) — one host or customer usually gets a whole /64, so keying
 * by the full address would give every address in it a budget of its own (sweep: per-address
 * socket limits). The same key as the HTTP rate limits (`@fastify/rate-limit`'s `normalizeIP`,
 * /64 by default), so both budget a client alike. A zone id (`fe80::1%eth0`) is ignored; anything
 * that isn't an IP address (e.g. `unknown`) is returned lower-cased.
 */
export function addressKey(address: string): string {
  const trimmed = address.trim();
  return isIP(trimmed) ? normalizeIP(trimmed) : trimmed.toLowerCase();
}
