'use client';

// Shared bits of the "SLA & escalation" admin group (SLA policies, business hours & holidays,
// escalation rules, general settings): validation / error sentences from the `admin-sla`
// namespace (falling back to `validation` and `errors`), and the hours + minutes duration input.

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { adminConflictDetails } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';

type Untyped = (key: string, values?: Record<string, string | number>) => string;

/** `validation.<key>` from a schema / the API → text (admin-sla.validation, then validation). */
export function useSlaValidation(): (message: string | undefined) => string | undefined {
  const tGroup = useTranslations('admin-sla.validation');
  const tValidation = useTranslations('validation');
  return useCallback(
    (message) => {
      if (!message) return undefined;
      const key = message.startsWith('validation.') ? message.slice('validation.'.length) : '';
      if (key && tGroup.has(key as never)) return (tGroup as unknown as Untyped)(key);
      if (key && tValidation.has(key as never)) return (tValidation as unknown as Untyped)(key);
      return tValidation('invalid');
    },
    [tGroup, tValidation],
  );
}

/**
 * The sentence for a failed write of this group: a duplicate (409), the first validation issue
 * (400), else the generic text of the error code.
 */
export function useSlaErrorText(): (error: unknown) => string {
  const t = useTranslations('admin-sla.errors');
  const validation = useSlaValidation();
  const apiErrorText = useApiErrorText();
  return useCallback(
    (error) => {
      const details = adminConflictDetails(error);
      if (details?.reason === 'duplicate') return t('duplicate');
      if (details?.reason === 'guard' && details.guard === 'escalation_team_archived') {
        return t('guards.escalation_team_archived');
      }
      if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
        const [first] = validationIssues(error);
        if (first) return validation(first.message) ?? apiErrorText(error);
      }
      return apiErrorText(error);
    },
    [t, validation, apiErrorText],
  );
}

/** Minutes → whole hours and the minutes left. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  const m = Math.max(0, Math.round(total));
  return { hours: Math.floor(m / 60), minutes: m % 60 };
}

/** Hours + minutes (text inputs; '' counts as 0) → minutes, or NaN when not whole numbers ≥ 0. */
export function joinMinutes(hours: string, minutes: string): number {
  const parse = (v: string) => (v.trim() === '' ? 0 : /^\d+$/.test(v.trim()) ? Number(v) : NaN);
  return parse(hours) * 60 + parse(minutes);
}

export interface DurationInputProps {
  /** Prefix of the two inputs' ids (`${id}-hours`, `${id}-minutes`). */
  id: string;
  /** The field's label (a group label: the inputs say "hours" / "minutes"). */
  labelledBy: string;
  hours: string;
  minutes: string;
  onHoursChange: (value: string) => void;
  onMinutesChange: (value: string) => void;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Hours + minutes side by side (E12: SLA targets and escalation delays). */
export function DurationInput({
  id,
  labelledBy,
  hours,
  minutes,
  onHoursChange,
  onMinutesChange,
  describedBy,
  invalid,
  disabled,
  className,
}: DurationInputProps) {
  const t = useTranslations('admin-sla.duration');
  const part = (kind: 'hours' | 'minutes') => {
    const inputId = `${id}-${kind}`;
    return (
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          inputMode="numeric"
          dir="ltr"
          autoComplete="off"
          value={kind === 'hours' ? hours : minutes}
          onChange={(event) =>
            (kind === 'hours' ? onHoursChange : onMinutesChange)(event.target.value)
          }
          aria-labelledby={`${labelledBy} ${inputId}-unit`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className="w-20 text-end tabular-nums"
        />
        <span id={`${inputId}-unit`} className="text-[13px] text-ink-secondary">
          {t(kind)}
        </span>
      </div>
    );
  };
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className={cn('flex flex-wrap items-center gap-3', className)}
    >
      {part('hours')}
      {part('minutes')}
    </div>
  );
}
