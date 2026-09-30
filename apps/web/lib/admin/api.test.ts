import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiRequestError } from '@/lib/api/errors';
import { adminGet, adminListFetcher, adminPath, adminWrite, withExpectedUpdatedAt } from './api';
import { adminConflictDetails, applyServerIssues, isStaleConflict } from './errors';
import { adminKeys, normalizeAdminParams } from './keys';

const client = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({ apiClient: client }));

beforeEach(() => {
  client.get.mockReset();
  client.request.mockReset();
});

const itemSchema = z.object({ item: z.object({ id: z.string() }) });

describe('admin fetchers', () => {
  it('builds /admin/<section>/… paths with encoded segments', () => {
    expect(adminPath('categories')).toBe('/admin/categories');
    expect(adminPath('categories', 'id 1', 'subtypes', 2)).toBe(
      '/admin/categories/id%201/subtypes/2',
    );
  });

  it('GETs with the list params and parses the answer', async () => {
    client.get.mockResolvedValue({ items: [] });
    const fetcher = adminListFetcher('teams', z.object({ items: z.array(z.unknown()) }), {
      params: { status: 'all', search: '' },
    });
    await expect(fetcher()).resolves.toEqual({ items: [] });
    expect(client.get).toHaveBeenCalledWith('/admin/teams?status=all', { signal: undefined });

    client.get.mockResolvedValue({ nope: true });
    await expect(
      adminGet('/admin/teams', z.object({ items: z.array(z.unknown()) })),
    ).rejects.toThrow();
  });

  it('writes with the method and JSON body, parsing the answer when a schema is given', async () => {
    client.request.mockResolvedValue({ item: { id: 'x' } });
    await expect(
      adminWrite('PATCH', '/admin/teams/x', { nameEn: 'SOC' }, itemSchema),
    ).resolves.toEqual({ item: { id: 'x' } });
    expect(client.request).toHaveBeenCalledWith('/admin/teams/x', {
      method: 'PATCH',
      json: { nameEn: 'SOC' },
    });
    client.request.mockResolvedValue(undefined);
    await expect(adminWrite('POST', '/admin/teams/reorder')).resolves.toBeUndefined();
    expect(client.request).toHaveBeenLastCalledWith('/admin/teams/reorder', { method: 'POST' });
  });

  it('sends the updatedAt the edit started from (E19)', () => {
    expect(
      withExpectedUpdatedAt({ nameEn: 'SOC' }, { updatedAt: '2026-09-29T10:00:00.000Z' }),
    ).toEqual({ nameEn: 'SOC', expectedUpdatedAt: '2026-09-29T10:00:00.000Z' });
    expect(
      withExpectedUpdatedAt({}, { updatedAt: new Date('2026-09-29T10:00:00.000Z') })
        .expectedUpdatedAt,
    ).toBe('2026-09-29T10:00:00.000Z');
  });

  it('normalises list params in query keys', () => {
    expect(adminKeys.list('clients', { status: 'active', search: '', b: 1 })).toEqual([
      'admin',
      'clients',
      'list',
      { b: 1, status: 'active' },
    ]);
    expect(normalizeAdminParams(undefined)).toEqual({});
  });
});

describe('admin errors', () => {
  const conflict = (details?: unknown) =>
    new ApiRequestError(409, 'CONFLICT', 'conflict', undefined, details);

  it('tells a lost update (stale / order_changed) from other 409s', () => {
    expect(isStaleConflict(conflict({ reason: 'stale' }))).toBe(true);
    expect(isStaleConflict(conflict({ reason: 'order_changed' }))).toBe(true);
    expect(isStaleConflict(conflict())).toBe(true);
    expect(isStaleConflict(conflict({ reason: 'duplicate', fields: ['key'] }))).toBe(false);
    expect(isStaleConflict(conflict({ reason: 'guard', guard: 'security_category' }))).toBe(false);
    expect(isStaleConflict(conflict({ reason: 'in_use' }))).toBe(false);
    expect(isStaleConflict(new ApiRequestError(400, 'BAD_REQUEST', 'x'))).toBe(false);
    expect(isStaleConflict(new Error('x'))).toBe(false);
    // A coded 409 about the data (POST /admin/staff with a taken email) is not a lost update.
    expect(isStaleConflict(new ApiRequestError(409, 'EMAIL_TAKEN', 'taken'))).toBe(false);
    expect(adminConflictDetails(conflict({ reason: 'guard', guard: 'last_super_admin' }))).toEqual({
      reason: 'guard',
      guard: 'last_super_admin',
    });
  });

  it('puts validation issues on the form fields and focuses the first', () => {
    const setError = vi.fn();
    const error = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      { path: ['labelEn'], message: 'validation.required' },
      { path: ['subtypes', 0, 'labelEn'], message: 'validation.tooLong' },
      { path: ['unknown'], message: 'validation.invalid' },
    ]);
    const mapped = applyServerIssues(error, setError, {
      paths: ['labelEn', 'subtypes.0.labelEn'],
      message: (m) => `t(${m})`,
    });
    expect(mapped).toBe(2);
    expect(setError).toHaveBeenNthCalledWith(
      1,
      'labelEn',
      { type: 'server', message: 't(validation.required)' },
      { shouldFocus: true },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      'subtypes.0.labelEn',
      { type: 'server', message: 't(validation.tooLong)' },
      { shouldFocus: false },
    );
    expect(applyServerIssues(conflict(), setError)).toBe(0);
  });
});
