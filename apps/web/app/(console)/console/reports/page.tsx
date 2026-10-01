import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Reports } from '@/components/console/reports/reports-page';
import { ReportsSkeleton } from '@/components/console/reports/reports-skeleton';
import { ConsolePage } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('reports') };
}

/**
 * `/console/reports?period=` — report tiles and open tickets by category (Phase 5 F10–F12). The
 * numbers load in the browser (TanStack Query + realtime + a 60 s refresh); the period is URL
 * state read with useSearchParams, hence the Suspense boundary.
 */
export default function ReportsPage() {
  return (
    <ConsolePage>
      <Suspense fallback={<ReportsSkeleton />}>
        <Reports />
      </Suspense>
    </ConsolePage>
  );
}
