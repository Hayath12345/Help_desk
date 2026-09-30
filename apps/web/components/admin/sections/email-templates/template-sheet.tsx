'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  EMAIL_TEMPLATE_LIMITS,
  cleanText,
  emailTemplateResponseSchema,
  type EmailTemplateAdminDto,
} from '@loons/shared';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { z } from 'zod';
import { Kicker } from '@/components/common/kicker';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { adminGet, adminPath, adminWrite, applyServerIssues, useAdminMutation } from '@/lib/admin';
import { isApiRequestError } from '@/lib/api/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';
import {
  AdminSheet,
  ConfirmDialog,
  LanguageSwitch,
  LanguageTag,
  contentLanguageProps,
  type ContentLanguage,
} from '../../kit';
import { insertAt, placeholderError, type PlaceholderRules } from './placeholders';
import { TemplatePreview } from './template-preview';
import { useCommsValidationMessage } from './use-comms-messages';

export interface TemplateFormValues {
  subjectEn: string;
  bodyEn: string;
  subjectAr: string;
  bodyAr: string;
}
type TextField = keyof TemplateFormValues;
const FIELDS: readonly TextField[] = ['subjectEn', 'bodyEn', 'subjectAr', 'bodyAr'];
const FIELDS_OF: Record<ContentLanguage, { subject: TextField; body: TextField }> = {
  en: { subject: 'subjectEn', body: 'bodyEn' },
  ar: { subject: 'subjectAr', body: 'bodyAr' },
};

const languageOf = (field: TextField): ContentLanguage => (field.endsWith('Ar') ? 'ar' : 'en');

function textOf(template: EmailTemplateAdminDto): TemplateFormValues {
  return {
    subjectEn: template.subjectEn,
    bodyEn: template.bodyEn,
    subjectAr: template.subjectAr,
    bodyAr: template.bodyAr,
  };
}

/** The shared contract's rules (EN required, AR optional, lengths) plus the placeholder rules. */
function templateFormSchema(rules: PlaceholderRules) {
  const text = (max: number, required: boolean) =>
    cleanText()
      .min(required ? 1 : 0, { error: 'validation.required' })
      .max(max, { error: 'validation.tooLong' });
  return z
    .object({
      subjectEn: text(EMAIL_TEMPLATE_LIMITS.subjectMax, true),
      bodyEn: text(EMAIL_TEMPLATE_LIMITS.bodyMax, true),
      subjectAr: text(EMAIL_TEMPLATE_LIMITS.subjectMax, false),
      bodyAr: text(EMAIL_TEMPLATE_LIMITS.bodyMax, false),
    })
    .superRefine((values, ctx) => {
      for (const field of FIELDS) {
        const message = placeholderError(
          values[field],
          field.startsWith('subject') ? 'subject' : 'body',
          rules,
        );
        if (message) ctx.addIssue({ code: 'custom', path: [field], message });
      }
    });
}

export interface TemplateSheetProps {
  /** The template as last listed (the edit starts from it when the sheet mounts). */
  template: EmailTemplateAdminDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preview debounce (tests shorten it). */
  previewDebounceMs?: number;
}

/**
 * Editor of one email template (E14) in the wide admin sheet: English | العربية switch with a
 * language tag on each field, the template's variables (insert at the cursor; block variables in
 * the body only), live preview beside the form, Save (with the `updatedAt` the edit started from,
 * E19) and Reset to default. Mount it once per opening (`key`), so each edit starts fresh.
 */
export function TemplateSheet({
  template,
  open,
  onOpenChange,
  previewDebounceMs,
}: TemplateSheetProps) {
  const t = useTranslations('admin-comms.emailTemplates');
  const tKit = useTranslations('admin.kit');
  const message = useCommsValidationMessage();
  const errorText = useApiErrorText();
  // The version this edit started from (E19): only a save, a reset or a reload moves it.
  const [base, setBase] = useState(template);
  const [language, setLanguage] = useState<ContentLanguage>('en');
  const [confirmReset, setConfirmReset] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const elements = useRef<Partial<Record<TextField, HTMLInputElement | HTMLTextAreaElement>>>({});
  const lastFocused = useRef<TextField | null>(null);
  const pendingFocus = useRef<TextField | null>(null);

  const rules = useMemo(
    () => ({
      variables: base.variables,
      blockVariables: base.blockVariables,
      legacyVariables: base.legacyVariables,
    }),
    [base.variables, base.blockVariables, base.legacyVariables],
  );
  const resolver = useMemo(() => zodResolver(templateFormSchema(rules)), [rules]);
  const form = useForm<TemplateFormValues>({ defaultValues: textOf(base), resolver });
  const values = useWatch({ control: form.control }) as TemplateFormValues;
  const titleKey = `keys.${base.key}.title` as 'keys.PASSWORD_RESET.title';
  const name = t.has(titleKey) ? t(titleKey) : base.key;
  const descriptionKey = `keys.${base.key}.description` as 'keys.PASSWORD_RESET.description';

  // After switching language to show an error, focus that field once it is rendered.
  useEffect(() => {
    const field = pendingFocus.current;
    if (!field || languageOf(field) !== language) return;
    pendingFocus.current = null;
    elements.current[field]?.focus();
  }, [language]);

  const startFrom = (item: EmailTemplateAdminDto) => {
    setBase(item);
    form.reset(textOf(item));
    setFormError(null);
  };

  const onServerError = (error: unknown) => {
    const mapped = applyServerIssues(error, form.setError, { paths: FIELDS });
    if (mapped > 0) {
      const first = FIELDS.find((field) => form.getFieldState(field).error);
      if (first && languageOf(first) !== language) {
        pendingFocus.current = first;
        setLanguage(languageOf(first));
      }
      setFormError(null);
    } else if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
      setFormError(errorText(error));
    }
  };

  const save = useAdminMutation({
    section: 'email-templates',
    mutationFn: (input: TemplateFormValues) =>
      adminWrite(
        'PUT',
        adminPath('email-templates', base.key),
        { ...input, expectedUpdatedAt: base.updatedAt },
        emailTemplateResponseSchema,
      ),
    scopes: ['email-templates'],
    success: () => t('toast.saved', { name }),
    onSuccess: ({ item }) => {
      startFrom(item);
      onOpenChange(false);
    },
    onError: onServerError,
  });

  const reset = useAdminMutation({
    section: 'email-templates',
    mutationFn: () =>
      adminWrite(
        'POST',
        adminPath('email-templates', base.key, 'reset'),
        { expectedUpdatedAt: base.updatedAt },
        emailTemplateResponseSchema,
      ),
    scopes: ['email-templates'],
    success: () => t('toast.reset', { name }),
    onSuccess: ({ item }) => startFrom(item),
  });

  const reload = async () => {
    const { item } = await adminGet(
      adminPath('email-templates', base.key),
      emailTemplateResponseSchema,
    );
    save.reset();
    reset.reset();
    startFrom(item);
  };

  const onInvalid = (errors: FieldErrors<TemplateFormValues>) => {
    const invalid = FIELDS.filter((field) => errors[field]);
    if (invalid.length === 0 || invalid.some((field) => languageOf(field) === language)) return;
    const first = invalid[0]!;
    pendingFocus.current = first;
    setLanguage(languageOf(first));
  };

  const insertVariable = (variable: string, block: boolean) => {
    const fields = FIELDS_OF[language];
    const focused = lastFocused.current;
    const target: TextField =
      !block && focused && languageOf(focused) === language ? focused : fields.body;
    const element = elements.current[target];
    const current = form.getValues(target);
    const selection =
      element && lastFocused.current === target
        ? {
            start: element.selectionStart ?? current.length,
            end: element.selectionEnd ?? element.selectionStart ?? current.length,
          }
        : null;
    const next = insertAt(current, `{{${variable}}}`, selection);
    form.setValue(target, next.value, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
    lastFocused.current = target;
    requestAnimationFrame(() => {
      const el = elements.current[target];
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const field = (fieldName: TextField, multiline: boolean) => {
    const lang = languageOf(fieldName);
    const id = `template-${fieldName}`;
    const registration = form.register(fieldName);
    const error = message(form.formState.errors[fieldName]?.message);
    const hint =
      lang === 'ar'
        ? multiline
          ? `${t('bodyHint')} ${t('arabicEmptyHint')}`
          : t('arabicEmptyHint')
        : multiline
          ? t('bodyHint')
          : undefined;
    const common = {
      ...fieldA11y(id, { error, hint: hint !== undefined }),
      ...contentLanguageProps(lang),
      ...registration,
      ref: (element: HTMLInputElement | HTMLTextAreaElement | null) => {
        registration.ref(element);
        if (element) elements.current[fieldName] = element;
        else delete elements.current[fieldName];
      },
      onFocus: () => {
        lastFocused.current = fieldName;
      },
      'aria-required': lang === 'en' ? true : undefined,
    };
    return (
      <FormField
        id={id}
        required={lang === 'en'}
        label={
          <span className="inline-flex items-center gap-2">
            {multiline ? t('body') : t('subject')}
            <LanguageTag language={lang} />
          </span>
        }
        hint={hint}
        error={error}
      >
        {multiline ? (
          <Textarea {...common} rows={12} className="resize-y font-sans" />
        ) : (
          <Input {...common} autoComplete="off" />
        )}
      </FormField>
    );
  };

  const arabicUsable = values.subjectAr.trim() !== '' && values.bodyAr.trim() !== '';
  const listAudience = base.audience === 'list';
  const previewLanguage: ContentLanguage =
    language === 'ar' && arabicUsable && !listAudience ? 'ar' : 'en';
  const previewNote =
    language === 'ar' && previewLanguage === 'en'
      ? listAudience
        ? t('listAudienceNote')
        : t('preview.englishFallback')
      : undefined;
  const fields = FIELDS_OF[language];

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      title={name}
      description={t('sheetDescription', {
        description: t.has(descriptionKey) ? t(descriptionKey) : '',
      })}
      mode="edit"
      size="wide"
      dirty={form.formState.isDirty}
      formId="email-template-form"
      saving={save.isPending}
      conflict={save.isConflict || reset.isConflict}
      onReload={() => void reload()}
      error={formError}
      aside={
        <TemplatePreview
          templateKey={base.key}
          language={previewLanguage}
          subject={values[FIELDS_OF[previewLanguage].subject]}
          body={values[FIELDS_OF[previewLanguage].body]}
          note={previewNote}
          debounceMs={previewDebounceMs}
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LanguageSwitch value={language} onValueChange={setLanguage} />
        {base.isCustomized ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={reset.isPending || undefined}
            onClick={() => {
              if (!reset.isPending) setConfirmReset(true);
            }}
          >
            <RotateCcw aria-hidden="true" />
            {reset.isPending ? t('resetting') : t('reset')}
          </Button>
        ) : null}
      </div>
      <form
        id="email-template-form"
        noValidate
        className="flex flex-col gap-[18px]"
        onSubmit={(event) => {
          event.preventDefault();
          if (save.isPending) return;
          setFormError(null);
          void form.handleSubmit((input) => save.mutate(input), onInvalid)(event);
        }}
      >
        <div key={language} className="flex flex-col gap-[18px]">
          {field(fields.subject, false)}
          {field(fields.body, true)}
        </div>
        <section aria-labelledby="template-variables-title" className="flex flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <Kicker as="h3" id="template-variables-title">
              {t('variables.title')}
            </Kicker>
            <p className="text-[13px] text-ink-muted">{t('variables.hint')}</p>
          </div>
          <ul aria-label={t('variables.listLabel')} className="flex flex-wrap gap-2">
            {base.variables.map((variable) => {
              const block = base.blockVariables.includes(variable);
              return (
                <li key={variable}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('variables.insert', { variable: `{{${variable}}}` })}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertVariable(variable, block)}
                    className="h-auto gap-1.5 py-1 font-mono text-xs"
                  >
                    <span dir="ltr">{`{{${variable}}}`}</span>
                    {block ? (
                      <Badge variant="secondary" className="font-sans">
                        {t('variables.bodyOnly')}
                      </Badge>
                    ) : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      </form>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('resetConfirmTitle', { name })}
        description={
          form.formState.isDirty
            ? `${t('resetConfirmBody')} ${t('resetUnsavedBody')}`
            : t('resetConfirmBody')
        }
        confirmLabel={t('reset')}
        cancelLabel={tKit('cancel')}
        destructive
        busy={reset.isPending}
        onConfirm={() => {
          setConfirmReset(false);
          reset.mutate(undefined);
        }}
      />
    </AdminSheet>
  );
}
