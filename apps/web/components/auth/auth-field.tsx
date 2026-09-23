'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { inputClass } from './styles';

type AuthFieldProps = Omit<React.ComponentProps<'input'>, 'id'> & {
  id: string;
  label: React.ReactNode;
  /** Rendered at the inline end of the label row (e.g. "Forgot password?"). */
  labelAside?: React.ReactNode;
  /** Already-translated error message. */
  error?: string;
  hint?: React.ReactNode;
};

/** Labelled input in the design's style, wired for accessibility (aria-invalid/-describedby). */
export function AuthField({
  id,
  label,
  labelAside,
  error,
  hint,
  className,
  ...inputProps
}: AuthFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="leading-snug font-medium text-ink">
          {label}
        </Label>
        {labelAside}
      </div>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(inputClass, className)}
        {...inputProps}
      />
      {hint ? (
        <p id={hintId} className="text-xs leading-normal text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[13px] leading-normal text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
