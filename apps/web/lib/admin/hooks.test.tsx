// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { ticketKeys } from '@/lib/tickets/keys';
import enAdmin from '@/messages/en/admin.json';
import enErrors from '@/messages/en/errors.json';
import { reorderById, useAdminList, useAdminMutation } from './hooks';
import { adminKeys } from './keys';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

interface Row {
  id: string;
  name: string;
}
const LIST = {
  items: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ] as Row[],
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={{ errors: enErrors, admin: enAdmin }}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const stale = () =>
  new ApiRequestError(409, 'CONFLICT', 'changed', undefined, {
    reason: 'stale',
    currentUpdatedAt: '2026-09-29T10:00:00.000Z',
  });

describe('useAdminList', () => {
  it("caches under ['admin', section, 'list', params]", async () => {
    const { queryClient, wrapper } = setup();
    const queryFn = vi.fn(async () => LIST);
    const { result } = renderHook(
      () => useAdminList({ section: 'categories', params: { status: 'all' }, queryFn }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual(LIST));
    expect(queryClient.getQueryData(['admin', 'categories', 'list', { status: 'all' }])).toEqual(
      LIST,
    );
    expect(queryFn).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
});

describe('useAdminMutation', () => {
  it('applies an optimistic change and rolls it back when the request fails', async () => {
    const { queryClient, wrapper } = setup();
    const key = adminKeys.list('categories');
    queryClient.setQueryData(key, LIST);
    let fail!: (error: unknown) => void;
    const mutationFn = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const { result } = renderHook(
      () =>
        useAdminMutation<string[], void, typeof LIST>({
          section: 'categories',
          mutationFn,
          optimistic: (cached, ids) => ({
            items: reorderById(cached.items, ids, (r) => r.id),
          }),
        }),
      { wrapper },
    );
    act(() => result.current.mutate(['b', 'a']));
    await waitFor(() =>
      expect(queryClient.getQueryData<typeof LIST>(key)?.items.map((r) => r.id)).toEqual([
        'b',
        'a',
      ]),
    );
    act(() => fail(new ApiRequestError(503, 'SERVICE_UNAVAILABLE', 'down')));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData<typeof LIST>(key)?.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(toast.error).toHaveBeenCalledWith(enErrors.SERVICE_UNAVAILABLE);
    expect(result.current.isConflict).toBe(false);
  });

  it('turns a stale 409 into isConflict without a toast (the sheet shows it)', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useAdminMutation<{ name: string }>({
          section: 'teams',
          mutationFn: () => Promise.reject(stale()),
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ name: 'x' }));
    await waitFor(() => expect(result.current.isConflict).toBe(true));
    expect(toast.error).not.toHaveBeenCalled();
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.isConflict).toBe(false));
  });

  it('shows a coded 409 (EMAIL_TAKEN) as its own error, not the stale "reload" state', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () =>
        useAdminMutation<{ email: string }>({
          section: 'staff',
          mutationFn: () => Promise.reject(new ApiRequestError(409, 'EMAIL_TAKEN', 'taken')),
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ email: 'a@b.c' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enErrors.EMAIL_TAKEN));
    expect(result.current.isConflict).toBe(false);
  });

  it('leaves validation errors to the form, but toasts other conflicts (a guard)', async () => {
    const { wrapper } = setup();
    const errors = [
      new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
        { path: ['labelEn'], message: 'validation.required' },
      ]),
      new ApiRequestError(409, 'CONFLICT', 'in use', undefined, {
        reason: 'guard',
        guard: 'team_has_open_tickets',
      }),
    ];
    const { result } = renderHook(
      () =>
        useAdminMutation<number>({
          section: 'teams',
          mutationFn: (i) => Promise.reject(errors[i]),
        }),
      { wrapper },
    );
    act(() => result.current.mutate(0));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).not.toHaveBeenCalled();
    act(() => result.current.mutate(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enErrors.CONFLICT));
    expect(result.current.isConflict).toBe(false);
  });

  it('says a reorder was refused because the order changed (and rolls it back)', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(adminKeys.list('categories'), LIST);
    const { result } = renderHook(
      () =>
        useAdminMutation<string[], unknown, typeof LIST>({
          section: 'categories',
          mutationFn: () =>
            Promise.reject(
              new ApiRequestError(409, 'CONFLICT', 'moved', undefined, { reason: 'order_changed' }),
            ),
          optimistic: (cached, ids) => ({ items: reorderById(cached.items, ids, (r) => r.id) }),
        }),
      { wrapper },
    );
    act(() => result.current.mutate(['b', 'a']));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enAdmin.kit.reorder.orderChanged));
    expect(queryClient.getQueryData(adminKeys.list('categories'))).toEqual(LIST);
  });

  it('toasts success and refreshes the section and the scopes it touched in this tab', async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        useAdminMutation<{ name: string }, { name: string }>({
          section: 'macros',
          mutationFn: async (input) => input,
          scopes: ['macros'],
          success: (saved) => `${saved.name} created`,
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ name: 'Request photos' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Request photos created');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: adminKeys.section('macros') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.macros() });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ticketKeys.formConfig() });
  });
});

describe('reorderById', () => {
  it('orders by id, ignoring unknown ids and keeping missing items last', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(reorderById(items, ['c', 'x', 'a'], (i) => i.id).map((i) => i.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});
