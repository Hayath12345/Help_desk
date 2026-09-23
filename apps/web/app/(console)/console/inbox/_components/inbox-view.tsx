'use client';

import { ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Kicker } from '@/components/common/kicker';
import {
  LoadingRegion,
  SkeletonText,
  TicketListRowSkeleton,
  shortWidth,
} from '@/components/common/skeletons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fadeVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';

const INBOX_VIEWS = ['mine', 'unassigned', 'risk', 'urgent', 'open', 'solved'] as const;
type InboxViewKey = (typeof INBOX_VIEWS)[number];
type SortKey = 'sla' | 'recent';

function isInboxView(value: string): value is InboxViewKey {
  return (INBOX_VIEWS as readonly string[]).includes(value);
}

const SKELETON_ROWS = 7;
const SKELETON_TEAMS = 4;

/**
 * Agent inbox (design 707–890): Views + Teams column, ticket list sorted by SLA, conversation pane.
 * Responsive like the design: the Views column becomes a select below 1180px, and below 860px only
 * the list shows (the conversation opens full-width once tickets exist in Phase 2).
 * Phase 1 renders the real chrome with skeleton data.
 */
export function InboxView() {
  const t = useTranslations('console.inbox');
  const [view, setView] = useState<InboxViewKey>('mine');
  const [sort, setSort] = useState<SortKey>('sla');

  return (
    <div className="grid h-[calc(100dvh-60px)] grid-cols-[minmax(0,1fr)] min-[860px]:grid-cols-[320px_minmax(0,1fr)] min-[1180px]:grid-cols-[230px_340px_minmax(0,1fr)]">
      <h1 className="sr-only">{t('title')}</h1>

      {/* Views + Teams */}
      <aside className="hidden flex-col gap-[22px] overflow-auto border-e border-line bg-page px-3 py-5 min-[1180px]:flex">
        <nav aria-label={t('views')} className="flex flex-col gap-0.5">
          <Kicker as="h2" className="px-2.5 pb-2">
            {t('views')}
          </Kicker>
          {INBOX_VIEWS.map((key) => {
            const active = key === view;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setView(key)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-[9px] text-start text-[15px] whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-out',
                  active ? 'bg-surface text-ink shadow-segment' : 'text-ink-secondary hover:bg-surface hover:text-ink',
                )}
              >
                <span className="truncate">{t(`view.${key}`)}</span>
                <Skeleton className="h-3 w-4 shrink-0 rounded-sm" />
              </button>
            );
          })}
        </nav>

        <section aria-label={t('teams')} className="flex flex-col gap-0.5">
          <Kicker as="h2" className="px-2.5 pb-2">
            {t('teams')}
          </Kicker>
          <LoadingRegion label={t('loadingTeams')} className="flex flex-col gap-0.5">
            {Array.from({ length: SKELETON_TEAMS }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-[11px]">
                <SkeletonText className={cn('h-3.5', shortWidth(i + 2))} />
                <SkeletonText className="w-4" />
              </div>
            ))}
          </LoadingRegion>
        </section>
      </aside>

      {/* Ticket list */}
      <section
        aria-label={t('listLabel')}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden border-line min-[860px]:border-e"
      >
        <div className="flex items-center justify-between gap-2.5 border-b border-divider px-5 py-[18px]">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold whitespace-nowrap text-ink max-[1180px]:hidden">
            {t(`view.${view}`)}
            <Skeleton className="h-3 w-5 rounded-sm" />
          </h2>
          <div className="min-w-0 flex-1 min-[1180px]:hidden">
            <Select value={view} onValueChange={(value) => isInboxView(value) && setView(value)}>
              <SelectTrigger
                size="sm"
                aria-label={t('chooseView')}
                className="max-w-full border-line text-[15px] font-semibold"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {INBOX_VIEWS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {t(`view.${key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            onClick={() => setSort((current) => (current === 'sla' ? 'recent' : 'sla'))}
            title={t('sort.label')}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[13px] whitespace-nowrap text-ink-muted transition-colors hover:text-ink"
          >
            {t(`sort.${sort}`)}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </button>
        </div>

        <LoadingRegion label={t('loadingTickets')} className="min-h-0 flex-1 overflow-auto">
          <motion.div key={`${view}:${sort}`} variants={fadeVariants} initial="hidden" animate="visible">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TicketListRowSkeleton key={i} index={i} />
            ))}
          </motion.div>
        </LoadingRegion>
      </section>

      {/* Conversation */}
      <section className="hidden min-w-0 place-items-center overflow-y-auto bg-surface p-10 text-center text-ink-muted min-[860px]:grid">
        <p>{t('selectTicket')}</p>
      </section>
    </div>
  );
}
