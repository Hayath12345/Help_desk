'use client';

// Data of the Categories & sub-types section (API: /admin/categories, contract
// packages/shared/src/schemas/admin/categories.ts). Every write refreshes the `ticket-form` scope
// in this tab (lists, the form config); other tabs and users follow through `config:updated`.

import {
  categoryListSchema,
  categoryResponseSchema,
  subtypeResponseSchema,
  type CategoryAdminDto,
  type SubtypeAdminDto,
} from '@loons/shared';
import type { z } from 'zod';
import { adminListFetcher, adminPath, adminWrite, useAdminList } from '@/lib/admin';

export type CategoryList = z.output<typeof categoryListSchema>;

/** Every category (archived ones too: the table filters them, keys stay unique across both). */
export const CATEGORY_LIST_PARAMS = { status: 'all' } as const;

export function useCategoryList() {
  return useAdminList({
    section: 'categories',
    params: CATEGORY_LIST_PARAMS,
    queryFn: adminListFetcher('categories', categoryListSchema, { params: CATEGORY_LIST_PARAMS }),
  });
}

export const categoriesApi = {
  create: async (body: unknown): Promise<CategoryAdminDto> =>
    (await adminWrite('POST', adminPath('categories'), body, categoryResponseSchema)).item,
  update: async (id: string, body: unknown): Promise<CategoryAdminDto> =>
    (await adminWrite('PATCH', adminPath('categories', id), body, categoryResponseSchema)).item,
  setFields: async (id: string, body: unknown): Promise<CategoryAdminDto> =>
    (await adminWrite('PUT', adminPath('categories', id, 'fields'), body, categoryResponseSchema))
      .item,
  setSkills: async (id: string, body: unknown): Promise<CategoryAdminDto> =>
    (await adminWrite('PUT', adminPath('categories', id, 'skills'), body, categoryResponseSchema))
      .item,
  archive: async (id: string, expectedUpdatedAt: string): Promise<CategoryAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('categories', id, 'archive'),
        { expectedUpdatedAt },
        categoryResponseSchema,
      )
    ).item,
  restore: async (id: string, expectedUpdatedAt: string): Promise<CategoryAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('categories', id, 'restore'),
        { expectedUpdatedAt },
        categoryResponseSchema,
      )
    ).item,
  reorder: (body: { ids: string[]; expectedIds: string[] }) =>
    adminWrite('POST', adminPath('categories', 'reorder'), body),
  createSubtype: async (categoryId: string, body: unknown): Promise<SubtypeAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('categories', categoryId, 'subtypes'),
        body,
        subtypeResponseSchema,
      )
    ).item,
  updateSubtype: async (categoryId: string, id: string, body: unknown): Promise<SubtypeAdminDto> =>
    (
      await adminWrite(
        'PATCH',
        adminPath('categories', categoryId, 'subtypes', id),
        body,
        subtypeResponseSchema,
      )
    ).item,
  setSubtypeActive: async (
    categoryId: string,
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<SubtypeAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('categories', categoryId, 'subtypes', id, active ? 'restore' : 'archive'),
        { expectedUpdatedAt },
        subtypeResponseSchema,
      )
    ).item,
  reorderSubtypes: (categoryId: string, body: { ids: string[]; expectedIds: string[] }) =>
    adminWrite('POST', adminPath('categories', categoryId, 'subtypes', 'reorder'), body),
};
