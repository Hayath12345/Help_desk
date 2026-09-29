import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Inbox } from '@/components/console/inbox';
import { InboxSkeleton } from '@/components/console/inbox-skeleton';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('inbox') };
}

/** `/console/inbox?view=&team=&ticket=&q=` — the whole inbox is URL state (components/console). */
export default function InboxPage() {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <Inbox />
    </Suspense>
  );
}
