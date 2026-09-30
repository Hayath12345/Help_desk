'use client';

import { emailTemplatePreviewDtoSchema, type EmailTemplatePreviewDto } from '@loons/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Kicker } from '@/components/common/kicker';
import { Button } from '@/components/ui/button';
import { adminKeys, adminPath, adminWrite } from '@/lib/admin';
import { cn } from '@/lib/utils';
import type { ContentLanguage } from '../../kit';

/** Typing pauses this long before the preview is rendered again (each render is an API call). */
export const PREVIEW_DEBOUNCE_MS = 700;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export interface TemplatePreviewProps {
  templateKey: string;
  /** The language the preview renders (the caller applies the English fallback). */
  language: ContentLanguage;
  subject: string;
  body: string;
  /** Shown above the preview (e.g. "this email goes out in English"). */
  note?: React.ReactNode;
  debounceMs?: number;
}

/**
 * Live preview of a template draft (E14): the API renders it with @loons/emails and sample values;
 * the HTML is shown in a sandboxed frame (no scripts, no navigation) under its subject line.
 */
export function TemplatePreview({
  templateKey,
  language,
  subject,
  body,
  note,
  debounceMs = PREVIEW_DEBOUNCE_MS,
}: TemplatePreviewProps) {
  const t = useTranslations('admin-comms.emailTemplates.preview');
  // One object per actual change (the three move together, e.g. on a language switch): a fresh
  // literal every render would restart the timer and set new state forever, re-rendering at every
  // interval even when idle.
  const current = useMemo(() => ({ language, subject, body }), [language, subject, body]);
  const draft = useDebounced(current, debounceMs);
  const preview = useQuery<EmailTemplatePreviewDto>({
    queryKey: [
      ...adminKeys.section('email-templates'),
      'preview',
      templateKey,
      draft.language,
      draft.subject,
      draft.body,
    ],
    queryFn: () =>
      adminWrite(
        'POST',
        adminPath('email-templates', templateKey, 'preview'),
        { locale: draft.language, subject: draft.subject, body: draft.body },
        emailTemplatePreviewDtoSchema,
      ),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const data = preview.data;
  const languageName = t(`languages.${language}`);

  return (
    <section
      aria-labelledby={`${templateKey}-preview-title`}
      aria-busy={preview.isFetching || undefined}
      className="flex min-w-0 flex-col gap-2.5"
    >
      <div className="flex flex-col gap-0.5">
        <Kicker as="h3" id={`${templateKey}-preview-title`}>
          {t('title')}
        </Kicker>
        <p className="text-[13px] text-ink-muted">{t('description')}</p>
      </div>
      {note ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-[13px] leading-normal text-ink-secondary"
        >
          {note}
        </p>
      ) : null}
      {preview.isError && !data ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface p-4 text-[13px] text-ink-secondary"
        >
          <span className="flex items-center gap-2">
            <AlertCircle aria-hidden="true" className="size-4 text-danger" />
            {t('error')}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void preview.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : !data ? (
        <p role="status" className="rounded-lg border border-line bg-surface p-4 text-ink-muted">
          {t('loading')}
        </p>
      ) : (
        <div
          className={cn(
            'flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface transition-opacity duration-150',
            preview.isFetching && 'opacity-70',
          )}
        >
          <div className="flex min-w-0 flex-col gap-0.5 border-b border-divider px-3.5 py-2.5">
            <Kicker as="span">{t('subject')}</Kicker>
            <p
              lang={draft.language}
              dir={draft.language === 'ar' ? 'rtl' : 'ltr'}
              className="min-w-0 font-medium break-words text-ink"
              data-testid="template-preview-subject"
            >
              {data.subject}
            </p>
          </div>
          <iframe
            title={t('frameTitle', { language: languageName })}
            sandbox=""
            srcDoc={data.html}
            className="h-[480px] w-full bg-surface"
          />
        </div>
      )}
    </section>
  );
}
