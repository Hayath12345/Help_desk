import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { QueueSkeleton } from '@/components/console/queue/queue-skeleton';
import { TeamQueue } from '@/components/console/queue/team-queue';
import { ConsolePage } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('queue') };
}

/**
 * `/console/queue?tab=&priority=&category=&assignee=&q=` — the Team queue (docs/PHASE5_CONTRACT.md
 * F2–F7). Its state lives in the URL and is read on the client (`useSearchParams`, hence the
 * Suspense boundary); the data comes from the API through TanStack Query (lib/queue).
 */
export default function TeamQueuePage() {
  return (
    <ConsolePage>
      <Suspense fallback={<QueueSkeleton />}>
        <TeamQueue />
      </Suspense>
    </ConsolePage>
  );
}
