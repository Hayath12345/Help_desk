'use client';

import {
  PRIORITIES,
  type CustomFieldType,
  type Locale,
  type Priority,
  type TicketFormConfig,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Kicker } from '@/components/common/kicker';
import { PRIORITY_DOT } from '@/components/common/priority';
import { LanguageSwitch, contentLanguageProps, type ContentLanguage } from '@/components/admin/kit';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isolateDirection } from '@/lib/format';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import {
  fieldPlaceholder,
  hasArabic,
  localizedAssetPlaceholder,
  localizedLabel,
  teamName,
} from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import { CategoryIcon } from './setup-shared';

// E16: a slim, read-only New Ticket renderer beside the category form (not the real modal). It is
// built from the draft — the labels, placeholder, sub-types and linked fields being edited — so
// the admin sees what clients will see before saving. Labels can be previewed in English or
// Arabic; the surrounding words stay in the UI language.

export interface PreviewSubtype {
  id: string;
  labelEn: string;
  labelAr: string;
  defaultPriority: Priority;
}

export interface PreviewField {
  id: string;
  labelEn: string;
  labelAr: string;
  type: CustomFieldType;
  required: boolean;
  placeholderEn: string | null;
  placeholderAr: string | null;
  options: ReadonlyArray<{ value: string; labelEn: string; labelAr: string }>;
}

export interface CategoryPreviewProps {
  labelEn: string;
  labelAr: string;
  icon: string;
  team: { nameEn: string; nameAr: string } | null;
  assetPlaceholder: string;
  assetPlaceholderAr: string;
  /** Active sub-types in form order. */
  subtypes: readonly PreviewSubtype[];
  /** Active linked fields in form order. */
  fields: readonly PreviewField[];
  slaPolicies: TicketFormConfig['slaPolicies'] | undefined;
}

/** The Arabic placeholder when set, else the English one in Arabic words (as the form does). */
function assetPlaceholderFor(
  en: string,
  ar: string,
  language: Locale,
  words: { example: (example: string) => string; optional: string },
): string | undefined {
  if (language === 'ar' && ar.trim()) return isolateDirection(ar.trim(), 'rtl');
  const text = localizedAssetPlaceholder(en, language, words);
  if (text === undefined || language !== 'ar') return text;
  return isolateDirection(text, hasArabic(text) ? 'rtl' : 'ltr');
}

export function CategoryPreview(props: CategoryPreviewProps) {
  const t = useTranslations('admin-setup.categories.preview');
  const tForm = useTranslations('tickets.newTicket');
  const tPriority = useTranslations('common.priority');
  const tAsset = useTranslations('tickets.assetPlaceholder');
  const uiLocale = useLocale();
  const formatWindow = useSlaWindowFormatter();
  const id = useId();
  const [language, setLanguage] = useState<ContentLanguage>(uiLocale === 'ar' ? 'ar' : 'en');
  const [chosen, setChosen] = useState<string | null>(null);

  const content = contentLanguageProps(language);
  const label = (item: { labelEn: string; labelAr: string }) => localizedLabel(item, language);
  const subtype = props.subtypes.find((s) => s.id === chosen) ?? props.subtypes[0] ?? null;
  const defaultPriority = subtype?.defaultPriority ?? null;
  const placeholder = assetPlaceholderFor(
    props.assetPlaceholder,
    props.assetPlaceholderAr,
    language,
    {
      example: (example) => tAsset('example', { example }),
      optional: tAsset('optional'),
    },
  );

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface-muted p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Kicker as="h3" id={`${id}-title`}>
          {t('title')}
        </Kicker>
        <LanguageSwitch value={language} onValueChange={setLanguage} aria-label={t('language')} />
      </div>
      <p className="text-[13px] leading-normal text-ink-muted">{t('hint')}</p>

      <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-brand-tint text-brand">
            <CategoryIcon name={props.icon} className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span {...content} className="truncate font-semibold text-ink">
              {label(props) || t('untitled')}
            </span>
            {props.team ? (
              <span className="truncate text-xs text-ink-muted">
                {tForm('routedTo')} · {teamName(props.team, uiLocale as Locale)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-subtype`} className="text-sm font-medium text-ink">
            {tForm('subtype')}
          </label>
          {props.subtypes.length ? (
            <Select value={subtype?.id ?? ''} onValueChange={setChosen}>
              <SelectTrigger id={`${id}-subtype`} className="w-full" {...content}>
                <SelectValue placeholder={tForm('subtypePlaceholder')} />
              </SelectTrigger>
              <SelectContent position="popper" {...content}>
                {props.subtypes.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {label(s) || t('untitled')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-[13px] text-ink-muted">{t('noSubtypes')}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span id={`${id}-priority`} className="text-sm font-medium text-ink">
            {tForm('priority')}
          </span>
          <ul
            aria-labelledby={`${id}-priority`}
            className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2"
          >
            {PRIORITIES.map((priority) => {
              const policy = props.slaPolicies?.find((p) => p.priority === priority);
              const isDefault = priority === defaultPriority;
              return (
                <li
                  key={priority}
                  aria-current={isDefault ? 'true' : undefined}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm',
                    isDefault && 'border-brand bg-brand-tint',
                  )}
                >
                  <span className="flex items-center gap-[7px] font-semibold text-ink">
                    <span
                      aria-hidden="true"
                      className={cn('size-2 shrink-0 rounded-full', PRIORITY_DOT[priority])}
                    />
                    {tPriority(priority)}
                  </span>
                  {policy ? (
                    <span className="font-mono text-xs text-ink-secondary">
                      {tForm('firstReply', {
                        duration: formatWindow(policy.firstReplyMins, policy.businessHoursOnly),
                      })}
                    </span>
                  ) : null}
                  {isDefault ? (
                    <span className="text-xs font-medium text-brand">{t('defaultPriority')}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <fieldset disabled className="flex min-w-0 flex-col gap-4">
          <legend className="sr-only">{t('fieldsLegend')}</legend>
          <PreviewInput
            id={`${id}-asset`}
            label={tForm('asset')}
            note={tForm('optional')}
            // No example on the category: the form's generic hint, as the New Ticket form does.
            placeholder={placeholder ?? tForm('assetPlaceholder')}
            mono
          />
          {props.fields.length === 0 ? (
            <p className="text-[13px] text-ink-muted">{t('noFields')}</p>
          ) : (
            props.fields.map((field) => (
              <PreviewCustomField
                key={field.id}
                id={`${id}-${field.id}`}
                field={field}
                language={language}
              />
            ))
          )}
        </fieldset>
      </div>
    </section>
  );
}

function PreviewInput({
  id,
  label,
  note,
  required,
  placeholder,
  mono,
  type = 'text',
  lang,
}: {
  id: string;
  label: string;
  note?: string;
  required?: boolean;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  lang?: ContentLanguage;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        <span {...(lang ? contentLanguageProps(lang) : {})}>{label}</span>
        {required ? (
          <span aria-hidden="true" className="text-danger">
            {' *'}
          </span>
        ) : null}
        {note ? <span className="font-normal text-ink-muted"> {note}</span> : null}
      </label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        aria-required={required || undefined}
        className={cn(mono && 'font-mono')}
        {...(lang ? contentLanguageProps(lang) : {})}
      />
    </div>
  );
}

/** The red star the New Ticket form puts after a required field's label (hidden from AT). */
function RequiredMark({ required }: { required: boolean }) {
  return required ? (
    <span aria-hidden="true" className="text-danger">
      {' *'}
    </span>
  ) : null;
}

function PreviewCustomField({
  id,
  field,
  language,
}: {
  id: string;
  field: PreviewField;
  language: ContentLanguage;
}) {
  const t = useTranslations('admin-setup.categories.preview');
  const tForm = useTranslations('tickets.newTicket');
  const tTickets = useTranslations('tickets');
  const label = localizedLabel(field, language) || t('untitled');
  const placeholder = fieldPlaceholder(field, language);
  const note = field.required ? undefined : tForm('optional');
  const content = contentLanguageProps(language);

  switch (field.type) {
    case 'DROPDOWN':
      return (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={`${id}-label`} className="text-sm font-medium text-ink">
            <span {...content}>{label}</span>
            {field.required ? (
              <span aria-hidden="true" className="text-danger">
                {' *'}
              </span>
            ) : null}
            {note ? <span className="font-normal text-ink-muted"> {note}</span> : null}
          </span>
          <Select disabled>
            <SelectTrigger aria-labelledby={`${id}-label`} className="w-full" {...content}>
              <SelectValue placeholder={placeholder ?? tForm('fieldPlaceholder')} />
            </SelectTrigger>
          </Select>
          {field.options.length ? (
            <p className="text-xs text-ink-muted" {...content}>
              {field.options.map((o) => localizedLabel(o, language)).join(' · ')}
            </p>
          ) : null}
        </div>
      );
    case 'MULTI_SELECT':
      return (
        <div role="group" aria-labelledby={`${id}-label`} className="flex min-w-0 flex-col gap-1.5">
          <span id={`${id}-label`} className="text-sm font-medium text-ink">
            <span {...content}>{label}</span>
            <RequiredMark required={field.required} />
            {note ? <span className="font-normal text-ink-muted"> {note}</span> : null}
          </span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {field.options.map((option, index) => (
              <label
                key={option.value}
                htmlFor={`${id}-${index}`}
                className="flex items-center gap-2 text-sm text-ink-secondary"
              >
                <Checkbox id={`${id}-${index}`} disabled />
                <span {...content}>{localizedLabel(option, language)}</span>
              </label>
            ))}
          </div>
        </div>
      );
    case 'YES_NO':
      return (
        <div role="group" aria-labelledby={`${id}-label`} className="flex min-w-0 flex-col gap-1.5">
          <span id={`${id}-label`} className="text-sm font-medium text-ink">
            <span {...content}>{label}</span>
            <RequiredMark required={field.required} />
            {note ? <span className="font-normal text-ink-muted"> {note}</span> : null}
          </span>
          <div className="flex gap-2">
            {[tTickets('yes'), tTickets('no')].map((text) => (
              <span
                key={text}
                className="rounded-md border border-line px-3 py-1 text-sm text-ink-secondary"
              >
                {text}
              </span>
            ))}
          </div>
        </div>
      );
    default:
      return (
        <PreviewInput
          id={id}
          label={label}
          note={note}
          required={field.required}
          placeholder={placeholder}
          mono={field.type === 'ASSET_ID'}
          type={field.type === 'DATE' ? 'date' : 'text'}
          lang={language}
        />
      );
  }
}
