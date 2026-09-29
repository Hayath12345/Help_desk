'use client';

// Translation helpers shared by the ticket UI (messages: `tickets`, `validation`, `errors`).

import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { isApiRequestError } from '@/lib/api/errors';
import { formatNumber, isolateDirection } from '@/lib/format';
import { hasArabic, localizedAssetPlaceholder } from './labels';
import { slaWindowParts } from './sla-format';

/** The user-facing sentence for an API error code (errors namespace; INTERNAL as the fallback). */
export function useApiErrorText(): (error: unknown) => string {
  const t = useTranslations('errors');
  return useCallback(
    (error: unknown) => {
      const code = isApiRequestError(error) ? error.code : 'INTERNAL';
      return t.has(code) ? t(code) : t('INTERNAL');
    },
    [t],
  );
}

type Values = Record<string, string | number>;
type Untyped = (key: string, values?: Values) => string;

/**
 * Translates a zod / API validation message into the UI language. Accepts `validation.<key>`
 * (shared schemas, e.g. validation.subjectRequired) and `tickets.<path>` (ticket-form rules, e.g.
 * tickets.newTicket.errors.siteRequired); anything else becomes the generic "Check this value.".
 */
export function useTicketValidationMessage(): (
  message: string | undefined,
  values?: Values,
) => string | undefined {
  const tValidation = useTranslations('validation');
  const tTickets = useTranslations('tickets');
  return useCallback(
    (message, values) => {
      if (!message) return undefined;
      if (message.startsWith('validation.')) {
        const key = message.slice('validation.'.length);
        if (tValidation.has(key as never)) return (tValidation as unknown as Untyped)(key, values);
      } else if (message.startsWith('tickets.')) {
        const key = message.slice('tickets.'.length);
        if (tTickets.has(key as never)) return (tTickets as unknown as Untyped)(key, values);
      }
      return tValidation('invalid');
    },
    [tValidation, tTickets],
  );
}

/** "15 min", "1 hour", "2 business days" (Latin digits in both languages, like the design). */
export function useSlaWindowFormatter(): (minutes: number, businessHoursOnly: boolean) => string {
  const t = useTranslations('tickets.duration');
  const locale = useLocale();
  return useCallback(
    (minutes, businessHoursOnly) => {
      const parts = slaWindowParts(minutes, businessHoursOnly);
      const n = (value: number) => formatNumber(value, locale);
      switch (parts.unit) {
        case 'minutes':
          return t('minutes', { n: n(parts.n) });
        case 'hours':
          return t('hours', { count: parts.n, n: n(parts.n) });
        case 'days':
          return t('days', { count: parts.n, n: n(parts.n) });
        case 'businessDays':
          return t('businessDays', { count: parts.n, n: n(parts.n) });
        case 'hoursMinutes':
          return t('hoursMinutes', { hours: n(parts.hours), minutes: n(parts.minutes) });
      }
    },
    [t, locale],
  );
}

/**
 * A category's asset placeholder in the UI language (`localizedAssetPlaceholder`): "e.g. FW-01"
 * reads "مثال: FW-01" in Arabic, "Optional" reads "اختياري". Undefined when the category has none.
 *
 * In Arabic the result carries its own direction, whatever the input's: the console's asset
 * editor keeps `dir="ltr"` for the IDs typed into it, the New ticket form's input is RTL. Arabic
 * text is isolated right-to-left (RLI … PDI), so "مثال: FW-01" doesn't read "FW-01 :مثال" in the
 * LTR input; text still in English (a placeholder shown as configured) left-to-right (LRI … PDI),
 * so "Serial on the label." keeps its full stop at the end in either input (UI-RR-2).
 */
export function useAssetPlaceholder(): (
  placeholder: string | null | undefined,
) => string | undefined {
  const t = useTranslations('tickets.assetPlaceholder');
  const locale = useLocale();
  return useCallback(
    (placeholder) => {
      const text = localizedAssetPlaceholder(placeholder, locale, {
        example: (example) => t('example', { example }),
        optional: t('optional'),
      });
      if (text === undefined || locale !== 'ar') return text;
      return isolateDirection(text, hasArabic(text) ? 'rtl' : 'ltr');
    },
    [t, locale],
  );
}
