import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Placeholder with the thread page's geometry (back link, header, two messages, composer), so
 * nothing jumps when the ticket arrives. Server-compatible (no hooks): used by loading.tsx and by
 * the client page while the ticket loads.
 */
export function TicketPageSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="flex flex-col gap-[18px]">
      <SkeletonText className="h-3.5 w-24" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <SkeletonText className="w-96 max-w-full" />
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-6 w-[26rem] max-w-full" />
            <Skeleton className="h-5 w-12 shrink-0 rounded-sm" />
          </div>
          <SkeletonText className="w-64 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
      <div className="flex flex-col gap-[18px]">
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex items-center gap-2">
                <SkeletonText className="w-28" />
                <SkeletonText className="w-12" />
                <SkeletonText className="w-20" />
              </div>
              <Skeleton className={cn('h-16 rounded-lg', i === 0 ? 'w-full' : 'w-3/4')} />
            </div>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="h-[106px]" />
        <div className="flex items-center justify-between gap-3 border-t border-divider px-3 py-2.5">
          <SkeletonText className="w-56 max-w-[50%]" />
          <Skeleton className="h-[34px] w-24 rounded-md" />
        </div>
      </div>
    </LoadingRegion>
  );
}
