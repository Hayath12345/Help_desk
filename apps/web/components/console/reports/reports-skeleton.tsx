'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { CategoryBarsSkeleton, ReportTilesSkeleton } from './report-tiles';

/** The Reports page while its route or URL state loads (the real page's grid, no spinner). */
export function ReportsSkeleton() {
  const t = useTranslations('console.reports');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={<Skeleton className="mt-1 h-3.5 w-24 rounded-sm" />}
        actions={<Skeleton className="h-9 w-72 max-w-full rounded-lg" />}
      />
      <LoadingRegion label={t('loading')} className="flex flex-col gap-[22px]">
        <ReportTilesSkeleton />
        <CategoryBarsSkeleton />
      </LoadingRegion>
    </>
  );
}
