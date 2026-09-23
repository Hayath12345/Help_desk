import { getTranslations } from 'next-intl/server';
import { LoadingRegion, SkeletonRows, SkeletonText } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown while an admin page renders (the section nav in the layout stays interactive). */
export default async function AdminLoading() {
  const t = await getTranslations('common');
  return (
    <LoadingRegion label={t('loading')} className="flex flex-col gap-[22px]">
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-7 w-48" />
        <SkeletonText className="h-3.5 w-80 max-w-full" />
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <SkeletonRows rows={5} />
      </div>
    </LoadingRegion>
  );
}
