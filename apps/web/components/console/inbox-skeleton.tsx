import { useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import {
  LoadingRegion,
  SkeletonText,
  TicketListRowSkeleton,
  shortWidth,
} from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The inbox's first paint (route loading state / Suspense fallback): the real three-column
 * chrome with skeleton rows, so nothing jumps when the data arrives. Server-compatible.
 */
export function InboxSkeleton() {
  const t = useTranslations('console.inbox');
  return (
    <LoadingRegion
      label={t('loadingTickets')}
      className="grid h-[calc(100dvh-60px)] grid-cols-[minmax(0,1fr)] min-[860px]:grid-cols-[320px_minmax(0,1fr)] min-[1180px]:grid-cols-[230px_340px_minmax(0,1fr)]"
    >
      <div className="hidden flex-col gap-[22px] border-e border-line bg-page px-3 py-5 min-[1180px]:flex">
        <div className="flex flex-col gap-0.5">
          <Kicker className="px-2.5 pb-2">{t('views')}</Kicker>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-[11px]">
              <SkeletonText className={cn('h-3.5', shortWidth(i))} />
              <SkeletonText className="w-4" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-0.5">
          <Kicker className="px-2.5 pb-2">{t('teams')}</Kicker>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-[11px]">
              <SkeletonText className={cn('h-3.5', shortWidth(i + 2))} />
              <SkeletonText className="w-4" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-col overflow-hidden border-line min-[860px]:border-e">
        <div className="flex items-center justify-between gap-2.5 border-b border-divider px-5 py-[18px]">
          <Skeleton className="h-5 w-28 rounded-sm" />
          <SkeletonText className="w-24" />
        </div>
        {Array.from({ length: 7 }, (_, i) => (
          <TicketListRowSkeleton key={i} index={i} />
        ))}
      </div>
      <div className="hidden bg-surface min-[860px]:block" />
    </LoadingRegion>
  );
}
