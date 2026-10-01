import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Customers } from '@/components/console/customers/customers-page';
import { CustomersSkeleton } from '@/components/console/customers/customers-skeleton';
import { ConsolePage } from '../_components/console-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('customers') };
}

/**
 * `/console/customers?q=` — client requesters with their company, contract and ticket counts
 * (Phase 5 F8). The list loads in the browser (TanStack Query + realtime); the search is URL
 * state read with useSearchParams, hence the Suspense boundary.
 */
export default function CustomersPage() {
  return (
    <ConsolePage>
      <Suspense fallback={<CustomersSkeleton />}>
        <Customers />
      </Suspense>
    </ConsolePage>
  );
}
