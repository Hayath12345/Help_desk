import { getTranslations } from 'next-intl/server';
import { LoadingRegion, PortalTicketRowSkeleton, SkeletonText } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown while "My tickets" renders: same header/tabs/card geometry as the real page. */
export default async function MyTicketsLoading() {
  const t = await getTranslations('portal.tickets');
  return (
    <LoadingRegion label={t('loading')} className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-7 w-40" />
          <SkeletonText className="h-3.5 w-72 max-w-full" />
        </div>
        <div className="flex gap-5 border-b border-line pb-2.5">
          <SkeletonText className="h-3.5 w-10" />
          <SkeletonText className="h-3.5 w-14" />
          <SkeletonText className="h-3.5 w-14" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {Array.from({ length: 4 }, (_, i) => (
          <PortalTicketRowSkeleton key={i} index={i} />
        ))}
      </div>
    </LoadingRegion>
  );
}
