'use client';

// Data of the Custom fields section (API: /admin/custom-fields, contract
// packages/shared/src/schemas/admin/custom-fields.ts). The category sheet reads the same list to
// link fields.

import {
  customFieldListSchema,
  customFieldResponseSchema,
  type CustomFieldAdminDto,
} from '@loons/shared';
import type { z } from 'zod';
import { adminListFetcher, adminPath, adminWrite, useAdminList } from '@/lib/admin';

export type CustomFieldList = z.output<typeof customFieldListSchema>;

export const FIELD_LIST_PARAMS = { status: 'all' } as const;

export function useCustomFieldList(options: { enabled?: boolean } = {}) {
  return useAdminList({
    section: 'custom-fields',
    params: FIELD_LIST_PARAMS,
    queryFn: adminListFetcher('custom-fields', customFieldListSchema, {
      params: FIELD_LIST_PARAMS,
    }),
    enabled: options.enabled,
  });
}

export const customFieldsApi = {
  create: async (body: unknown): Promise<CustomFieldAdminDto> =>
    (await adminWrite('POST', adminPath('custom-fields'), body, customFieldResponseSchema)).item,
  update: async (id: string, body: unknown): Promise<CustomFieldAdminDto> =>
    (await adminWrite('PATCH', adminPath('custom-fields', id), body, customFieldResponseSchema))
      .item,
  setActive: async (
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<CustomFieldAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('custom-fields', id, active ? 'restore' : 'archive'),
        { expectedUpdatedAt },
        customFieldResponseSchema,
      )
    ).item,
};
