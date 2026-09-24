import type { AuthUser } from '@loons/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { USER_LOOKUP_TIMEOUT_MS, lookupUser } from './user-lookup';

vi.mock('@/lib/api/internal', () => ({ internalApiFetch: vi.fn() }));
const apiFetch = vi.mocked(internalApiFetch);

const user: AuthUser = {
  id: '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f',
  email: 'aisha.alkuwari@hamad.qa',
  name: 'Aisha Al-Kuwari',
  role: 'CLIENT',
  status: 'ACTIVE',
  orgId: null,
  locale: 'en',
  teamIds: [],
  sessionVersion: 0,
  emailVerified: false,
};

beforeEach(() => apiFetch.mockReset());

describe('lookupUser', () => {
  it('asks the API with a short timeout and no client IP', async () => {
    apiFetch.mockResolvedValue({ user });
    await expect(lookupUser(user.id)).resolves.toEqual({ kind: 'found', user });
    expect(USER_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    const [path, init] = apiFetch.mock.calls[0] ?? [];
    expect(path).toBe(`/internal/auth/users/${user.id}`);
    expect(init?.clientIp).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('uses a timeout signal of USER_LOOKUP_TIMEOUT_MS', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    apiFetch.mockResolvedValue({ user });
    await lookupUser(user.id);
    expect(timeout).toHaveBeenCalledWith(USER_LOOKUP_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it('reports a timeout or a failing API as unavailable, and 404 as gone', async () => {
    apiFetch.mockRejectedValueOnce(new ApiRequestError(0, 'INTERNAL', 'API request timed out'));
    await expect(lookupUser(user.id)).resolves.toEqual({ kind: 'unavailable' });
    apiFetch.mockRejectedValueOnce(new ApiRequestError(503, 'SERVICE_UNAVAILABLE', 'down'));
    await expect(lookupUser(user.id)).resolves.toEqual({ kind: 'unavailable' });
    apiFetch.mockResolvedValueOnce({ nope: true });
    await expect(lookupUser(user.id)).resolves.toEqual({ kind: 'unavailable' });
    apiFetch.mockRejectedValueOnce(new ApiRequestError(404, 'NOT_FOUND', 'gone'));
    await expect(lookupUser(user.id)).resolves.toEqual({ kind: 'gone' });
  });
});
