'use client';

import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface StatusControlOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface StatusControlProps<V extends string> {
  options: readonly StatusControlOption<V>[];
  /** '' : nothing checked (e.g. a CLOSED ticket, which the control can't set). */
  value: V | '';
  /** Called once per explicit choice (click, Enter or Space) — never while arrowing. */
  onValueChange: (value: V) => void;
  'aria-labelledby'?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The console right panel's status segmented control (design 823–827: a sunken track, the current
 * status as a dark segment). Every choice is saved at once, so it uses manual activation: a
 * radiogroup with one tab stop where the arrow keys (mirrored in RTL), Home and End only move
 * focus, and Enter / Space / a click picks the focused status — arrowing from Open to Solved never
 * saves Pending on the way (a Radix RadioGroup checks every radio it focuses).
 *
 * The segments size to their labels and share the spare width, so "قيد الانتظار" fits the ~236 px
 * panel; below that, a multi-word label wraps inside its segment instead of being clipped.
 */
export function StatusControl<V extends string>({
  options,
  value,
  onValueChange,
  disabled,
  className,
  ...aria
}: StatusControlProps<V>) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      orientation="horizontal"
      value={value}
      onValueChange={(next) => {
        // Enter / click on the current status would "un-press" it: a status can't be cleared.
        if (next && next !== value) onValueChange(next as V);
      }}
      disabled={disabled}
      aria-labelledby={aria['aria-labelledby']}
      className={cn('flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]', className)}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'flex-auto cursor-pointer rounded-md px-1.5 py-[7px] text-center text-[13px] font-medium text-ink-secondary transition-[background-color,color,box-shadow] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50',
            'enabled:data-[state=off]:hover:text-ink',
            'data-[state=on]:bg-ink data-[state=on]:text-surface',
          )}
        >
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
