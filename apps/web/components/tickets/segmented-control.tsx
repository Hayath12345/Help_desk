'use client';

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useImperativeHandle, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
  disabled?: boolean;
}

/** What react-hook-form needs to focus the control on a validation error. */
export interface FocusHandle {
  focus: () => void;
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  /** '' / undefined: nothing checked (the first segment is then the tab stop). */
  value: V | '' | undefined;
  onValueChange: (value: V) => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** `md`: New ticket form (8px 10px segments). `sm`: dense panels. */
  size?: 'sm' | 'md';
  /** Classes for the checked segment per value (e.g. status colours); default: white segment. */
  checkedClassName?: (value: V) => string | undefined;
  className?: string;
  itemClassName?: string;
  ref?: React.Ref<FocusHandle>;
}

/**
 * The design's segmented radios (Ticket type, Impact, console Status): a sunken track with a
 * white checked segment. A real radiogroup: one tab stop, arrow keys move and select (mirrored
 * in RTL through the DirectionProvider), Home/End, screen readers announce "n of m".
 */
export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  id,
  name,
  disabled,
  required,
  size = 'md',
  checkedClassName,
  className,
  itemClassName,
  ref,
  ...aria
}: SegmentedControlProps<V>) {
  const rootRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => {
      const root = rootRef.current;
      const target =
        root?.querySelector<HTMLButtonElement>('[role="radio"][data-state="checked"]') ??
        root?.querySelector<HTMLButtonElement>('[role="radio"]:not([disabled])');
      target?.focus();
    },
  }));

  return (
    <RadioGroupPrimitive.Root
      ref={rootRef}
      id={id}
      name={name}
      value={value || ''}
      onValueChange={(next) => onValueChange(next as V)}
      disabled={disabled}
      required={required}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
      aria-invalid={aria['aria-invalid'] || undefined}
      className={cn(
        'flex flex-wrap gap-[3px] rounded-lg bg-surface-sunken p-[3px] aria-invalid:ring-1 aria-invalid:ring-danger-strong',
        className,
      )}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'flex-[1_1_auto] cursor-pointer rounded-md font-medium whitespace-nowrap text-ink-secondary transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-ink disabled:cursor-not-allowed disabled:opacity-50',
            size === 'md' ? 'px-2.5 py-2 text-[13px]' : 'px-2 py-1.5 text-[13px]',
            'data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-segment',
            value === option.value && checkedClassName?.(option.value),
            itemClassName,
          )}
        >
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
