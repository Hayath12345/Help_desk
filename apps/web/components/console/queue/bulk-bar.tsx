'use client';

import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { formatNumber } from '@/lib/format';
import { fadeVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';

export interface BulkBarProps {
  /** Selected rows of the current list. */
  count: number;
  /** A bulk request is running: the actions wait (they stay focusable). */
  pending: boolean;
  onAssignToMe: () => void;
  onMarkSolved: () => void;
  onClear: () => void;
}

const ACTION =
  'cursor-pointer rounded-[7px] bg-ink-inverse-muted px-3 py-1.5 text-surface transition-colors duration-150 ease-out hover:bg-ink-secondary aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-ink-inverse-muted';

/**
 * Bulk action bar (design 933–940, F6): "N selected", Assign to me, Mark solved, Clear — shown
 * while rows of the current list are selected. Plain buttons in tab order (no roving focus). The
 * selection count is announced by the page's polite status (it outlives this bar).
 */
export function BulkBar({ count, pending, onAssignToMe, onMarkSolved, onClear }: BulkBarProps) {
  const t = useTranslations('console.queue.bulk');
  const locale = useLocale();
  const n = formatNumber(count, locale);
  const guard = (action: () => void) => () => {
    if (!pending) action();
  };

  return (
    <motion.div
      role="group"
      aria-label={t('label')}
      aria-busy={pending || undefined}
      variants={fadeVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      data-bulk-bar=""
      className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-ink py-2 ps-4 pe-2.5 text-surface"
    >
      <span className="font-medium">
        {pending ? t('working', { count, n }) : t('selected', { count, n })}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        aria-disabled={pending || undefined}
        onClick={guard(onAssignToMe)}
        className={ACTION}
      >
        {t('assignToMe')}
      </button>
      <button
        type="button"
        aria-disabled={pending || undefined}
        onClick={guard(onMarkSolved)}
        className={ACTION}
      >
        {t('markSolved')}
      </button>
      <button
        type="button"
        aria-disabled={pending || undefined}
        onClick={guard(onClear)}
        className={cn(
          'cursor-pointer rounded-[7px] bg-transparent px-2.5 py-1.5 text-ink-subtle transition-colors duration-150 ease-out hover:text-surface',
          'aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:text-ink-subtle',
        )}
      >
        {t('clear')}
      </button>
    </motion.div>
  );
}
