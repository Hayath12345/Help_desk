import { ChevronDown } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, SkeletonText, lineWidth, shortWidth } from '@/components/common/skeletons';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConsolePage, GridTableHeader } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('queue') };
}

const QUEUE_TABS = ['open', 'unassigned', 'breaching', 'solved'] as const;
const QUEUE_FILTERS = ['priority', 'category', 'assignee'] as const;
/** Design 915: checkbox · priority · ticket · requester · first-reply SLA · assignee · status. */
const QUEUE_COLUMNS = 'grid-cols-[52px_120px_minmax(0,1fr)_190px_190px_140px_100px]';

function AgentCardSkeleton({ index }: { index: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-[18px] py-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <SkeletonText className={shortWidth(index)} />
          <SkeletonText className="w-16" />
        </div>
        <Skeleton className="h-6 w-5 rounded-sm" />
      </div>
      <Skeleton className="h-1 w-full rounded-full" />
      <SkeletonText className="w-32" />
    </div>
  );
}

function QueueRowSkeleton({ index }: { index: number }) {
  return (
    <div
      className={`grid items-center gap-2.5 border-b border-divider py-3 ps-[18px] pe-4 last:border-b-0 ${QUEUE_COLUMNS}`}
    >
      <Skeleton className="size-4 rounded-[4px]" />
      <Skeleton className="h-5 w-[72px] rounded-sm" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <SkeletonText className={`h-3.5 ${lineWidth(index)}`} />
        <SkeletonText className="w-32" />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <SkeletonText className={shortWidth(index + 1)} />
        <SkeletonText className="w-20" />
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonText className="w-14" />
        <Skeleton className="h-[3px] w-full rounded-full" />
      </div>
      <SkeletonText className={shortWidth(index + 3)} />
      <Skeleton className="h-5 w-16 rounded-full" />
    </div>
  );
}

export default async function TeamQueuePage() {
  const t = await getTranslations('console.queue');

  const table = (
    <LoadingRegion label={t('loading')} className="overflow-x-auto rounded-xl border border-line bg-surface">
      <div className="min-w-[980px]">
        <GridTableHeader
          columns={QUEUE_COLUMNS}
          className="ps-[18px] pe-4"
          labels={[
            '',
            t('columns.priority'),
            t('columns.ticket'),
            t('columns.requester'),
            t('columns.firstReplySla'),
            t('columns.assignee'),
            t('columns.status'),
          ]}
        />
        {Array.from({ length: 6 }, (_, i) => (
          <QueueRowSkeleton key={i} index={i} />
        ))}
      </div>
    </LoadingRegion>
  );

  return (
    <ConsolePage>
      <PageHeader
        className="items-start"
        title={t('title')}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {t('allTeams')}
            <span aria-hidden="true">·</span>
            <Skeleton className="h-3.5 w-5 rounded-sm" />
            {t('unassigned')}
          </span>
        }
        descriptionClassName="text-[15px] text-ink-secondary"
        actions={<NewTicketButton size="lg" className="text-[15px]" />}
      />

      <section
        aria-label={t('agentsLabel')}
        aria-busy="true"
        className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5"
      >
        {Array.from({ length: 4 }, (_, i) => (
          <AgentCardSkeleton key={i} index={i} />
        ))}
      </section>

      <Tabs defaultValue="open" className="gap-[22px]">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line">
          <TabsList variant="line" aria-label={t('tabsLabel')} className="gap-[22px] border-b-0">
            {QUEUE_TABS.map((key) => (
              <TabsTrigger key={key} value={key} className="pb-2.5! text-[15px]">
                {t(`tabs.${key}`)}
                <Skeleton className="h-2.5 w-3 rounded-sm" />
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex flex-wrap gap-1.5 pb-2">
            {QUEUE_FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                disabled
                className="inline-flex items-center gap-1 rounded-sm border border-transparent px-1 py-[3px] text-sm text-ink-secondary disabled:cursor-default disabled:opacity-60"
              >
                {t(`filters.${key}`)}
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </button>
            ))}
          </div>
        </div>
        {QUEUE_TABS.map((key) => (
          <TabsContent key={key} value={key} className="rounded-xl">
            {table}
          </TabsContent>
        ))}
      </Tabs>
    </ConsolePage>
  );
}
