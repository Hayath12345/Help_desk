import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { firstNameOf } from '@/lib/format';
import { requireUser } from '@/lib/session';
import { MyTickets } from './_components/my-tickets';
import { isTicketTab } from './_components/types';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.tickets');
  return { title: t('title') };
}

/** Client "My tickets". The list itself loads in the browser (TanStack Query + realtime). */
export default async function MyTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [user, params] = await Promise.all([requireUser(['CLIENT']), searchParams]);
  const initialTab = isTicketTab(params.tab) ? params.tab : 'all';

  return <MyTickets firstName={firstNameOf(user.name)} initialTab={initialTab} />;
}
