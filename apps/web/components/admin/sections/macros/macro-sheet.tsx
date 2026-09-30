'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADMIN_KEY_PATTERN,
  ADMIN_LIMITS,
  MACRO_BODY_MAX,
  MACRO_VARIABLES,
  STAFF_SETTABLE_STATUSES,
  unknownMacroVariables,
  type Locale,
  type MacroAdminDto,
  type Role,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  AdminSheet,
  KeyField,
  LanguageSwitch,
  LanguageTag,
  RhfBilingualField,
  contentLanguageProps,
  type ContentLanguage,
} from '@/components/admin/kit';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminMutation } from '@/lib/admin';
import { localizedLabel, teamName } from '@/lib/tickets/labels';
import { useSetupMessage, useWriteErrorHandler } from '../categories/setup-shared';
import { macrosApi, type ScopeTeam } from './data';

// The macro sheet (spec §10.8; E2, E4, E7): title EN/AR, key, scope (global or a team), the status
// it sets, and the reply body with an English | العربية switch and the composer variables.
// Team leads pick among the teams they lead and can't move a macro elsewhere (the API refuses it).

export const GLOBAL = 'global';
const NO_STATUS = 'none';

const bodySchema = (required: boolean) =>
  z
    .string()
    .max(MACRO_BODY_MAX, { error: 'validation.tooLong' })
    .refine((v) => !required || v.trim() !== '', { error: 'validation.required' })
    .refine((v) => unknownMacroVariables(v).length === 0, { error: 'validation.unknownVariable' });

const formSchema = z.object({
  titleEn: z
    .string()
    .max(ADMIN_LIMITS.labelMax, { error: 'validation.tooLong' })
    .refine((v) => v.trim() !== '', { error: 'validation.required' }),
  titleAr: z.string().max(ADMIN_LIMITS.labelMax, { error: 'validation.tooLong' }),
  key: z.string().refine((v) => v === '' || ADMIN_KEY_PATTERN.test(v), {
    error: 'validation.keyFormat',
  }),
  scope: z.string().min(1, { error: 'validation.required' }),
  setStatus: z.string(),
  bodyEn: bodySchema(true),
  bodyAr: bodySchema(false),
});

export type MacroFormValues = z.infer<typeof formSchema>;

const FORM_PATHS = ['titleEn', 'titleAr', 'key', 'teamId', 'setStatus', 'bodyEn', 'bodyAr'];

function valuesOf(macro: MacroAdminDto | undefined, defaultScope: string): MacroFormValues {
  return {
    titleEn: macro?.titleEn ?? '',
    titleAr: macro?.titleAr ?? '',
    key: macro?.key ?? '',
    scope: macro ? (macro.teamId ?? GLOBAL) : defaultScope,
    setStatus: macro?.setStatus ?? NO_STATUS,
    bodyEn: macro?.bodyEn ?? '',
    bodyAr: macro?.bodyAr ?? '',
  };
}

const teamIdOf = (scope: string) => (scope === GLOBAL ? null : scope);
const statusOf = (value: string) => (value === NO_STATUS ? null : value);

/** The PATCH body for what changed since `base` (null when nothing did). */
export function macroPatch(
  base: MacroAdminDto,
  values: MacroFormValues,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (values.titleEn !== base.titleEn) patch.titleEn = values.titleEn;
  if (values.titleAr !== base.titleAr) patch.titleAr = values.titleAr;
  if (teamIdOf(values.scope) !== base.teamId) patch.teamId = teamIdOf(values.scope);
  if (statusOf(values.setStatus) !== base.setStatus) patch.setStatus = statusOf(values.setStatus);
  if (values.bodyEn !== base.bodyEn) patch.bodyEn = values.bodyEn;
  if (values.bodyAr !== base.bodyAr) patch.bodyAr = values.bodyAr;
  return Object.keys(patch).length ? patch : null;
}

export interface MacroSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  macro?: MacroAdminDto;
  role: Role;
  /** Teams the viewer manages macros for. */
  teams: readonly ScopeTeam[];
  /** Scope preselected for a new macro (the table's filter). */
  defaultScope: string;
  takenKeys: readonly string[];
  reload: () => Promise<MacroAdminDto | undefined>;
}

export function MacroSheet({
  open,
  onOpenChange,
  macro,
  role,
  teams,
  defaultScope,
  takenKeys,
  reload,
}: MacroSheetProps) {
  const t = useTranslations('admin-setup.macros');
  const tKit = useTranslations('admin.kit');
  const tStatus = useTranslations('common.status');
  const locale = useLocale() as Locale;
  const message = useSetupMessage();
  const writeError = useWriteErrorHandler();
  const formId = useId();
  const mode = macro ? 'edit' : 'create';
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const [base, setBase] = useState<MacroAdminDto | undefined>(macro);
  const [formError, setFormError] = useState<string | null>(null);
  const [language, setLanguage] = useState<ContentLanguage>('en');
  // The key still follows the title: `takenKeys` holds only the macros this viewer lists (a team
  // lead never sees global or other teams' macros), so the API generates it instead (E4 suffix).
  const [keyFollowing, setKeyFollowing] = useState(true);
  const bodyRefs = useRef<Record<ContentLanguage, HTMLTextAreaElement | null>>({
    en: null,
    ar: null,
  });

  const form = useForm<MacroFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(macro, defaultScope),
  });
  const titleEn = useWatch({ control: form.control, name: 'titleEn' });
  const errorText = (m?: string) => message(m);

  const save = useAdminMutation<MacroFormValues, MacroAdminDto | null>({
    section: 'macros',
    scopes: ['macros'],
    errorToast: false,
    mutationFn: async (values) => {
      if (!base) {
        return macrosApi.create({
          ...(keyFollowing || !values.key ? {} : { key: values.key }),
          teamId: teamIdOf(values.scope),
          titleEn: values.titleEn,
          titleAr: values.titleAr,
          bodyEn: values.bodyEn,
          bodyAr: values.bodyAr,
          setStatus: statusOf(values.setStatus),
        });
      }
      const patch = macroPatch(base, values);
      if (!patch) return null;
      const row = await macrosApi.update(base.id, { ...patch, expectedUpdatedAt: base.updatedAt });
      setBase(row);
      return row;
    },
    success: (row, values) =>
      base
        ? tKit('toast.saved')
        : row && values.key && row.key !== values.key
          ? // The key box showed a suggestion; the API added a suffix (a macro this viewer can't
            // see holds it): say which key the macro got.
            tKit('toast.createdWithKey', { label: row.titleEn, key: row.key })
          : tKit('toast.created', { label: row?.titleEn ?? values.titleEn }),
    onSuccess: () => onOpenChange(false),
    onError: (error) => {
      // `teamId` issues belong to the scope picker.
      setFormError(
        writeError(
          error,
          (name, err, options) =>
            form.setError(
              (name as string) === 'teamId' ? 'scope' : (name as keyof MacroFormValues),
              err,
              options,
            ),
          FORM_PATHS,
        ),
      );
    },
  });

  const setActive = useAdminMutation<boolean, MacroAdminDto>({
    section: 'macros',
    scopes: ['macros'],
    errorToast: false,
    mutationFn: (active) => macrosApi.setActive(base!.id, active, base!.updatedAt),
    success: (row, active) =>
      tKit(active ? 'toast.restored' : 'toast.archived', { label: row.titleEn }),
    onSuccess: (row) => {
      setBase(row);
      if (!row.isActive) onOpenChange(false);
    },
    onError: (error) => setFormError(writeError(error, form.setError, FORM_PATHS)),
  });

  const onReload = async () => {
    const fresh = await reload();
    if (fresh) {
      setBase(fresh);
      form.reset(valuesOf(fresh, defaultScope));
    }
    save.reset();
    setActive.reset();
    setFormError(null);
  };

  const submit = form.handleSubmit(
    (values) => {
      setFormError(null);
      save.mutate(values);
    },
    (errors) => {
      // Show the body that needs attention.
      if (errors.bodyEn) setLanguage('en');
      else if (errors.bodyAr) setLanguage('ar');
    },
  );

  // Scopes offered: global (super admins) and the viewer's teams; on edit, a team lead's macro
  // stays where it is (moving is super-admin only).
  const scopeOptions = [
    ...(isSuperAdmin ? [{ value: GLOBAL, label: t('global') }] : []),
    ...teams.map((team) => ({ value: team.id, label: teamName(team, locale) })),
  ];
  if (macro?.team && !scopeOptions.some((o) => o.value === macro.team?.id)) {
    scopeOptions.push({ value: macro.team.id, label: teamName(macro.team, locale) });
  }
  const scopeLocked = mode === 'edit' && !isSuperAdmin;

  const insertVariable = (name: string) => {
    const field = language === 'en' ? 'bodyEn' : 'bodyAr';
    const textarea = bodyRefs.current[language];
    const current = form.getValues(field);
    const token = `{{${name}}}`;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    form.setValue(field, `${current.slice(0, start)}${token}${current.slice(end)}`, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      title={
        mode === 'create'
          ? t('createTitle')
          : localizedLabel({ labelEn: macro!.titleEn, labelAr: macro!.titleAr }, locale)
      }
      description={mode === 'create' ? t('createDescription') : undefined}
      dirty={form.formState.isDirty}
      archived={base ? !base.isActive : false}
      formId={formId}
      saving={save.isPending}
      onArchive={base ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={base ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={base?.titleEn}
      archiveWarning={t('archiveWarning')}
      conflict={save.isConflict || setActive.isConflict}
      onReload={onReload}
      error={formError}
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-[18px]">
        <RhfBilingualField
          id={`${formId}-title`}
          label={t('titleLabel')}
          required
          maxLength={ADMIN_LIMITS.labelMax}
          control={form.control}
          nameEn="titleEn"
          nameAr="titleAr"
          errorText={errorText}
        />
        <Controller
          control={form.control}
          name="key"
          render={({ field, fieldState }) => (
            <KeyField
              id={`${formId}-key`}
              mode={mode}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              source={titleEn}
              takenKeys={takenKeys}
              onFollowingChange={setKeyFollowing}
              error={errorText(fieldState.error?.message)}
            />
          )}
        />
        <div className="grid gap-[18px] sm:grid-cols-2">
          <Controller
            control={form.control}
            name="scope"
            render={({ field, fieldState }) => {
              const id = `${formId}-scope`;
              const error = errorText(fieldState.error?.message);
              return (
                <FormField
                  id={id}
                  label={t('scope')}
                  required
                  hint={scopeLocked ? t('scopeLocked') : t('scopeHint')}
                  error={error}
                >
                  <Select value={field.value} onValueChange={field.onChange} disabled={scopeLocked}>
                    <SelectTrigger
                      {...fieldA11y(id, { error, hint: true })}
                      ref={field.ref}
                      className="w-full"
                    >
                      <SelectValue placeholder={t('scopePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {scopeOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              );
            }}
          />
          <Controller
            control={form.control}
            name="setStatus"
            render={({ field }) => {
              const id = `${formId}-status`;
              return (
                <FormField id={id} label={t('setStatus')} hint={t('setStatusHint')}>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger
                      {...fieldA11y(id, { hint: true })}
                      ref={field.ref}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value={NO_STATUS}>{t('noStatus')}</SelectItem>
                      {STAFF_SETTABLE_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {tStatus(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              );
            }}
          />
        </div>

        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink">{t('body')}</span>
            <LanguageSwitch value={language} onValueChange={setLanguage} />
          </div>
          {(['en', 'ar'] as const).map((lang) => (
            <Controller
              key={lang}
              control={form.control}
              name={lang === 'en' ? 'bodyEn' : 'bodyAr'}
              render={({ field, fieldState }) => {
                const id = `${formId}-body-${lang}`;
                const error = errorText(fieldState.error?.message);
                return (
                  <div hidden={language !== lang} className="flex flex-col gap-1.5">
                    <label
                      htmlFor={id}
                      className="flex items-center gap-2 text-sm text-ink-secondary"
                    >
                      {lang === 'en' ? t('bodyEn') : t('bodyAr')} <LanguageTag language={lang} />
                      {lang === 'en' ? (
                        <span aria-hidden="true" className="text-danger">
                          *
                        </span>
                      ) : null}
                    </label>
                    <Textarea
                      {...fieldA11y(id, { error, hint: true })}
                      {...contentLanguageProps(lang)}
                      ref={(el) => {
                        field.ref(el);
                        bodyRefs.current[lang] = el;
                      }}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      rows={7}
                      maxLength={MACRO_BODY_MAX}
                      aria-required={lang === 'en' || undefined}
                      className="resize-y"
                    />
                    <p id={`${id}-hint`} className="text-[13px] text-ink-secondary">
                      {lang === 'ar' ? t('bodyArHint') : t('bodyHint')}
                    </p>
                    {error ? (
                      <p id={`${id}-error`} className="text-[13px] font-medium text-danger">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            />
          ))}
          <div
            role="group"
            aria-label={t('variables')}
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-[13px] text-ink-secondary">{t('variables')}</span>
            {MACRO_VARIABLES.map((name) => (
              <Button
                key={name}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => insertVariable(name)}
                title={t(`variable.${name}`)}
                aria-label={t('insertVariable', { name: t(`variable.${name}`) })}
                className="font-mono text-xs"
              >
                <span dir="ltr">{`{{${name}}}`}</span>
              </Button>
            ))}
          </div>
        </div>
      </form>
    </AdminSheet>
  );
}
