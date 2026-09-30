// Version chasing for the New-ticket configuration (docs/PHASE4_CONTRACT.md E18). An admin change
// bumps the config generation and broadcasts `config:updated {scope, version}`. A refetch right
// after it can still be answered from an older cache fill (a reader that loaded before the commit),
// so the form-config query keeps refetching, with a short backoff, until the `version` it gets is
// at least the one announced. The wanted version is kept per QueryClient, so a query that is not
// on screen when the event arrives chases it when it next loads.

import type { TicketFormConfig } from '@loons/shared';
import type { QueryClient } from '@tanstack/react-query';
import { fetchTicketFormConfig } from './api';

const wanted = new WeakMap<QueryClient, number>();
/** The latest announced version (lower than `wanted` after a generation reset). */
const announced = new WeakMap<QueryClient, number>();

/** Records that the form config must be at least `version` (the highest announced wins). */
export function requireFormConfigVersion(queryClient: QueryClient, version: number): void {
  announced.set(queryClient, version);
  if (version > (wanted.get(queryClient) ?? 0)) wanted.set(queryClient, version);
}

/** The highest config version announced to this client so far (0: none). */
export function requiredFormConfigVersion(queryClient: QueryClient): number {
  return wanted.get(queryClient) ?? 0;
}

/**
 * Whether `config` is recent enough. Version 0 means the API could not read the generation
 * (Redis unavailable): chasing it would never end, so it is accepted. After an announcement lower
 * than the wanted version (the API's generation counter restarted: Redis restarted or was
 * flushed), an answer at least as new as that announcement is accepted too, but only on a
 * refetch (`afterRetry`): two events of one generation can also arrive out of order (6, then 5),
 * and the first answer may be a stale cache fill at 5 while 6 is on its way.
 */
export function isFormConfigCurrent(
  queryClient: QueryClient,
  config: TicketFormConfig,
  afterRetry = false,
): boolean {
  if (config.version === 0) return true;
  const required = requiredFormConfigVersion(queryClient);
  if (config.version >= required) return true;
  const latest = announced.get(queryClient) ?? required;
  return afterRetry && latest < required && config.version >= latest;
}

/** Waits between refetches while the answer is older than announced (about 7.5 s in total). */
export const CONFIG_VERSION_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The form config's `queryFn`: fetches it, and refetches while its `version` is older than the
 * newest `config:updated` this client received. After the last retry the newest answer is used
 * anyway (the next event or reconnect refetches again), and it becomes the wanted version: the
 * API's generation counter restarted (Redis restarted or was flushed), so waiting for the old
 * number again would make every later load pay the whole backoff.
 */
export async function loadTicketFormConfig(
  queryClient: QueryClient,
  signal?: AbortSignal,
  delays: readonly number[] = CONFIG_VERSION_RETRY_DELAYS_MS,
): Promise<TicketFormConfig> {
  let config = await fetchTicketFormConfig(signal);
  let afterRetry = false;
  for (const delay of delays) {
    if (isFormConfigCurrent(queryClient, config, afterRetry)) return settle(queryClient, config);
    await sleep(delay, signal);
    config = await fetchTicketFormConfig(signal);
    afterRetry = true;
  }
  return settle(queryClient, config);
}

/** The accepted answer becomes the wanted version when it is lower (a generation reset). */
function settle(queryClient: QueryClient, config: TicketFormConfig): TicketFormConfig {
  if (config.version !== 0 && config.version < requiredFormConfigVersion(queryClient)) {
    wanted.set(queryClient, config.version);
  }
  return config;
}
