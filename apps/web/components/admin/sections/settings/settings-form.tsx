'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  HH_MM_PATTERN,
  SETTINGS_LIMITS,
  generalSettingsDtoSchema,
  normalizeE164,
  type GeneralSettingsDto,
  type GeneralSettingsValues,
  type Locale,
  type UpdateGeneralSettingsInput,
} from '@loons/shared';
import { RotateCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Controller, useForm, type FieldPath } from 'react-hook-form';
import { z } from 'zod';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminPath, adminWrite, useAdminMutation } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { localizedLabel } from '@/lib/tickets/labels';
import { useTicketFormConfig } from '@/lib/tickets/queries';
import { useSlaErrorText, useSlaValidation } from '../sla/sla-shared';

interface SettingsFormValues {
  businessTimezone: string;
  socPhone: string;
  autoCloseDays: string;
  p4DigestTime: string;
  securityCategoryKey: string;
}

const formSchema = z.object({
  businessTimezone: z.string().min(1, { error: 'validation.timezone' }),
  socPhone: z
    .string()
    .refine((v) => v.trim() === '' || normalizeE164(v) !== null, { error: 'validation.phone' }),
  autoCloseDays: z.string().refine(
    (v) => {
      if (!/^\d+$/.test(v.trim())) return false;
      const n = Number(v);
      return n >= SETTINGS_LIMITS.autoCloseDaysMin && n <= SETTINGS_LIMITS.autoCloseDaysMax;
    },
    { error: 'validation.autoCloseDays' },
  ),
  p4DigestTime: z.string().regex(HH_MM_PATTERN, { error: 'validation.timeFormat' }),
  securityCategoryKey: z.string().min(1, { error: 'validation.securityCategory' }),
});

function valuesOf(settings: GeneralSettingsDto): SettingsFormValues {
  const v = settings.values;
  return {
    businessTimezone: v.businessTimezone,
    socPhone: v.socPhone ?? '',
    autoCloseDays: String(v.autoCloseDays),
    p4DigestTime: v.p4DigestTime,
    securityCategoryKey: v.securityCategoryKey,
  };
}

/** Named IANA zones the browser knows (plus UTC and the stored one). */
function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return [...new Set(['UTC', current, ...zones])].sort((a, b) => a.localeCompare(b));
}

export interface SettingsFormProps {
  settings: GeneralSettingsDto;
  /** Refetches the settings; resolves to them as they are now. */
  onReload: () => Promise<GeneralSettingsDto | undefined>;
}

/** The General settings form (E11). Only the values that changed are sent. */
export function SettingsForm({ settings, onReload }: SettingsFormProps) {
  const t = useTranslations('admin-sla.settings');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const validation = useSlaValidation();
  const errorText = useSlaErrorText();
  const id = useId();
  const config = useTicketFormConfig();

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(settings),
  });
  const { control, register, handleSubmit, reset, setError, formState } = form;
  const zones = useMemo(
    () => timeZones(settings.values.businessTimezone),
    [settings.values.businessTimezone],
  );

  // The settings the edit started from (E19): the save sends their `updatedAt`; newer ones are only
  // loaded while the form is untouched, or on Reload.
  const base = useRef<GeneralSettingsDto>(settings);
  const load = useCallback(
    (dto: GeneralSettingsDto) => {
      base.current = dto;
      reset(valuesOf(dto));
    },
    [reset],
  );

  const save = useAdminMutation({
    section: 'settings',
    scopes: ['settings', 'ticket-form', 'calendar'],
    errorToast: false,
    mutationFn: (body: UpdateGeneralSettingsInput) =>
      adminWrite('PATCH', adminPath('settings'), body, generalSettingsDtoSchema),
    success: () => t('saved'),
    onSuccess: (result) => load(result),
    onError: (error) => {
      if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return;
      for (const issue of validationIssues(error)) {
        const field = issue.path[0] === 'values' ? String(issue.path[1]) : '';
        if (field in formSchema.shape) {
          setError(field as FieldPath<SettingsFormValues>, {
            type: 'server',
            message: issue.message,
          });
        }
      }
    },
  });
  const { reset: resetSave } = save;

  useEffect(() => {
    if (settings.updatedAt === base.current.updatedAt) return;
    if (!formState.isDirty && !save.isConflict) load(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when newer settings arrive
  }, [settings.updatedAt]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((v) => {
      const dirty = formState.dirtyFields;
      const values: Partial<GeneralSettingsValues> = {};
      if (dirty.businessTimezone) values.businessTimezone = v.businessTimezone;
      if (dirty.socPhone) values.socPhone = v.socPhone.trim() === '' ? null : v.socPhone.trim();
      if (dirty.autoCloseDays) values.autoCloseDays = Number(v.autoCloseDays);
      if (dirty.p4DigestTime) values.p4DigestTime = v.p4DigestTime;
      if (dirty.securityCategoryKey) values.securityCategoryKey = v.securityCategoryKey;
      if (Object.keys(values).length === 0) return;
      save.mutate({ expectedUpdatedAt: base.current.updatedAt, values });
    })(event);

  const errors = formState.errors;
  const err = (name: keyof SettingsFormValues) => validation(errors[name]?.message);
  const saveError =
    save.error &&
    !save.isConflict &&
    !(isApiRequestError(save.error) && save.error.code === 'VALIDATION_FAILED')
      ? errorText(save.error)
      : undefined;

  // Categories a security incident can use: active with an active sub-type (the form config).
  const categories = config.data?.categories ?? [];
  const storedKey = settings.values.securityCategoryKey;

  return (
    <Card className="max-w-2xl gap-0 py-0">
      <form
        noValidate
        onSubmit={onSubmit}
        aria-label={t('formLabel')}
        className="flex flex-col gap-5 p-5"
      >
        {save.isConflict ? (
          <Alert variant="warning" className="px-3.5 py-3">
            <AlertTitle className="text-sm font-semibold">{tKit('conflictTitle')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2.5">
              <span>{tKit('conflictBody')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  load((await onReload()) ?? settings);
                  resetSave();
                }}
              >
                <RotateCw aria-hidden="true" />
                {tKit('reload')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <FormField
          id={`${id}-zone`}
          label={t('fields.timezone')}
          required
          hint={t('fields.timezoneHint')}
          error={err('businessTimezone')}
        >
          <Controller
            control={control}
            name="businessTimezone"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  ref={field.ref}
                  dir="ltr"
                  className="w-full sm:w-80"
                  {...fieldA11y(`${id}-zone`, { error: err('businessTimezone'), hint: true })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone} dir="ltr">
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        <FormField
          id={`${id}-phone`}
          label={t('fields.socPhone')}
          labelNote={t('optional')}
          hint={t('fields.socPhoneHint')}
          error={err('socPhone')}
        >
          <Input
            type="tel"
            dir="ltr"
            autoComplete="off"
            className="w-full text-start sm:w-80"
            {...fieldA11y(`${id}-phone`, { error: err('socPhone'), hint: true })}
            {...register('socPhone')}
          />
        </FormField>

        <FormField
          id={`${id}-close`}
          label={t('fields.autoCloseDays')}
          required
          hint={t('fields.autoCloseDaysHint', {
            min: SETTINGS_LIMITS.autoCloseDaysMin,
            max: SETTINGS_LIMITS.autoCloseDaysMax,
          })}
          error={err('autoCloseDays')}
        >
          <div className="flex items-center gap-2">
            <Input
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className="w-24 text-end tabular-nums"
              {...fieldA11y(`${id}-close`, { error: err('autoCloseDays'), hint: true })}
              {...register('autoCloseDays')}
            />
            <span aria-hidden="true" className="text-[13px] text-ink-secondary">
              {t('days')}
            </span>
          </div>
        </FormField>

        <FormField
          id={`${id}-digest`}
          label={t('fields.digestTime')}
          required
          hint={t('fields.digestTimeHint')}
          error={err('p4DigestTime')}
        >
          <Input
            type="time"
            dir="ltr"
            step={60}
            className="w-32"
            {...fieldA11y(`${id}-digest`, { error: err('p4DigestTime'), hint: true })}
            {...register('p4DigestTime')}
          />
        </FormField>

        <FormField
          id={`${id}-security`}
          label={t('fields.securityCategory')}
          required
          hint={t('fields.securityCategoryHint')}
          error={err('securityCategoryKey')}
        >
          <Controller
            control={control}
            name="securityCategoryKey"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  ref={field.ref}
                  className="w-full sm:w-80"
                  {...fieldA11y(`${id}-security`, {
                    error: err('securityCategoryKey'),
                    hint: true,
                  })}
                >
                  <SelectValue placeholder={t('fields.chooseCategory')} />
                </SelectTrigger>
                <SelectContent>
                  {categories.some((c) => c.key === storedKey) ? null : (
                    <SelectItem value={storedKey}>
                      {t('fields.unavailableCategory', { key: storedKey })}
                    </SelectItem>
                  )}
                  {categories.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {localizedLabel(c, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        <p
          role="note"
          className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-[13px] leading-normal text-ink-secondary"
        >
          {t('rescheduleNote')}
        </p>
        {saveError ? (
          <p role="alert" className="text-[13px] text-danger">
            {saveError}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            aria-disabled={save.isPending || save.isConflict || !formState.isDirty || undefined}
            aria-busy={save.isPending || undefined}
            onClick={(event) => {
              if (save.isPending || save.isConflict || !formState.isDirty) event.preventDefault();
            }}
          >
            {save.isPending ? tKit('saving') : tKit('save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
