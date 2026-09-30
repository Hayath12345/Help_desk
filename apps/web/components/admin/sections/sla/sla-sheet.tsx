'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  SLA_LIMITS,
  slaPolicyResponseSchema,
  type SlaPolicyAdminDto,
  type UpdateSlaPolicyInput,
} from '@loons/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { z } from 'zod';
import { PriorityPill } from '@/components/common/priority';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { adminPath, adminWrite, useAdminMutation } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { AdminSheet } from '../../kit';
import {
  DurationInput,
  joinMinutes,
  splitMinutes,
  useSlaErrorText,
  useSlaValidation,
} from './sla-shared';

interface SlaFormValues {
  firstReplyHours: string;
  firstReplyMinutes: string;
  resolveHours: string;
  resolveMinutes: string;
  businessHoursOnly: boolean;
  atRiskPercent: string;
}

function minutesIssue(total: number): string | null {
  if (!Number.isFinite(total)) return 'validation.wholeNumber';
  if (total < 1) return 'validation.minutesMin';
  if (total > SLA_LIMITS.minutesMax) return 'validation.tooLarge';
  return null;
}

const formSchema = z
  .object({
    firstReplyHours: z.string(),
    firstReplyMinutes: z.string(),
    resolveHours: z.string(),
    resolveMinutes: z.string(),
    businessHoursOnly: z.boolean(),
    atRiskPercent: z.string(),
  })
  .superRefine((v, ctx) => {
    const first = minutesIssue(joinMinutes(v.firstReplyHours, v.firstReplyMinutes));
    if (first) ctx.addIssue({ code: 'custom', path: ['firstReplyHours'], message: first });
    const resolve = minutesIssue(joinMinutes(v.resolveHours, v.resolveMinutes));
    if (resolve) ctx.addIssue({ code: 'custom', path: ['resolveHours'], message: resolve });
    const pct = /^\d+$/.test(v.atRiskPercent.trim()) ? Number(v.atRiskPercent) : NaN;
    if (!(pct >= SLA_LIMITS.atRiskPercentMin && pct <= SLA_LIMITS.atRiskPercentMax)) {
      ctx.addIssue({
        code: 'custom',
        path: ['atRiskPercent'],
        message: 'validation.atRiskPercent',
      });
    }
  });

function valuesOf(policy: SlaPolicyAdminDto | undefined): SlaFormValues {
  const first = splitMinutes(policy?.firstReplyMins ?? 60);
  const resolve = splitMinutes(policy?.resolveMins ?? 480);
  return {
    firstReplyHours: String(first.hours),
    firstReplyMinutes: String(first.minutes),
    resolveHours: String(resolve.hours),
    resolveMinutes: String(resolve.minutes),
    businessHoursOnly: policy?.businessHoursOnly ?? true,
    atRiskPercent: String(policy?.atRiskPercent ?? 75),
  };
}

/** API body field → the form field that shows its error. */
const SERVER_FIELDS: Record<string, FieldPath<SlaFormValues>> = {
  firstReplyMins: 'firstReplyHours',
  resolveMins: 'resolveHours',
  atRiskPercent: 'atRiskPercent',
  businessHoursOnly: 'businessHoursOnly',
};

export interface SlaSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: SlaPolicyAdminDto | undefined;
  businessDayMinutes: number | undefined;
  /** Refetches the list; resolves to the row as it is now. */
  onReload: () => Promise<SlaPolicyAdminDto | undefined>;
}

/**
 * Edit one priority's SLA targets (E12): first reply and resolution as hours + minutes, whether
 * only business hours count, and when a ticket is flagged "at risk". Says that open tickets keep
 * their due dates.
 */
export function SlaSheet({
  open,
  onOpenChange,
  policy,
  businessDayMinutes,
  onReload,
}: SlaSheetProps) {
  const t = useTranslations('admin-sla.sla');
  const tPriority = useTranslations('common.priority');
  const validation = useSlaValidation();
  const errorText = useSlaErrorText();
  const formatWindow = useSlaWindowFormatter(businessDayMinutes);
  const id = useId();
  const formId = `${id}-form`;

  const form = useForm<SlaFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(policy),
  });
  const { control, register, handleSubmit, reset, setError, formState } = form;
  const values = useWatch({ control });

  const save = useAdminMutation({
    section: 'sla',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: (body: UpdateSlaPolicyInput) =>
      adminWrite('PATCH', adminPath('sla', policy!.priority), body, slaPolicyResponseSchema),
    success: () => t('saved', { priority: tPriority(policy!.priority) }),
    onSuccess: (result) => {
      reset(valuesOf(result.item));
      onOpenChange(false);
    },
    onError: (error) => {
      if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return;
      for (const issue of validationIssues(error)) {
        const field = SERVER_FIELDS[String(issue.path[0])];
        if (field) setError(field, { type: 'server', message: issue.message });
      }
    },
  });
  const { reset: resetSave } = save;

  // The row the edit started from: its `updatedAt` is what the save sends (E19), even when a newer
  // version arrives meanwhile (that one is only loaded while the form is untouched, or on Reload).
  const base = useRef<SlaPolicyAdminDto | undefined>(policy);
  const load = useCallback(
    (row: SlaPolicyAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row));
    },
    [reset],
  );
  const policyId = policy?.id;
  useEffect(() => {
    if (!open) return;
    load(policy);
    resetSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the sheet opens or switches row
  }, [open, policyId, load, resetSave]);
  const latest = policy?.updatedAt;
  useEffect(() => {
    if (!open || !policy || policy.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict) load(policy);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((v) => {
      if (!base.current) return;
      save.mutate({
        expectedUpdatedAt: base.current.updatedAt,
        firstReplyMins: joinMinutes(v.firstReplyHours, v.firstReplyMinutes),
        resolveMins: joinMinutes(v.resolveHours, v.resolveMinutes),
        businessHoursOnly: v.businessHoursOnly,
        atRiskPercent: Number(v.atRiskPercent),
      });
    })(event);

  const shownAs = (hours = '', minutes = '') => {
    const total = joinMinutes(hours, minutes);
    return Number.isFinite(total) && total >= 1
      ? t('shownAs', { label: formatWindow(total, values.businessHoursOnly ?? true) })
      : undefined;
  };
  const errors = formState.errors;
  const firstError = validation(errors.firstReplyHours?.message);
  const resolveError = validation(errors.resolveHours?.message);
  const riskError = validation(errors.atRiskPercent?.message);
  const formError =
    save.error &&
    !save.isConflict &&
    !(isApiRequestError(save.error) && save.error.code === 'VALIDATION_FAILED')
      ? errorText(save.error)
      : undefined;

  const duration = (kind: 'firstReply' | 'resolve', label: string, error: string | undefined) => {
    const fieldId = `${id}-${kind}`;
    const hint = shownAs(values[`${kind}Hours`], values[`${kind}Minutes`]);
    const describedBy = [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null]
      .filter(Boolean)
      .join(' ');
    return (
      <FormField id={fieldId} label={label} labelKind="group" required hint={hint} error={error}>
        <DurationInput
          id={fieldId}
          labelledBy={`${fieldId}-label`}
          hours={values[`${kind}Hours`] ?? ''}
          minutes={values[`${kind}Minutes`] ?? ''}
          onHoursChange={(v) => form.setValue(`${kind}Hours`, v, { shouldDirty: true })}
          onMinutesChange={(v) => form.setValue(`${kind}Minutes`, v, { shouldDirty: true })}
          describedBy={describedBy || undefined}
          invalid={Boolean(error)}
        />
      </FormField>
    );
  };

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode="edit"
      title={policy ? t('sheetTitle', { priority: tPriority(policy.priority) }) : ''}
      description={t('sheetDescription')}
      dirty={formState.isDirty}
      formId={formId}
      saving={save.isPending}
      conflict={save.isConflict}
      onReload={async () => {
        load((await onReload()) ?? policy);
        resetSave();
      }}
      error={formError}
    >
      <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-[18px]">
        {policy ? (
          <div>
            <PriorityPill priority={policy.priority} withDot />
          </div>
        ) : null}
        {duration('firstReply', t('fields.firstReply'), firstError)}
        {duration('resolve', t('fields.resolution'), resolveError)}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-line px-3.5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={`${id}-business`} className="font-medium text-ink">
              {t('fields.businessHoursOnly')}
            </label>
            <p id={`${id}-business-hint`} className="text-[13px] text-ink-secondary">
              {t('fields.businessHoursOnlyHint')}
            </p>
          </div>
          <Controller
            control={control}
            name="businessHoursOnly"
            render={({ field }) => (
              <Switch
                id={`${id}-business`}
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-describedby={`${id}-business-hint`}
              />
            )}
          />
        </div>
        <FormField
          id={`${id}-risk`}
          label={t('fields.atRisk')}
          required
          hint={t('fields.atRiskHint')}
          error={riskError}
        >
          <div className="flex items-center gap-2">
            <Input
              {...fieldA11y(`${id}-risk`, { error: riskError, hint: true })}
              {...register('atRiskPercent')}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className="w-20 text-end tabular-nums"
            />
            <span aria-hidden="true" className="text-[13px] text-ink-secondary">
              %
            </span>
          </div>
        </FormField>
        <p
          role="note"
          className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-[13px] leading-normal text-ink-secondary"
        >
          {t('appliesNote')}
        </p>
      </form>
    </AdminSheet>
  );
}
