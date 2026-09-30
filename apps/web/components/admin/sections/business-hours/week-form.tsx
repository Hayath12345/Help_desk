'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  HH_MM_PATTERN,
  businessHoursDtoSchema,
  minutesBetween,
  type BusinessHoursDto,
  type Locale,
  type UpdateBusinessHoursInput,
} from '@loons/shared';
import { RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { adminPath, adminWrite, useAdminMutation } from '@/lib/admin';
import { isolateDirection } from '@/lib/format';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';
import { useSlaErrorText, useSlaValidation } from '../sla/sla-shared';
import { weekdayName } from './format';

interface DayValues {
  weekday: number;
  isOpen: boolean;
  open: string;
  close: string;
}
interface WeekValues {
  days: DayValues[];
}

const formSchema = z
  .object({
    days: z.array(
      z.object({
        weekday: z.number(),
        isOpen: z.boolean(),
        open: z.string().regex(HH_MM_PATTERN, { error: 'validation.timeFormat' }),
        close: z.string().regex(HH_MM_PATTERN, { error: 'validation.timeFormat' }),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    value.days.forEach((day, i) => {
      if (
        day.isOpen &&
        HH_MM_PATTERN.test(day.open) &&
        HH_MM_PATTERN.test(day.close) &&
        minutesBetween(day.open, day.close) <= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['days', i, 'close'],
          message: 'validation.openBeforeClose',
        });
      }
    });
    if (!value.days.some((d) => d.isOpen)) {
      ctx.addIssue({ code: 'custom', path: ['days', 'root'], message: 'validation.oneOpenDay' });
    }
  });

function valuesOf(dto: BusinessHoursDto | undefined): WeekValues {
  return {
    days: (dto?.days ?? []).map((d) => ({
      weekday: d.weekday,
      isOpen: d.isOpen,
      open: d.open,
      close: d.close,
    })),
  };
}

export interface WeekFormProps {
  week: BusinessHoursDto | undefined;
  /** Refetches the week; resolves to it as it is now. */
  onReload: () => Promise<BusinessHoursDto | undefined>;
}

/**
 * The working week (E12): each weekday open or closed with its opening hours, saved as a whole.
 * Shows the business time zone (edited in General settings) and the business-day length that
 * "N business days" labels use.
 */
export function WeekForm({ week, onReload }: WeekFormProps) {
  const t = useTranslations('admin-sla.businessHours');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const validation = useSlaValidation();
  const errorText = useSlaErrorText();
  const formatWindow = useSlaWindowFormatter(week?.businessDayMinutes);
  const id = useId();

  const form = useForm<WeekValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(week),
  });
  const { control, register, handleSubmit, reset, formState } = form;
  const { fields } = useFieldArray({ control, name: 'days' });
  const days = useWatch({ control, name: 'days' });

  // The week the edit started from (E19): the save sends each day's `updatedAt` from it; a newer
  // week is only loaded while the form is untouched, or on Reload.
  const base = useRef<BusinessHoursDto | undefined>(week);
  const load = useCallback(
    (dto: BusinessHoursDto | undefined) => {
      base.current = dto;
      reset(valuesOf(dto));
    },
    [reset],
  );

  const save = useAdminMutation({
    section: 'business-hours',
    scopes: ['calendar'],
    errorToast: false,
    mutationFn: (body: UpdateBusinessHoursInput) =>
      adminWrite('PUT', adminPath('business-hours'), body, businessHoursDtoSchema),
    success: () => t('weekSaved'),
    onSuccess: (result) => load(result),
  });
  const { reset: resetSave } = save;

  const version = week?.days.map((d) => d.updatedAt).join('|');
  useEffect(() => {
    const baseVersion = base.current?.days.map((d) => d.updatedAt).join('|');
    if (!week || version === baseVersion) return;
    if (!formState.isDirty && !save.isConflict) load(week);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer week arrives
  }, [version]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((values) => {
      const started = base.current;
      if (!started) return;
      save.mutate({
        days: values.days.map((d) => ({
          ...d,
          expectedUpdatedAt: started.days.find((w) => w.weekday === d.weekday)?.updatedAt ?? '',
        })),
      });
    })(event);

  const rootError = validation(
    (formState.errors.days as { root?: { message?: string } } | undefined)?.root?.message,
  );
  const saveError = save.error && !save.isConflict ? errorText(save.error) : undefined;
  const dayLength = useMemo(() => {
    if (!week) return null;
    const hours = Math.floor(week.businessDayMinutes / 60);
    const minutes = week.businessDayMinutes % 60;
    return t('dayLength', {
      length: minutes ? t('hoursMinutes', { hours, minutes }) : t('hours', { count: hours }),
      example: formatWindow(week.businessDayMinutes * 2, true),
    });
  }, [week, t, formatWindow]);

  return (
    <Card className="gap-0 py-0">
      <form
        noValidate
        onSubmit={onSubmit}
        aria-labelledby={`${id}-title`}
        className="flex flex-col"
      >
        <div className="flex flex-col gap-1 border-b border-divider px-5 py-4">
          <h2 id={`${id}-title`} className="text-base font-semibold text-ink">
            {t('weekTitle')}
          </h2>
          {week ? (
            <p className="text-[13px] text-ink-secondary">
              {t.rich('timeZone', {
                zone: isolateDirection(week.timeZone, 'ltr'),
                link: (chunks) => (
                  <Link
                    href="/admin/settings"
                    className="rounded-sm text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-hidden"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : null}
        </div>

        {save.isConflict ? (
          <Alert variant="warning" className="mx-5 mt-4 px-3.5 py-3">
            <AlertTitle className="text-sm font-semibold">{tKit('conflictTitle')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2.5">
              <span>{tKit('conflictBody')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  load((await onReload()) ?? week);
                  resetSave();
                }}
              >
                <RotateCw aria-hidden="true" />
                {tKit('reload')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div role="group" aria-labelledby={`${id}-title`} className="flex flex-col">
          {fields.map((field, i) => {
            const day = days?.[i];
            const open = day?.isOpen ?? false;
            const name = weekdayName(field.weekday, locale);
            const dayId = `${id}-day-${field.weekday}`;
            const errors = formState.errors.days?.[i];
            const closeError = validation(errors?.close?.message);
            const openError = validation(errors?.open?.message);
            const error = openError ?? closeError;
            return (
              <div
                key={field.id}
                role="group"
                aria-labelledby={`${dayId}-name`}
                className="flex flex-col gap-2 border-b border-divider px-5 py-3 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,160px)_auto_minmax(0,1fr)] sm:items-center sm:gap-4"
              >
                <span id={`${dayId}-name`} className="font-medium text-ink">
                  {name}
                </span>
                <div className="flex items-center gap-2">
                  <Controller
                    control={control}
                    name={`days.${i}.isOpen`}
                    render={({ field: f }) => (
                      <Switch
                        id={`${dayId}-open-switch`}
                        checked={f.value}
                        onCheckedChange={f.onChange}
                        aria-label={t('openOn', { day: name })}
                      />
                    )}
                  />
                  <span className={cn('text-[13px]', open ? 'text-ink' : 'text-ink-muted')}>
                    {open ? t('open') : t('closed')}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <div className={cn('flex flex-wrap items-center gap-2', !open && 'opacity-60')}>
                    <Input
                      type="time"
                      dir="ltr"
                      step={60}
                      aria-label={t('opensAt', { day: name })}
                      aria-invalid={openError ? true : undefined}
                      aria-describedby={error ? `${dayId}-error` : undefined}
                      disabled={!open}
                      className="w-32"
                      {...register(`days.${i}.open`)}
                    />
                    <span aria-hidden="true" className="text-ink-muted">
                      –
                    </span>
                    <Input
                      type="time"
                      dir="ltr"
                      step={60}
                      aria-label={t('closesAt', { day: name })}
                      aria-invalid={closeError ? true : undefined}
                      aria-describedby={error ? `${dayId}-error` : undefined}
                      disabled={!open}
                      className="w-32"
                      {...register(`days.${i}.close`)}
                    />
                  </div>
                  {error ? (
                    <p id={`${dayId}-error`} className="text-[13px] text-danger">
                      {error}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 border-t border-divider px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1 text-[13px] text-ink-secondary">
            {dayLength ? <p>{dayLength}</p> : null}
            <p>{t('appliesNote')}</p>
            {rootError ? (
              <p role="alert" className="text-danger">
                {rootError}
              </p>
            ) : null}
            {saveError ? (
              <p role="alert" className="text-danger">
                {saveError}
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            className="self-start sm:self-auto"
            aria-disabled={save.isPending || save.isConflict || undefined}
            aria-busy={save.isPending || undefined}
            onClick={(event) => {
              if (save.isPending || save.isConflict) event.preventDefault();
            }}
          >
            {save.isPending ? tKit('saving') : tKit('save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
