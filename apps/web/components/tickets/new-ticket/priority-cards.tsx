'use client';

import { PRIORITIES, type Priority, type TicketFormConfig } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useImperativeHandle, useRef } from 'react';
import { PRIORITY_DOT } from '@/components/common/priority';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';
import type { FocusHandle } from '../segmented-control';

/** Checked card colours per priority (tinted background, coloured border + label). */
const CHECKED: Record<Priority, string> = {
  P1: 'data-[state=checked]:border-p1-fg data-[state=checked]:bg-p1-bg data-[state=checked]:text-p1-fg',
  P2: 'data-[state=checked]:border-p2-fg data-[state=checked]:bg-p2-bg data-[state=checked]:text-p2-fg',
  P3: 'data-[state=checked]:border-p3-fg data-[state=checked]:bg-p3-bg data-[state=checked]:text-p3-fg',
  P4: 'data-[state=checked]:border-p4-fg data-[state=checked]:bg-p4-bg data-[state=checked]:text-p4-fg',
};

export interface PriorityCardsProps {
  /** The effective priority (manual, else the sub-type default); null = none yet. */
  value: Priority | null;
  onValueChange: (priority: Priority) => void;
  slaPolicies: TicketFormConfig['slaPolicies'];
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  ref?: React.Ref<FocusHandle>;
}

/**
 * P1–P4 radio cards with each priority's first-reply target (design 1062–1073). Arrow keys move
 * between cards (RTL-aware); picking one makes the priority manual.
 */
export function PriorityCards({
  value,
  onValueChange,
  slaPolicies,
  ref,
  ...aria
}: PriorityCardsProps) {
  const t = useTranslations('tickets.newTicket');
  const tPriority = useTranslations('common.priority');
  const formatWindow = useSlaWindowFormatter();
  const rootRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () =>
      (
        rootRef.current?.querySelector<HTMLButtonElement>('[data-state="checked"]') ??
        rootRef.current?.querySelector<HTMLButtonElement>('[role="radio"]')
      )?.focus(),
  }));

  return (
    <RadioGroupPrimitive.Root
      ref={rootRef}
      value={value ?? ''}
      onValueChange={(next) => onValueChange(next as Priority)}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
      className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2"
    >
      {PRIORITIES.map((priority) => {
        const policy = slaPolicies.find((p) => p.priority === priority);
        return (
          <RadioGroupPrimitive.Item
            key={priority}
            value={priority}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-lg border border-line bg-surface px-3 py-[9px] text-start text-ink transition-[background-color,border-color,color] duration-150 ease-out hover:border-line-dashed',
              CHECKED[priority],
            )}
          >
            <span className="flex items-center gap-[7px] font-semibold">
              <span
                aria-hidden="true"
                className={cn('size-2 shrink-0 rounded-full', PRIORITY_DOT[priority])}
              />
              {tPriority(priority)}
            </span>
            {policy ? (
              <span className="font-mono text-xs text-ink-secondary">
                {t('firstReply', {
                  duration: formatWindow(policy.firstReplyMins, policy.businessHoursOnly),
                })}
              </span>
            ) : null}
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
