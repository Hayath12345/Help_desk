import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { InboxView } from './_components/inbox-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('console.nav');
  return { title: t('inbox') };
}

export default function InboxPage() {
  return <InboxView />;
}
