// Reloads the signed-in user from the API for the periodic session refresh (jwt callback).
import 'server-only';
import { ApiRequestError } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { parseUserResponse, type UserLookup } from './session-user';

/**
 * The refresh runs inside the proxy and page renders, so it must not hold a request for long:
 * after this many milliseconds the API counts as unavailable and the session is kept as it is.
 */
export const USER_LOOKUP_TIMEOUT_MS = 3_000;

export async function lookupUser(userId: string): Promise<UserLookup> {
  try {
    const body = await internalApiFetch<unknown>(
      `/internal/auth/users/${encodeURIComponent(userId)}`,
      { clientIp: null, signal: AbortSignal.timeout(USER_LOOKUP_TIMEOUT_MS) },
    );
    const user = parseUserResponse(body);
    return user ? { kind: 'found', user } : { kind: 'unavailable' };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { kind: 'gone' };
    return { kind: 'unavailable' };
  }
}
