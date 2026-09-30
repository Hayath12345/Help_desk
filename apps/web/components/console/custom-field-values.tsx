'use client';

import type { CustomFieldValue, Locale } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import { Kicker } from '@/components/common/kicker';
import { formatDate } from '@/lib/format';
import { localizedLabel } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';

// The ticket's custom-field values in the console panel (decision E6): every value the ticket
// holds, in the category's form order, with the field's label — and an "archived" marker on a
// field or option that has been archived since (old tickets keep showing them).

/** One value as text: option labels for dropdowns, Yes / No, a formatted date, else as stored. */
export function formatCustomFieldValue(
  field: CustomFieldValue,
  locale: Locale,
  words: { yes: string; no: string; archived: (label: string) => string },
): string {
  const { value } = field;
  if (field.options) {
    return field.options
      .map((option) => {
        const label = localizedLabel(option, locale);
        return option.isActive ? label : words.archived(label);
      })
      .join(', ');
  }
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  if (field.type === 'DATE' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDate(`${value}T00:00:00Z`, locale, 'UTC');
  }
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

export function CustomFieldValues({ fields }: { fields: readonly CustomFieldValue[] }) {
  const t = useTranslations('console.panel');
  const tTickets = useTranslations('tickets');
  const locale = useLocale() as Locale;
  const headingId = useId();
  if (fields.length === 0) return null;
  const words = {
    yes: tTickets('yes'),
    no: tTickets('no'),
    archived: (label: string) => t('archived', { label }),
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <Kicker as="h3" id={headingId}>
        {t('customFields')}
      </Kicker>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {fields.map((field) => {
          const label = localizedLabel(field, locale);
          return (
            <div key={field.key} className="contents">
              <dt className="text-ink-muted [overflow-wrap:anywhere]">
                {field.isActive ? label : t('archived', { label })}
              </dt>
              <dd
                className={cn(
                  'min-w-0 px-1 text-ink [overflow-wrap:anywhere]',
                  field.type === 'ASSET_ID' && 'font-mono text-[13px]',
                )}
              >
                <bdi>{formatCustomFieldValue(field, locale, words)}</bdi>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
