'use client';

// Helpers shared by the People & clients sections (Teams & members, Staff, Clients & sites):
// translation of the API's validation keys and 409 answers, the staff picker data, and small
// display bits. Strings: messages/<locale>/admin-people.json.

import { staffDirectorySchema, type StaffDirectoryEntry } from '@loons/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { adminConflictDetails, adminGet, adminKeys, type AdminListParams } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';

type Untyped = (key: string, values?: Record<string, string | number>) => string;

/**
 * A zod / API validation message (`validation.<key>`) in the UI language: the People strings
 * first (admin-people.validation), then the app's validation namespace, else "Check this value.".
 */
export function usePeopleValidation(): (message: string | undefined) => string | undefined {
  const tPeople = useTranslations('admin-people.validation');
  const tValidation = useTranslations('validation');
  return useCallback(
    (message) => {
      if (!message) return undefined;
      const key = message.startsWith('validation.') ? message.slice('validation.'.length) : '';
      if (key && tPeople.has(key as never)) return (tPeople as unknown as Untyped)(key);
      if (key && tValidation.has(key as never)) return (tValidation as unknown as Untyped)(key);
      return tValidation('invalid');
    },
    [tPeople, tValidation],
  );
}

/**
 * The sentence for a failed People write: archive / change guards and duplicates (409), the
 * first validation issue (400), else the generic text of the error code.
 */
export function usePeopleErrorText(): (error: unknown) => string {
  const t = useTranslations('admin-people.guards');
  const validation = usePeopleValidation();
  const apiErrorText = useApiErrorText();
  return useCallback(
    (error) => {
      const details = adminConflictDetails(error);
      if (details?.reason === 'guard' && details.guard && t.has(details.guard as never)) {
        return (t as unknown as Untyped)(details.guard);
      }
      if (details?.reason === 'duplicate') {
        const fields = details.fields ?? [];
        if (fields.includes('emailDomains')) {
          return details.existingIsActive === false
            ? t('duplicateDomainArchived')
            : t('duplicateDomain');
        }
        if (fields.includes('userId')) return t('duplicateMember');
        if (fields.includes('key')) return t('duplicateKey');
      }
      if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
        const first = validationIssues(error)[0];
        if (first) return validation(first.message) ?? apiErrorText(error);
      }
      return apiErrorText(error);
    },
    [t, validation, apiErrorText],
  );
}

/** Active staff for the pickers (GET /admin/staff-directory; super admins and team leads). */
export function useStaffDirectory(params: AdminListParams = {}, enabled = true) {
  return useQuery({
    queryKey: adminKeys.staffDirectory(params),
    queryFn: ({ signal }) =>
      adminGet('/admin/staff-directory', staffDirectorySchema, { params, signal }),
    select: (data): StaffDirectoryEntry[] => data.items,
    enabled,
    staleTime: 30_000,
  });
}

/** "a@x.com, b@y.com\nc@z.com" → ['a@x.com', 'b@y.com', 'c@z.com'] (trimmed, empties dropped). */
export function linesToList(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function listToLines(list: readonly string[]): string {
  return list.join('\n');
}

/** Whether a staff member can be paged: an international phone, a phone in another format, none. */
export function PhoneStatus({ hasPhone, phoneValid }: { hasPhone: boolean; phoneValid: boolean }) {
  const t = useTranslations('admin-people.common');
  if (phoneValid) return <Badge variant="success">{t('phoneOk')}</Badge>;
  if (hasPhone) return <Badge variant="warning">{t('phoneInvalid')}</Badge>;
  return <Badge variant="secondary">{t('phoneMissing')}</Badge>;
}
