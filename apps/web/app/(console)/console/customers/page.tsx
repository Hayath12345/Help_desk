import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, SkeletonText, shortWidth } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { ConsolePage, GridTableHeader } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('customers') };
}

/** Design 979: requester · client · contract · open · total. */
const CUSTOMER_COLUMNS =
  'grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_90px_90px]';

function CustomerRowSkeleton({ index }: { index: number }) {
  return (
    <div
      className={`grid items-center gap-2.5 border-b border-divider px-[18px] py-3 last:border-b-0 ${CUSTOMER_COLUMNS}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Skeleton className="size-[30px] shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <SkeletonText className={shortWidth(index)} />
          <SkeletonText className="w-40 max-w-full" />
        </div>
      </div>
      <SkeletonText className={shortWidth(index + 2)} />
      <Skeleton className="h-5 w-12 rounded-sm" />
      <SkeletonText className="w-5" />
      <SkeletonText className="w-5" />
    </div>
  );
}

export default async function CustomersPage() {
  const t = await getTranslations('console.customers');

  return (
    <ConsolePage>
      <PageHeader
        title={t('title')}
        description={<Skeleton className="mt-1 h-3.5 w-64 max-w-full rounded-sm" />}
      />
      <LoadingRegion label={t('loading')} className="overflow-x-auto rounded-xl border border-line bg-surface">
        <div className="min-w-[760px]">
          <GridTableHeader
            columns={CUSTOMER_COLUMNS}
            className="px-[18px]"
            labels={[
              t('columns.requester'),
              t('columns.client'),
              t('columns.contract'),
              t('columns.open'),
              t('columns.total'),
            ]}
          />
          {Array.from({ length: 6 }, (_, i) => (
            <CustomerRowSkeleton key={i} index={i} />
          ))}
        </div>
      </LoadingRegion>
    </ConsolePage>
  );
}
