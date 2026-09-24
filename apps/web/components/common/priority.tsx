import type { Priority } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export const PRIORITY_DOT: Record<Priority, string> = {
  P1: 'bg-p1-dot',
  P2: 'bg-p2-dot',
  P3: 'bg-p3-dot',
  P4: 'bg-p4-dot',
};

export const PRIORITY_TONE: Record<Priority, string> = {
  P1: 'bg-p1-bg text-p1-fg',
  P2: 'bg-p2-bg text-p2-fg',
  P3: 'bg-p3-bg text-p3-fg',
  P4: 'bg-p4-bg text-p4-fg',
};

export interface PriorityDotProps {
  priority: Priority;
  /** 7px in lists (default), 8px in the priority picker. */
  size?: 'sm' | 'md';
  /** Set when a visible label sits next to the dot, so screen readers don't hear it twice. */
  decorative?: boolean;
  className?: string;
}

/** Small coloured circle for P1–P4. Announced as "P1 Critical" etc. unless decorative. */
export function PriorityDot({
  priority,
  size = 'sm',
  decorative = false,
  className,
}: PriorityDotProps) {
  const t = useTranslations('common.priority');
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : t(priority)}
      aria-hidden={decorative ? true : undefined}
      className={cn(
        'inline-block shrink-0 rounded-full transition-colors duration-200 ease-out',
        size === 'md' ? 'size-2' : 'size-[7px]',
        PRIORITY_DOT[priority],
        className,
      )}
    />
  );
}

export interface PriorityPillProps {
  priority: Priority;
  /** Prefix the label with the priority dot. */
  withDot?: boolean;
  className?: string;
}

/** Tinted "P1 Critical" pill used in the team queue table. */
export function PriorityPill({ priority, withDot = false, className }: PriorityPillProps) {
  const t = useTranslations('common.priority');
  return (
    <span
      data-priority={priority}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-200 ease-out',
        PRIORITY_TONE[priority],
        className,
      )}
    >
      {withDot ? <PriorityDot priority={priority} decorative /> : null}
      {t(priority)}
    </span>
  );
}

/** Dot + muted label, as in the conversation header ("● P2 High"). */
export function PriorityLabel({ priority, className }: { priority: Priority; className?: string }) {
  const t = useTranslations('common.priority');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-ink-secondary',
        className,
      )}
    >
      <PriorityDot priority={priority} decorative />
      {t(priority)}
    </span>
  );
}
