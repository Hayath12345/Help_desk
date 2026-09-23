import type { TicketStatus } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/** Token classes per ticket status (background + text). Reused by segmented status controls. */
export const STATUS_TONE: Record<TicketStatus, string> = {
  NEW: 'bg-status-new-bg text-status-new-fg',
  OPEN: 'bg-status-open-bg text-status-open-fg',
  PENDING: 'bg-status-pending-bg text-status-pending-fg',
  SOLVED: 'bg-status-solved-bg text-status-solved-fg',
  CLOSED: 'bg-status-closed-bg text-status-closed-fg',
};

export interface StatusPillProps {
  status: TicketStatus;
  /** `default`: 6px radius (lists, headers). `round`: full pill (queue table). */
  shape?: 'default' | 'round';
  className?: string;
}

/**
 * Coloured ticket status label. The element is stable across status changes, so the colour
 * change animates through a 200 ms CSS transition (disabled under prefers-reduced-motion).
 */
export function StatusPill({ status, shape = 'default', className }: StatusPillProps) {
  const t = useTranslations('common.status');
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-200 ease-out',
        shape === 'round' ? 'rounded-full px-[9px]' : 'rounded-sm px-2',
        STATUS_TONE[status],
        className,
      )}
    >
      {t(status)}
    </span>
  );
}
