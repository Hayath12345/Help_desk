// Typed fetchers for the admin API (docs/PHASE4_CONTRACT.md E20: `/admin/<section>/…`, bearer
// auth through `apiClient`, zod contracts in `@loons/shared` schemas/admin/*). Responses are
// parsed with the section's contract schema outside production (same rule as lib/tickets/api.ts),
// so a drift between the API and the web app fails loudly in development and tests.

import type { z } from 'zod';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';
import type { AdminListParams } from './keys';
import type { AdminSlug } from './sections';

/** `/admin/<section>/<segment>/…`, every segment URL-encoded. */
export function adminPath(section: AdminSlug, ...segments: (string | number)[]): string {
  const rest = segments.map((segment) => `/${encodeURIComponent(String(segment))}`).join('');
  return `/admin/${section}${rest}`;
}

/** GET `path?params`, parsed with `schema`. */
export async function adminGet<S extends z.ZodType>(
  path: string,
  schema: S,
  options: { params?: AdminListParams; signal?: AbortSignal } = {},
): Promise<z.output<S>> {
  const data = await apiClient.get<unknown>(withQuery(path, options.params ?? {}), {
    signal: options.signal,
  });
  return parseResponse(schema, data);
}

export type AdminWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A write (`POST`/`PUT`/`PATCH`/`DELETE`) with a JSON body, parsed with `schema` when given (a
 * 204 or an unparsed answer resolves to `undefined`). Edits carry the `expectedUpdatedAt` they
 * started from (E19) — see `withExpectedUpdatedAt`.
 */
export async function adminWrite<S extends z.ZodType>(
  method: AdminWriteMethod,
  path: string,
  body: unknown,
  schema: S,
): Promise<z.output<S>>;
export async function adminWrite(
  method: AdminWriteMethod,
  path: string,
  body?: unknown,
): Promise<undefined>;
export async function adminWrite(
  method: AdminWriteMethod,
  path: string,
  body?: unknown,
  schema?: z.ZodType,
): Promise<unknown> {
  const data = await apiClient.request<unknown>(path, {
    method,
    ...(body === undefined ? {} : { json: body }),
  });
  return schema ? parseResponse(schema, data) : undefined;
}

/**
 * A `queryFn` for `useAdminList`: GET `/admin/<section>` (or `path`) with `params`, parsed with
 * `schema`.
 */
export function adminListFetcher<S extends z.ZodType>(
  section: AdminSlug,
  schema: S,
  options: { path?: string; params?: AdminListParams } = {},
): (signal?: AbortSignal) => Promise<z.output<S>> {
  const path = options.path ?? adminPath(section);
  return (signal) => adminGet(path, schema, { params: options.params, signal });
}

/**
 * The lost-update guard (E19): every edit sends the `updatedAt` of the row it started from; the
 * API answers 409 when the row changed since (`isStaleConflict`).
 */
export function withExpectedUpdatedAt<T extends object>(
  input: T,
  row: { updatedAt: string | Date },
): T & { expectedUpdatedAt: string } {
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt;
  return { ...input, expectedUpdatedAt: updatedAt };
}
