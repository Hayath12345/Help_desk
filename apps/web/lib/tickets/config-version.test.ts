import type { TicketFormConfig } from '@loons/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyConfigUpdated } from '@/lib/realtime/config-scopes';
import {
  CONFIG_VERSION_RETRY_DELAYS_MS,
  loadTicketFormConfig,
  requireFormConfigVersion,
  requiredFormConfigVersion,
} from './config-version';
import { ticketKeys } from './keys';
import { FORM_CONFIG } from './test-fixtures';

const api = vi.hoisted(() => ({ fetchTicketFormConfig: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

const at = (version: number): TicketFormConfig => ({ ...FORM_CONFIG, version });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.fetchTicketFormConfig.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('form config version chasing (E18)', () => {
  it('uses the first answer when nothing newer was announced', async () => {
    const queryClient = new QueryClient();
    api.fetchTicketFormConfig.mockResolvedValue(at(3));
    await expect(loadTicketFormConfig(queryClient)).resolves.toMatchObject({ version: 3 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(1);
  });

  it('refetches with a backoff until it reaches the announced version', async () => {
    const queryClient = new QueryClient();
    requireFormConfigVersion(queryClient, 5);
    api.fetchTicketFormConfig
      .mockResolvedValueOnce(at(3))
      .mockResolvedValueOnce(at(4))
      .mockResolvedValueOnce(at(5));
    const result = loadTicketFormConfig(queryClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CONFIG_VERSION_RETRY_DELAYS_MS[0] ?? 0);
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CONFIG_VERSION_RETRY_DELAYS_MS[1] ?? 0);
    await expect(result).resolves.toMatchObject({ version: 5 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(3);
  });

  it('accepts a newer version than announced, and version 0 (generation unknown)', async () => {
    const queryClient = new QueryClient();
    requireFormConfigVersion(queryClient, 5);
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(8));
    await expect(loadTicketFormConfig(queryClient)).resolves.toMatchObject({ version: 8 });
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(0));
    await expect(loadTicketFormConfig(queryClient)).resolves.toMatchObject({ version: 0 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last retry and keeps the newest answer', async () => {
    const queryClient = new QueryClient();
    requireFormConfigVersion(queryClient, 9);
    api.fetchTicketFormConfig.mockResolvedValue(at(4));
    const result = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ version: 4 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(
      CONFIG_VERSION_RETRY_DELAYS_MS.length + 1,
    );
  });

  it('after a generation reset (Redis restarted) later loads don’t chase the old number', async () => {
    const queryClient = new QueryClient();
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 50 });
    api.fetchTicketFormConfig.mockResolvedValue(at(2));
    const first = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toMatchObject({ version: 2 });
    expect(requiredFormConfigVersion(queryClient)).toBe(2);

    // The next load takes the answer at once; a new change after the reset is chased as usual.
    api.fetchTicketFormConfig.mockClear();
    await expect(loadTicketFormConfig(queryClient)).resolves.toMatchObject({ version: 2 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(1);
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 3 });
    api.fetchTicketFormConfig.mockClear();
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(2)).mockResolvedValueOnce(at(3));
    const next = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(next).resolves.toMatchObject({ version: 3 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(2);
  });

  it('takes a lower announced version as a generation reset: one refetch, no backoff', async () => {
    const queryClient = new QueryClient();
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 57 });
    // Redis was flushed; the next admin change announces generation 1, and the API serves it.
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 1 });
    api.fetchTicketFormConfig.mockResolvedValue(at(1));
    const loaded = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(loaded).resolves.toMatchObject({ version: 1 });
    // Confirmed by one refetch (it could be two events arriving out of order), not the backoff.
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(2);
    expect(requiredFormConfigVersion(queryClient)).toBe(1);

    // An answer older than that announcement is still chased.
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 2 });
    api.fetchTicketFormConfig.mockClear();
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(1)).mockResolvedValueOnce(at(2));
    const next = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(next).resolves.toMatchObject({ version: 2 });
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(2);
  });

  it('two events arriving out of order (6, then 5): a stale answer at 5 is not taken', async () => {
    const queryClient = new QueryClient();
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 6 });
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 5 });
    // The first answer is a cache fill from before change 6; the refetch has it.
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(5)).mockResolvedValueOnce(at(6));
    const loaded = loadTicketFormConfig(queryClient);
    await vi.runAllTimersAsync();
    await expect(loaded).resolves.toMatchObject({ version: 6 });
    expect(requiredFormConfigVersion(queryClient)).toBe(6);
  });

  it('stops waiting when the query is cancelled', async () => {
    const queryClient = new QueryClient();
    requireFormConfigVersion(queryClient, 9);
    api.fetchTicketFormConfig.mockResolvedValue(at(4));
    const controller = new AbortController();
    const result = loadTicketFormConfig(queryClient, controller.signal);
    const settled = result.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(settled).resolves.toBe('rejected');
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(1);
  });

  it('an open form refetches on config:updated until it sees the new version', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(3));
    // The open New-ticket form: an observer of the form-config query.
    const observer = new QueryObserver(queryClient, {
      queryKey: ticketKeys.formConfig(),
      queryFn: ({ signal }) => loadTicketFormConfig(queryClient, signal),
      staleTime: 5 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.version).toBe(3);

    // The admin's change committed as version 4; the first refetch still hits an old cache fill.
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(3)).mockResolvedValueOnce(at(4));
    applyConfigUpdated(queryClient, { scope: 'ticket-form', version: 4 });
    expect(requiredFormConfigVersion(queryClient)).toBe(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data?.version).toBe(3);
    await vi.advanceTimersByTimeAsync(CONFIG_VERSION_RETRY_DELAYS_MS[0] ?? 0);
    expect(observer.getCurrentResult().data?.version).toBe(4);
    expect(api.fetchTicketFormConfig).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('a form opened after the event chases the version on its first load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(ticketKeys.formConfig(), at(2));
    applyConfigUpdated(queryClient, { scope: 'calendar', version: 6 });
    // Nobody observed it: only marked stale, nothing fetched yet.
    expect(api.fetchTicketFormConfig).not.toHaveBeenCalled();
    api.fetchTicketFormConfig.mockResolvedValueOnce(at(5)).mockResolvedValueOnce(at(6));
    const observer = new QueryObserver(queryClient, {
      queryKey: ticketKeys.formConfig(),
      queryFn: ({ signal }) => loadTicketFormConfig(queryClient, signal),
      staleTime: 5 * 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(CONFIG_VERSION_RETRY_DELAYS_MS[0] ?? 0);
    expect(observer.getCurrentResult().data?.version).toBe(6);
    unsubscribe();
  });
});
