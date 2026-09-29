// Pure cache operations shared by the mutations (optimistic updates) and the realtime client
// (server pushes). Everything here is synchronous and framework-free apart from the QueryClient,
// so it is unit-tested directly.

import type { MessageDto, TicketDetailDto, TicketSummaryDto } from '@loons/shared';
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { ticketKeys } from './keys';
import type { AnyTicketDto, ThreadMessage, TicketPages, TicketPagesWithItems } from './types';

// ───────────── Thread messages ─────────────

const time = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Server messages in `createdAt` order (stable for ties), then optimistic ones in the order they
 * were written — a message the server has not stored yet always shows last.
 */
export function sortThread(list: readonly ThreadMessage[]): ThreadMessage[] {
  const server = list.filter((m) => !m.local);
  const local = list.filter((m) => m.local);
  server.sort((a, b) => time(a.createdAt) - time(b.createdAt));
  return [...server, ...local];
}

function sameMessage(a: ThreadMessage, b: ThreadMessage): boolean {
  if (a.id === b.id) return true;
  return a.clientTempId !== null && b.clientTempId !== null && a.clientTempId === b.clientTempId;
}

/**
 * Inserts or replaces one message, deduplicated by id and by clientTempId (a server message
 * replaces the optimistic one it confirms; a realtime copy of a message already in the list
 * replaces it instead of appearing twice).
 */
export function upsertThreadMessage(
  list: readonly ThreadMessage[] | undefined,
  message: ThreadMessage,
): ThreadMessage[] {
  const current = list ?? [];
  const existing = current.find((m) => sameMessage(m, message));
  // Never downgrade a stored message back to an optimistic one (a late retry of a message the
  // server already confirmed).
  if (existing && !existing.local && message.local) return [...current];
  return sortThread([...current.filter((m) => !sameMessage(m, message)), message]);
}

/**
 * Merges two versions of a thread, whatever order they were read in: every message of both,
 * deduplicated by id / clientTempId (`incoming` wins a tie, but a stored message is never replaced
 * by an optimistic copy of itself).
 */
export function mergeThreadMessages(
  list: readonly ThreadMessage[] | undefined,
  incoming: readonly ThreadMessage[] | undefined,
): ThreadMessage[] {
  return (incoming ?? []).reduce<ThreadMessage[]>(
    (acc, m) => upsertThreadMessage(acc, m),
    sortThread(list ?? []),
  );
}

/** Adds messages the server returned (a fetch, a catch-up) to a cached thread. */
export function mergeServerMessages(
  list: readonly ThreadMessage[] | undefined,
  incoming: readonly MessageDto[],
): ThreadMessage[] {
  return mergeThreadMessages(list, incoming);
}

/** Id of the newest message the server has stored (reconnect catch-up: `?after=`). */
export function lastServerMessageId(list: readonly ThreadMessage[] | undefined): string | null {
  const server = sortThread(list ?? []).filter((m) => !m.local);
  return server[server.length - 1]?.id ?? null;
}

/** Optimistic messages only (kept when the thread is refetched). */
export function localMessages(list: readonly ThreadMessage[] | undefined): ThreadMessage[] {
  return (list ?? []).filter((m) => m.local);
}

export function setLocalMessageStatus(
  list: readonly ThreadMessage[] | undefined,
  clientTempId: string,
  status: 'pending' | 'failed',
): ThreadMessage[] {
  return (list ?? []).map((m) =>
    m.local && m.clientTempId === clientTempId ? { ...m, local: { ...m.local, status } } : m,
  );
}

// ───────────── Thread writes & loads ─────────────
//
// A thread's cache entry is written by its load (`loadThread`), by realtime pushes and by the
// user's own sends, in any order. Two rules keep every message whatever the interleaving:
// - A load merges what it fetched with what the cache holds when it finishes (never replaces it).
// - A write to a thread that has no data yet (its first load is in flight) is parked instead of
//   being written: writing it would mark the thread loaded with only that message. The load
//   merges the parked writes when it finishes.

/** Per QueryClient (one per tab; each test makes its own). */
const parkedThreadWrites = new WeakMap<QueryClient, Map<string, ThreadMessage[]>>();
const threadCatchUps = new WeakMap<QueryClient, Set<string>>();

export type ThreadWriteMode =
  /** Only threads someone has loaded or is loading (realtime pushes: a later load fetches the rest). */
  | 'if-tracked'
  /** Always (the user's own sends and their outcome): kept until the thread loads. */
  | 'always';

/**
 * Applies `update` to a ticket's thread: directly when it has loaded, otherwise parked until its
 * load finishes (see above), so a write can never stand in for the history.
 */
export function updateThread(
  queryClient: QueryClient,
  ticketId: string,
  update: (list: ThreadMessage[]) => ThreadMessage[],
  mode: ThreadWriteMode = 'always',
): void {
  const key = ticketKeys.messages(ticketId);
  const state = queryClient.getQueryState<ThreadMessage[]>(key);
  if (state?.data !== undefined) {
    queryClient.setQueryData<ThreadMessage[]>(key, (old) => update(old ?? []));
    return;
  }
  if (!state && mode === 'if-tracked') return;
  let parked = parkedThreadWrites.get(queryClient);
  if (!parked) parkedThreadWrites.set(queryClient, (parked = new Map()));
  parked.set(ticketId, update(parked.get(ticketId) ?? []));
}

/** Removes and returns the writes parked for a thread (merged by `loadThread`). */
export function takeParkedThreadWrites(
  queryClient: QueryClient,
  ticketId: string,
): ThreadMessage[] {
  const parked = parkedThreadWrites.get(queryClient);
  const list = parked?.get(ticketId) ?? [];
  parked?.delete(ticketId);
  return list;
}

/**
 * The ticket's realtime room was joined while the thread's first load was in flight: that load
 * may have read the thread before the join, so messages stored in between would never arrive as
 * pushes. `loadThread` fetches what came after its snapshot once more.
 */
export function requestThreadCatchUp(queryClient: QueryClient, ticketId: string): void {
  let set = threadCatchUps.get(queryClient);
  if (!set) threadCatchUps.set(queryClient, (set = new Set()));
  set.add(ticketId);
}

/** True (once) when a catch-up was requested for the thread. */
export function takeThreadCatchUp(queryClient: QueryClient, ticketId: string): boolean {
  return threadCatchUps.get(queryClient)?.delete(ticketId) ?? false;
}

// ───────────── Ticket summaries & details ─────────────

const DETAIL_ONLY_KEYS = [
  'description',
  'assetId',
  'customFields',
  'attachments',
  'requesterCard',
  'sla',
  'p1Chain',
] as const satisfies readonly (keyof TicketDetailDto)[];

/** The summary part of a detail DTO (what list rows hold). */
export function toSummary(ticket: AnyTicketDto): TicketSummaryDto {
  const copy: Record<string, unknown> = { ...ticket };
  for (const key of DETAIL_ONLY_KEYS) delete copy[key];
  return copy as unknown as TicketSummaryDto;
}

/** `incoming` is at least as recent as `current` (out-of-order pushes never roll data back). */
export function isSameOrNewer(incoming: AnyTicketDto, current: AnyTicketDto): boolean {
  return time(incoming.updatedAt) >= time(current.updatedAt);
}

/** Adds `items` (all loaded tickets, in page order) to the cached pages. */
export function selectTicketPages(data: TicketPages): TicketPagesWithItems {
  return { ...data, items: data.pages.flatMap((page) => page.items) };
}

function mapPages(
  data: TicketPages | undefined,
  fn: (ticket: TicketSummaryDto) => TicketSummaryDto,
): TicketPages | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      const next = fn(item);
      if (next !== item) pageChanged = true;
      return next;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

/**
 * Applies `update` to every cached copy of the ticket (all detail entries and every list page).
 * `update` returns the same object to leave a copy untouched.
 */
export function updateTicketEverywhere(
  queryClient: QueryClient,
  ticketId: string,
  update: <T extends AnyTicketDto>(ticket: T) => T,
): void {
  queryClient.setQueriesData<TicketDetailDto>({ queryKey: ticketKeys.details() }, (old) =>
    old && old.id === ticketId ? update(old) : old,
  );
  queryClient.setQueriesData<TicketPages>({ queryKey: ticketKeys.lists() }, (old) =>
    mapPages(old, (item) => (item.id === ticketId ? update(item) : item)),
  );
}

/**
 * Writes a server summary (realtime `ticket:updated`, message responses) into every cached copy
 * of that ticket, unless the cached copy is newer. Returns true when a cached detail was older —
 * its detail-only fields (description, custom fields, SLA policy…) may be stale then.
 */
export function applyTicketSummary(queryClient: QueryClient, summary: TicketSummaryDto): boolean {
  let detailWasOlder = false;
  updateTicketEverywhere(queryClient, summary.id, (ticket) => {
    if (!isSameOrNewer(summary, ticket)) return ticket;
    if ('requesterCard' in ticket && summary.updatedAt !== ticket.updatedAt) detailWasOlder = true;
    return { ...ticket, ...summary };
  });
  return detailWasOlder;
}

/** Writes a full server detail (PATCH / create responses) into every cached copy. */
export function applyTicketDetail(queryClient: QueryClient, detail: TicketDetailDto): void {
  const summary = toSummary(detail);
  queryClient.setQueriesData<TicketDetailDto>({ queryKey: ticketKeys.details() }, (old) =>
    old && old.id === detail.id && isSameOrNewer(detail, old) ? detail : old,
  );
  queryClient.setQueryData<TicketDetailDto>(ticketKeys.detail(detail.ref), (old) =>
    !old || isSameOrNewer(detail, old) ? detail : old,
  );
  queryClient.setQueriesData<TicketPages>({ queryKey: ticketKeys.lists() }, (old) =>
    mapPages(old, (item) =>
      item.id === detail.id && isSameOrNewer(detail, item) ? { ...item, ...summary } : item,
    ),
  );
}

const isTicketPages = (data: unknown): data is TicketPages =>
  typeof data === 'object' && data !== null && 'pages' in data;

/** The ticket's copy inside a cached detail or list query, if it holds one. */
function ticketIn(data: unknown, ticketId: string): AnyTicketDto | undefined {
  if (isTicketPages(data)) {
    for (const page of data.pages) {
      const found = page.items.find((item) => item.id === ticketId);
      if (found) return found;
    }
    return undefined;
  }
  const ticket = data as AnyTicketDto | undefined;
  return ticket?.id === ticketId ? ticket : undefined;
}

/**
 * Whether a query holds a copy of the ticket (its detail, or a list with its row). Mutations
 * cancel and patch only these, so other tickets' loads are never disturbed.
 */
export function queryHoldsTicket(query: Query, ticketId: string): boolean {
  const [scope, kind] = query.queryKey;
  if (scope !== 'tickets' || (kind !== 'detail' && kind !== 'list')) return false;
  return ticketIn(query.state.data, ticketId) !== undefined;
}

interface CopyPatch {
  queryKey: QueryKey;
  /** The copy's `updatedAt` when it was patched (server writes move it on). */
  updatedAt: string;
  /** Fields the patch changed: the value before and the value it wrote. */
  fields: { key: string; before: unknown; after: unknown }[];
}

const DETAIL_ONLY = new Set<string>(DETAIL_ONLY_KEYS);

/**
 * Applies an optimistic `update` to every cached copy of a ticket and returns the rollback, which
 * undoes this patch only: a field goes back where it still holds the value the patch wrote, and a
 * copy a server update reached meanwhile (realtime `ticket:updated`, another response — its
 * `updatedAt` moved) keeps the server's summary fields. Newer data is never overwritten.
 */
export function patchTicketEverywhere(
  queryClient: QueryClient,
  ticketId: string,
  update: <T extends AnyTicketDto>(ticket: T) => T,
): () => void {
  const patches: CopyPatch[] = [];
  const cache = queryClient.getQueryCache();
  const queries = [
    ...cache.findAll({ queryKey: ticketKeys.details() }),
    ...cache.findAll({ queryKey: ticketKeys.lists() }),
  ];
  for (const query of queries) {
    const before = ticketIn(query.state.data, ticketId);
    if (!before) continue;
    const after = update(before);
    if (after === before) continue;
    const fields = Object.keys(after)
      .map((key) => ({
        key,
        before: (before as unknown as Record<string, unknown>)[key],
        after: (after as unknown as Record<string, unknown>)[key],
      }))
      .filter((field) => field.before !== field.after);
    if (fields.length === 0) continue;
    patches.push({ queryKey: query.queryKey, updatedAt: before.updatedAt, fields });
    queryClient.setQueryData(query.queryKey, (old: unknown) =>
      isTicketPages(old)
        ? mapPages(old, (item) => (item.id === ticketId ? (after as TicketSummaryDto) : item))
        : after,
    );
  }

  return () => {
    for (const patch of patches) {
      const revert = <T extends AnyTicketDto>(ticket: T): T => {
        if (ticket.id !== ticketId) return ticket;
        const serverMoved = ticket.updatedAt !== patch.updatedAt;
        const current = ticket as unknown as Record<string, unknown>;
        let reverted: Record<string, unknown> | null = null;
        for (const { key, before, after } of patch.fields) {
          if (current[key] !== after) continue; // changed again since: not ours to undo
          if (serverMoved && !DETAIL_ONLY.has(key)) continue; // the server's value now
          reverted = { ...(reverted ?? current), [key]: before };
        }
        return (reverted as unknown as T | null) ?? ticket;
      };
      const old = queryClient.getQueryData(patch.queryKey);
      if (old === undefined) continue;
      const next = isTicketPages(old) ? mapPages(old, revert) : revert(old as AnyTicketDto);
      if (next !== old) queryClient.setQueryData(patch.queryKey, next);
    }
  };
}

/** Every cached detail of the ticket (any ref spelling). */
export function findCachedTicket(
  queryClient: QueryClient,
  ticketId: string,
): TicketDetailDto | TicketSummaryDto | undefined {
  for (const [, data] of queryClient.getQueriesData<TicketDetailDto>({
    queryKey: ticketKeys.details(),
  })) {
    if (data?.id === ticketId) return data;
  }
  for (const [, data] of queryClient.getQueriesData<TicketPages>({
    queryKey: ticketKeys.lists(),
  })) {
    const found = data?.pages.flatMap((p) => p.items).find((t) => t.id === ticketId);
    if (found) return found;
  }
  return undefined;
}
