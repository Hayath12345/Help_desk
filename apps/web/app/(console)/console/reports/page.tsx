import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Kicker } from '@/components/common/kicker';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, SkeletonText, shortWidth } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { ConsolePage } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('reports') };
}

const REPORT_TILES = ['open', 'p1Open', 'breached', 'unassigned', 'solved'] as const;
/** Deterministic bar lengths for the "by category" placeholder. */
const BAR_WIDTHS = ['w-4/5', 'w-3/5', 'w-2/5', 'w-1/3', 'w-1/5', 'w-1/6'] as const;

export default async function ReportsPage() {
  const t = await getTranslations('console.reports');

  return (
    <ConsolePage>
      <PageHeader title={t('title')} />
      <LoadingRegion label={t('loading')} className="flex flex-col gap-[22px]">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
          {REPORT_TILES.map((key) => (
            <div
              key={key}
              className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-[18px]"
            >
              <Kicker as="h2">{t(`tiles.${key}`)}</Kicker>
              <Skeleton className="h-[30px] w-12 rounded-sm" />
            </div>
          ))}
        </div>

        <section className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface p-5">
          <h2 className="text-[15px] font-semibold text-ink">{t('byCategory')}</h2>
          {BAR_WIDTHS.map((width, i) => (
            <div
              key={width}
              className="grid grid-cols-[minmax(120px,260px)_minmax(0,1fr)_30px] items-center gap-3"
            >
              <SkeletonText className={shortWidth(i + 1)} />
              <div className="h-2 overflow-hidden rounded-sm bg-surface-sunken">
                <Skeleton className={`h-full rounded-sm ${width}`} />
              </div>
              <SkeletonText className="ms-auto w-4" />
            </div>
          ))}
        </section>
      </LoadingRegion>
    </ConsolePage>
  );
}
