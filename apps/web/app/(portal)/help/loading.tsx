import { getTranslations } from 'next-intl/server';
import { LoadingRegion, SkeletonRows } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown while the help center renders: title, search box and article rows. */
export default async function HelpCenterLoading() {
  const t = await getTranslations('common');
  return (
    <LoadingRegion label={t('loading')} className="flex flex-col gap-[18px]">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-11 w-full rounded-lg" />
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <SkeletonRows rows={4} rowClassName="py-5" />
      </div>
    </LoadingRegion>
  );
}
