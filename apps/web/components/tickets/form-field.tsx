'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/** ids + aria attributes that tie a control to its label, hint and error. */
export function fieldA11y(id: string, options: { error?: string; hint?: boolean }) {
  const describedBy = [options.error ? `${id}-error` : null, options.hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');
  return {
    id,
    'aria-invalid': options.error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  } as const;
}

export interface FormFieldProps {
  /** Id of the control (`htmlFor`), also the prefix of `-label`, `-hint` and `-error` ids. */
  id: string;
  label: React.ReactNode;
  required?: boolean;
  /** Muted text after the label, e.g. "(optional)". */
  labelNote?: React.ReactNode;
  /** Right-aligned (inline-end) text on the label row. */
  labelAside?: React.ReactNode;
  hint?: React.ReactNode;
  /** Already translated. */
  error?: string;
  /**
   * `label` (default): a <label for=id>. `group`: a plain text label (id `${id}-label`) for
   * radiogroups and other composite controls that use aria-labelledby.
   */
  labelKind?: 'label' | 'group';
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint + error, spaced like the design's form fields (6px gaps). */
export function FormField({
  id,
  label,
  required = false,
  labelNote,
  labelAside,
  hint,
  error,
  labelKind = 'label',
  disabled = false,
  className,
  children,
}: FormFieldProps) {
  const t = useTranslations('tickets.newTicket');
  const labelContent = (
    <>
      {label}
      {required ? (
        <>
          <span aria-hidden="true" className="text-danger">
            {' *'}
          </span>
          <span className="sr-only">{` (${t('required')})`}</span>
        </>
      ) : null}
      {labelNote ? <span className="font-normal text-ink-muted"> {labelNote}</span> : null}
    </>
  );
  const labelClass = cn('font-medium text-ink', disabled && 'text-ink-muted');

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        {labelKind === 'label' ? (
          <label id={`${id}-label`} htmlFor={id} className={labelClass}>
            {labelContent}
          </label>
        ) : (
          <span id={`${id}-label`} className={labelClass}>
            {labelContent}
          </span>
        )}
        {labelAside ? <span className="text-xs text-ink-muted">{labelAside}</span> : null}
      </div>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-[13px] leading-normal text-ink-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] leading-normal font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
