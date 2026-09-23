// Server-side API client (Server Components, Server Actions, Route Handlers).
import 'server-only';
import { getCurrentUser } from '@/lib/session';
import { ApiRequestError } from './errors';
import { fetchAsUser, type ApiFetchInit } from './internal';

export { ApiRequestError, isApiRequestError, validationIssues } from './errors';
export { internalApiFetch } from './internal';
export type { ApiFetchInit, InternalApiFetchInit } from './internal';

/**
 * Authenticated call to the API as the signed-in user (or `init.user`).
 * Throws `ApiRequestError` (401 UNAUTHENTICATED when nobody is signed in).
 */
export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { user: explicitUser, ...rest } = init;
  const user = explicitUser ?? (await getCurrentUser());
  if (!user) throw new ApiRequestError(401, 'UNAUTHENTICATED', 'Not signed in');
  return fetchAsUser<T>(user, path, rest);
}
