'use client';

// TanStack Query helpers for the admin sections: one list query per section (keys under
// ['admin', <section>, 'list', params]) and mutations with optional optimistic updates, toasts, the
// lost-update 409 state (E19) and immediate refresh of the caches the change touches in this tab
// (other tabs and users refresh through `config:updated`, E18).

import type { ConfigScope } from '@loons/shared';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { isApiRequestError } from '@/lib/api/errors';
import { queryKeysForConfigScope } from '@/lib/realtime/config-scopes';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { adminConflictDetails, isStaleConflict } from './errors';
import { adminKeys, type AdminListParams } from './keys';
import type { AdminSlug } from './sections';

/** Don't retry answers that won't change (403 / 404 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export interface AdminListOptions<TData, TSelected = TData> {
  section: AdminSlug;
  /** Part of the query key (filters, `includeArchived`…); pass the same values to `queryFn`. */
  params?: AdminListParams;
  /** e.g. `adminListFetcher('categories', categoryListSchema, { params })`. */
  queryFn: (signal: AbortSignal) => Promise<TData>;
  select?: (data: TData) => TSelected;
  enabled?: boolean;
  /** Default 30 s; realtime `config:updated` refreshes it anyway. */
  staleTime?: number;
}

/**
 * A section's list. Keyed `adminKeys.list(section, params)`, so `config:updated` for the scope
 * (and every mutation of the section) refreshes it. Keeps the previous data while `params`
 * change (e.g. toggling "Show archived"), so the table doesn't flash.
 */
export function useAdminList<TData, TSelected = TData>(
  options: AdminListOptions<TData, TSelected>,
) {
  return useQuery({
    queryKey: adminKeys.list(options.section, options.params),
    queryFn: ({ signal }) => options.queryFn(signal),
    select: options.select,
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? 30_000,
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
}

export interface AdminMutationOptions<TVariables, TResult, TCache = unknown> {
  section: AdminSlug;
  mutationFn: (variables: TVariables) => Promise<TResult>;
  /**
   * Optimistic change of the cached data under `optimisticKey` (default: every list of the
   * section), rolled back if the request fails. Use it where the outcome is certain (reorder,
   * archive / restore toggles), not for creates that need server ids.
   */
  optimistic?: (cached: TCache, variables: TVariables) => TCache;
  optimisticKey?: QueryKey;
  /** Config scopes the change touches: their caches refresh in this tab right away. */
  scopes?: readonly ConfigScope[];
  /** Success toast (already translated), or `false` for none. */
  success?: string | ((result: TResult, variables: TVariables) => string) | false;
  /**
   * Error toast. Default: yes, except for the stale 409 (the sheet shows "Someone else changed
   * this — reload") and 400 VALIDATION_FAILED (the form shows the field errors). A reorder refused
   * with 409 `order_changed` says so ("the list was reloaded") instead of the API's text.
   */
  errorToast?: boolean | ((error: unknown) => boolean);
  onSuccess?: (result: TResult, variables: TVariables) => void;
  onError?: (error: unknown, variables: TVariables) => void;
}

const isOrderChanged = (error: unknown) => adminConflictDetails(error)?.reason === 'order_changed';

function defaultErrorToast(error: unknown): boolean {
  // A refused reorder snaps back to the server's order: say why (E3).
  if (isOrderChanged(error)) return true;
  if (isStaleConflict(error)) return false;
  return !(isApiRequestError(error) && error.code === 'VALIDATION_FAILED');
}

interface Snapshot {
  snapshots: [QueryKey, unknown][];
}

/**
 * A section's write. Returns the TanStack mutation plus `isConflict` (the last attempt was
 * refused because the row changed meanwhile: show the sheet's reload state, then `reset()`).
 */
export function useAdminMutation<TVariables, TResult = unknown, TCache = unknown>(
  options: AdminMutationOptions<TVariables, TResult, TCache>,
) {
  const queryClient = useQueryClient();
  const errorText = useApiErrorText();
  const tReorder = useTranslations('admin.kit.reorder');
  const optimisticKey = options.optimisticKey ?? adminKeys.lists(options.section);

  const mutation = useMutation<TResult, unknown, TVariables, Snapshot>({
    mutationKey: ['admin', options.section, 'write'],
    mutationFn: options.mutationFn,
    onMutate: async (variables) => {
      const { optimistic } = options;
      if (!optimistic) return { snapshots: [] };
      await queryClient.cancelQueries({ queryKey: optimisticKey });
      const snapshots = queryClient.getQueriesData<TCache>({ queryKey: optimisticKey });
      queryClient.setQueriesData<TCache>({ queryKey: optimisticKey }, (cached) =>
        cached === undefined ? cached : optimistic(cached, variables),
      );
      return { snapshots };
    },
    onError: (error, variables, context) => {
      for (const [key, data] of context?.snapshots ?? []) queryClient.setQueryData(key, data);
      const wantToast =
        typeof options.errorToast === 'function'
          ? options.errorToast(error)
          : (options.errorToast ?? defaultErrorToast(error));
      if (wantToast) {
        toast.error(isOrderChanged(error) ? tReorder('orderChanged') : errorText(error));
      }
      options.onError?.(error, variables);
    },
    onSuccess: (result, variables) => {
      const message =
        typeof options.success === 'function'
          ? options.success(result, variables)
          : options.success;
      if (message) toast.success(message);
      options.onSuccess?.(result, variables);
    },
    onSettled: () => {
      const keys = new Map<string, QueryKey>([
        [JSON.stringify(adminKeys.section(options.section)), adminKeys.section(options.section)],
      ]);
      for (const scope of options.scopes ?? []) {
        for (const key of queryKeysForConfigScope(scope)) keys.set(JSON.stringify(key), key);
      }
      for (const key of keys.values()) void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return Object.assign(mutation, { isConflict: isStaleConflict(mutation.error) });
}

/** Puts `items` in the order of `ids` (unknown ids ignored, missing items kept at the end). */
export function reorderById<T>(
  items: readonly T[],
  ids: readonly string[],
  getId: (item: T) => string,
): T[] {
  const byId = new Map(items.map((item) => [getId(item), item]));
  const ordered: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item !== undefined) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}
