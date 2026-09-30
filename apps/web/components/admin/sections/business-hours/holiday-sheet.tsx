'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADMIN_LIMITS,
  holidayResponseSchema,
  isoDay,
  labelArSchema,
  labelEnSchema,
  type HolidayAdminDto,
  type Locale,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  adminConflictDetails,
  adminPath,
  adminWrite,
  applyServerIssues,
  useAdminMutation,
  withExpectedUpdatedAt,
} from '@/lib/admin';
import { isApiRequestError } from '@/lib/api/errors';
import { AdminSheet, RhfBilingualField } from '../../kit';
import { useSlaErrorText, useSlaValidation } from '../sla/sla-shared';
import { holidayDateLabel } from './format';

interface HolidayFormValues {
  date: string;
  name: string;
  nameAr: string;
}

const formSchema = z.object({
  date: isoDay.or(z.literal('')).refine((v) => v !== '', { error: 'validation.required' }),
  name: labelEnSchema,
  nameAr: labelArSchema,
});

function valuesOf(holiday: HolidayAdminDto | undefined): HolidayFormValues {
  return { date: holiday?.date ?? '', name: holiday?.name ?? '', nameAr: holiday?.nameAr ?? '' };
}

export interface HolidaySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  holiday: HolidayAdminDto | undefined;
  /** Every holiday (archived included): a date that is taken offers its row instead. */
  all: readonly HolidayAdminDto[];
  /** Switch the sheet to another holiday (the one holding the chosen date). */
  onOpenHoliday: (id: string) => void;
  /** Refetches the list; resolves to the holiday as it is now. */
  onReload: () => Promise<HolidayAdminDto | undefined>;
}

/**
 * Add / rename / archive / restore a holiday (E12). The date is fixed once added; a date that
 * already has a holiday (archived included) is not added twice: the sheet offers that holiday —
 * restore it, or open it.
 */
export function HolidaySheet({
  open,
  onOpenChange,
  mode,
  holiday,
  all,
  onOpenHoliday,
  onReload,
}: HolidaySheetProps) {
  const t = useTranslations('admin-sla.holidays');
  const locale = useLocale() as Locale;
  const validation = useSlaValidation();
  const errorText = useSlaErrorText();
  const id = useId();
  const formId = `${id}-form`;

  const form = useForm<HolidayFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(holiday),
  });
  const { control, register, handleSubmit, reset, setError, formState } = form;
  const date = useWatch({ control, name: 'date' });

  const save = useAdminMutation({
    section: 'business-hours',
    scopes: ['calendar'],
    errorToast: false,
    mutationFn: (values: HolidayFormValues) =>
      mode === 'create'
        ? adminWrite('POST', adminPath('business-hours', 'holidays'), values, holidayResponseSchema)
        : adminWrite(
            'PATCH',
            adminPath('business-hours', 'holidays', holiday!.id),
            withExpectedUpdatedAt({ name: values.name, nameAr: values.nameAr }, base.current!),
            holidayResponseSchema,
          ),
    success: (result) =>
      mode === 'create' ? t('created', { name: result.item.name }) : t('saved'),
    onSuccess: (result) => {
      reset(valuesOf(result.item));
      onOpenChange(false);
    },
    onError: (error) => {
      applyServerIssues(error, setError, { paths: ['date', 'name', 'nameAr'] });
    },
  });
  const setActive = useAdminMutation({
    section: 'business-hours',
    scopes: ['calendar'],
    errorToast: false,
    mutationFn: (input: { row: HolidayAdminDto; active: boolean }) =>
      adminWrite(
        'POST',
        adminPath('business-hours', 'holidays', input.row.id, input.active ? 'restore' : 'archive'),
        { expectedUpdatedAt: input.row.updatedAt },
        holidayResponseSchema,
      ),
    success: (result, input) =>
      input.active
        ? t('restored', { name: result.item.name })
        : t('archived', { name: result.item.name }),
    onSuccess: (result, input) => {
      // Restoring the row that held the date the user typed: continue on that row.
      if (input.active && input.row.id !== holiday?.id) onOpenHoliday(result.item.id);
      else if (!input.active) onOpenChange(false);
    },
  });
  const { reset: resetSave } = save;
  const { reset: resetActive } = setActive;

  // The version the edit started from (E19): saves send its `updatedAt`; a newer version is only
  // loaded while the form is untouched, or on Reload.
  const base = useRef<HolidayAdminDto | undefined>(holiday);
  const load = useCallback(
    (row: HolidayAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row));
    },
    [reset],
  );
  const holidayId = holiday?.id;
  useEffect(() => {
    if (!open) return;
    load(holiday);
    resetSave();
    resetActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the sheet opens or switches row
  }, [open, holidayId, load, resetSave, resetActive]);
  const latest = holiday?.updatedAt;
  useEffect(() => {
    if (!open || !holiday || holiday.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict && !setActive.isConflict) load(holiday);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  // The date the user chose already has a holiday (archived ones too): offer that one.
  const taken = useMemo(() => {
    if (mode !== 'create' || !date) return undefined;
    return all.find((h) => h.date === date);
  }, [mode, date, all]);
  const duplicateId = adminConflictDetails(save.error)?.existingId;
  const existing = taken ?? all.find((h) => h.id === duplicateId);

  const onSubmit = handleSubmit((values) => {
    if (existing && mode === 'create') return;
    save.mutate(values);
  });

  const conflict = save.isConflict || setActive.isConflict;
  const lastError = setActive.error ?? save.error;
  const formError =
    lastError &&
    !conflict &&
    !existing &&
    !(isApiRequestError(lastError) && lastError.code === 'VALIDATION_FAILED')
      ? errorText(lastError)
      : undefined;
  const dateError = validation(formState.errors.date?.message);

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      title={mode === 'create' ? t('createTitle') : (holiday?.name ?? '')}
      description={
        mode === 'edit' && holiday ? holidayDateLabel(holiday.date, locale) : t('createDescription')
      }
      dirty={formState.isDirty}
      archived={mode === 'edit' && holiday?.isActive === false}
      formId={formId}
      saving={save.isPending}
      onArchive={
        holiday
          ? () => setActive.mutate({ row: base.current ?? holiday, active: false })
          : undefined
      }
      archiving={setActive.isPending && setActive.variables?.active === false}
      onRestore={
        holiday ? () => setActive.mutate({ row: base.current ?? holiday, active: true }) : undefined
      }
      restoring={setActive.isPending && setActive.variables?.active === true}
      itemLabel={holiday?.name}
      archiveWarning={t('archiveWarning')}
      conflict={conflict}
      onReload={async () => {
        load((await onReload()) ?? holiday);
        resetSave();
        resetActive();
      }}
      error={formError}
    >
      <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-[18px]">
        <FormField
          id={`${id}-date`}
          label={t('fields.date')}
          required={mode === 'create'}
          hint={mode === 'edit' ? t('fields.dateLocked') : undefined}
          error={dateError}
        >
          <Input
            type="date"
            dir="ltr"
            min="2000-01-01"
            max="2100-12-31"
            readOnly={mode === 'edit'}
            className="w-48"
            {...fieldA11y(`${id}-date`, { error: dateError, hint: mode === 'edit' })}
            {...register('date')}
          />
        </FormField>
        {existing && mode === 'create' ? (
          <Alert className="px-3.5 py-3">
            <AlertDescription className="flex flex-col items-start gap-2.5">
              <span>
                {existing.isActive
                  ? t('dateTaken', { name: existing.name })
                  : t('dateTakenArchived', { name: existing.name })}
              </span>
              {existing.isActive ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenHoliday(existing.id)}
                >
                  {t('openExisting')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-busy={setActive.isPending || undefined}
                  onClick={() => {
                    if (!setActive.isPending) setActive.mutate({ row: existing, active: true });
                  }}
                >
                  {setActive.isPending ? t('restoring') : t('restoreExisting')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        <RhfBilingualField
          control={control}
          nameEn="name"
          nameAr="nameAr"
          id={`${id}-name`}
          label={t('fields.name')}
          required
          maxLength={ADMIN_LIMITS.labelMax}
          errorText={validation}
        />
      </form>
    </AdminSheet>
  );
}
