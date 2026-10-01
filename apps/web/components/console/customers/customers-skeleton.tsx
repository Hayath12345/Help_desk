'use client';

import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { CustomerRowSkeleton, CustomersTableHeader } from './customers-table';

/** The Customers page while its route or URL state loads (the real page's grid, no spinner). */
export function CustomersSkeleton() {
  const t = useTranslations('console.customers');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={<Skeleton className="mt-1 h-3.5 w-64 max-w-full rounded-sm" />}
      />
      <Skeleton className="h-10 w-full max-w-[420px] rounded-md" />
      <LoadingRegion
        label={t('loading')}
        className="overflow-hidden rounded-xl border border-line bg-surface"
      >
        <div role="table" aria-label={t('title')}>
          <CustomersTableHeader />
          <div role="rowgroup">
            {Array.from({ length: 6 }, (_, i) => (
              <CustomerRowSkeleton key={i} index={i} />
            ))}
          </div>
        </div>
      </LoadingRegion>
    </>
  );
}
