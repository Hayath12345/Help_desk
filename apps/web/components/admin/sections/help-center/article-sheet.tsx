'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  adminKeySchema,
  helpArticleListSchema,
  helpArticleResponseSchema,
  labelArSchema,
  labelEnSchema,
  longTextOptionalSchema,
  longTextSchema,
  type HelpArticleAdminDto,
} from '@loons/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { z } from 'zod';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  adminConflictDetails,
  adminGet,
  adminPath,
  adminWrite,
  applyServerIssues,
  useAdminMutation,
} from '@/lib/admin';
import { isApiRequestError } from '@/lib/api/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';
import {
  AdminSheet,
  KeyField,
  LanguageSwitch,
  LanguageTag,
  contentLanguageProps,
  type ContentLanguage,
} from '../../kit';
import { useCommsValidationMessage } from '../email-templates/use-comms-messages';
import { ArticlePreview } from './article-preview';

export interface ArticleFormValues {
  key: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  isPublished: boolean;
}
type ArticleField = keyof ArticleFormValues;
type TextField = 'titleEn' | 'titleAr' | 'bodyEn' | 'bodyAr';
const TEXT_FIELDS: readonly TextField[] = ['titleEn', 'bodyEn', 'titleAr', 'bodyAr'];
const FIELDS: readonly ArticleField[] = ['key', ...TEXT_FIELDS, 'isPublished'];

const languageOf = (field: ArticleField): ContentLanguage | null =>
  field.endsWith('Ar') ? 'ar' : field.endsWith('En') ? 'en' : null;

/** The shared contract's rules; the key may be empty (the API then makes one from the title). */
const articleFormSchema = z.object({
  key: z.union([z.literal(''), adminKeySchema]),
  titleEn: labelEnSchema,
  titleAr: labelArSchema,
  bodyEn: longTextSchema,
  bodyAr: longTextOptionalSchema,
  isPublished: z.boolean(),
});

function valuesOf(article: HelpArticleAdminDto | null): ArticleFormValues {
  return {
    key: article?.key ?? '',
    titleEn: article?.titleEn ?? '',
    titleAr: article?.titleAr ?? '',
    bodyEn: article?.bodyEn ?? '',
    bodyAr: article?.bodyAr ?? '',
    isPublished: article?.isPublished ?? false,
  };
}

export interface ArticleSheetProps {
  /** null: a new article. */
  article: HelpArticleAdminDto | null;
  /** Keys of every article, archived ones included (the key suggestion avoids them, E4). */
  takenKeys: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create / edit a help-center article (E15) in the wide sheet: the key (from the English title
 * while creating, then locked), title and text per language behind the English | العربية switch
 * with language tags, the Published switch, and a live preview as clients read it. Edits send the
 * `updatedAt` they started from (E19). Mount it once per opening (`key`).
 */
export function ArticleSheet({ article, takenKeys, open, onOpenChange }: ArticleSheetProps) {
  const t = useTranslations('admin-comms.helpCenter');
  const tKit = useTranslations('admin.kit');
  const message = useCommsValidationMessage();
  const errorText = useApiErrorText();
  const formId = useId();
  const [base, setBase] = useState(article);
  const [language, setLanguage] = useState<ContentLanguage>('en');
  const [formError, setFormError] = useState<string | null>(null);
  const pendingFocus = useRef<TextField | null>(null);
  const mode = base ? 'edit' : 'create';

  const form = useForm<ArticleFormValues>({
    defaultValues: valuesOf(base),
    resolver: zodResolver(articleFormSchema),
  });
  const values = useWatch({ control: form.control }) as ArticleFormValues;
  const label = (base?.titleEn ?? values.titleEn) || t('createTitle');

  useEffect(() => {
    const field = pendingFocus.current;
    if (!field || languageOf(field) !== language) return;
    pendingFocus.current = null;
    form.setFocus(field);
  }, [language, form]);

  const startFrom = (item: HelpArticleAdminDto) => {
    setBase(item);
    form.reset(valuesOf(item));
    setFormError(null);
  };

  const showFieldOf = (field: ArticleField) => {
    const lang = languageOf(field);
    if (lang && lang !== language) {
      pendingFocus.current = field as TextField;
      setLanguage(lang);
    }
  };

  const onServerError = (error: unknown) => {
    const conflict = adminConflictDetails(error);
    if (conflict?.reason === 'duplicate' && conflict.fields?.includes('key')) {
      form.setError(
        'key',
        {
          type: 'server',
          message:
            conflict.existingIsActive === false
              ? 'validation.duplicateKeyArchived'
              : 'validation.duplicateKey',
        },
        { shouldFocus: true },
      );
      return;
    }
    const mapped = applyServerIssues(error, form.setError, { paths: FIELDS });
    if (mapped > 0) {
      const first = FIELDS.find((field) => form.getFieldState(field).error);
      if (first) showFieldOf(first);
    } else if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
      setFormError(errorText(error));
    }
  };

  const create = useAdminMutation({
    section: 'help-center',
    mutationFn: (input: ArticleFormValues) =>
      adminWrite(
        'POST',
        adminPath('help-center'),
        { ...input, key: input.key || undefined },
        helpArticleResponseSchema,
      ),
    scopes: ['help-center'],
    success: ({ item }) => tKit('toast.created', { label: item.titleEn }),
    errorToast: (error) =>
      !(isApiRequestError(error) && ['VALIDATION_FAILED', 'CONFLICT'].includes(error.code)),
    onSuccess: ({ item }) => {
      startFrom(item);
      onOpenChange(false);
    },
    onError: onServerError,
  });

  const update = useAdminMutation({
    section: 'help-center',
    mutationFn: (changes: Partial<ArticleFormValues>) =>
      adminWrite(
        'PATCH',
        adminPath('help-center', base?.id ?? ''),
        { ...changes, expectedUpdatedAt: base?.updatedAt },
        helpArticleResponseSchema,
      ),
    scopes: ['help-center'],
    success: ({ item }, changes) =>
      changes.isPublished === undefined
        ? tKit('toast.saved')
        : t(changes.isPublished ? 'toast.published' : 'toast.unpublished', {
            label: item.titleEn,
          }),
    onSuccess: ({ item }) => {
      startFrom(item);
      onOpenChange(false);
    },
    onError: onServerError,
  });

  const setActive = useAdminMutation({
    section: 'help-center',
    mutationFn: (isActive: boolean) =>
      adminWrite(
        'POST',
        adminPath('help-center', base?.id ?? '', isActive ? 'restore' : 'archive'),
        { expectedUpdatedAt: base?.updatedAt },
        helpArticleResponseSchema,
      ),
    scopes: ['help-center'],
    success: ({ item }) =>
      tKit(item.isActive ? 'toast.restored' : 'toast.archived', { label: item.titleEn }),
    onSuccess: ({ item }) => {
      startFrom(item);
      if (!item.isActive) onOpenChange(false);
    },
  });

  const reload = async () => {
    if (!base) return;
    const { items } = await adminGet(adminPath('help-center'), helpArticleListSchema, {
      params: { status: 'all' },
    });
    const item = items.find((a) => a.id === base.id);
    update.reset();
    setActive.reset();
    if (item) startFrom(item);
    else onOpenChange(false);
  };

  const submit = (input: ArticleFormValues) => {
    setFormError(null);
    if (!base) {
      create.mutate(input);
      return;
    }
    const changes: Partial<ArticleFormValues> = {};
    for (const field of [...TEXT_FIELDS, 'isPublished'] as const) {
      if (input[field] !== base[field]) Object.assign(changes, { [field]: input[field] });
    }
    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }
    update.mutate(changes);
  };

  const onInvalid = (errors: FieldErrors<ArticleFormValues>) => {
    const invalid = FIELDS.filter((field) => errors[field]);
    if (invalid.some((field) => languageOf(field) === language || languageOf(field) === null)) {
      return;
    }
    if (invalid[0]) showFieldOf(invalid[0]);
  };

  const textField = (field: TextField) => {
    const lang = languageOf(field) as ContentLanguage;
    const multiline = field.startsWith('body');
    const id = `article-${field}`;
    const error = message(form.formState.errors[field]?.message);
    const hint =
      lang === 'ar'
        ? multiline
          ? `${t('fields.bodyHint')} ${t('arabicEmptyHint')}`
          : t('arabicEmptyHint')
        : multiline
          ? t('fields.bodyHint')
          : undefined;
    const common = {
      ...fieldA11y(id, { error, hint: hint !== undefined }),
      ...contentLanguageProps(lang),
      ...form.register(field),
      'aria-required': lang === 'en' ? true : undefined,
    };
    return (
      <FormField
        id={id}
        required={lang === 'en'}
        label={
          <span className="inline-flex items-center gap-2">
            {multiline ? t('fields.body') : t('fields.title')}
            <LanguageTag language={lang} />
          </span>
        }
        hint={hint}
        error={error}
      >
        {multiline ? (
          <Textarea {...common} rows={10} className="resize-y" />
        ) : (
          <Input {...common} autoComplete="off" />
        )}
      </FormField>
    );
  };

  const busy = create.isPending || update.isPending;
  const archived = base ? !base.isActive : false;

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      title={base ? base.titleEn : t('createTitle')}
      description={base ? t('editDescription') : t('createDescription')}
      mode={mode}
      size="wide"
      dirty={form.formState.isDirty}
      archived={archived}
      formId={formId}
      saving={busy}
      onArchive={base ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={base ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={label}
      conflict={update.isConflict || setActive.isConflict}
      onReload={() => void reload()}
      error={formError}
      aside={
        <ArticlePreview
          language={language}
          titleEn={values.titleEn}
          titleAr={values.titleAr}
          bodyEn={values.bodyEn}
          bodyAr={values.bodyAr}
          isPublished={values.isPublished}
        />
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-[18px]"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          void form.handleSubmit(submit, onInvalid)(event);
        }}
      >
        <Controller
          control={form.control}
          name="key"
          render={({ field, fieldState }) => (
            <KeyField
              id="article-key"
              mode={mode}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              source={values.titleEn}
              takenKeys={takenKeys}
              error={message(fieldState.error?.message)}
            />
          )}
        />
        <LanguageSwitch value={language} onValueChange={setLanguage} />
        <div key={language} className="flex flex-col gap-[18px]">
          {textField(language === 'en' ? 'titleEn' : 'titleAr')}
          {textField(language === 'en' ? 'bodyEn' : 'bodyAr')}
        </div>
        <Controller
          control={form.control}
          name="isPublished"
          render={({ field }) => (
            <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-3.5 py-3">
              <div className="flex flex-col gap-0.5">
                <label htmlFor="article-published" className="font-medium text-ink">
                  {t('fields.published')}
                </label>
                <p id="article-published-hint" className="text-[13px] text-ink-muted">
                  {t('fields.publishedHint')}
                </p>
              </div>
              <Switch
                id="article-published"
                ref={field.ref}
                checked={field.value}
                onCheckedChange={field.onChange}
                onBlur={field.onBlur}
                aria-describedby="article-published-hint"
              />
            </div>
          )}
        />
      </form>
    </AdminSheet>
  );
}
