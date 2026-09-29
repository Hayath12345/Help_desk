import { getTranslations } from 'next-intl/server';
import { TicketPageSkeleton } from './_components/ticket-page-skeleton';

/** Shown while the thread page renders: the same geometry as the loaded page. */
export default async function TicketLoading() {
  const t = await getTranslations('portal.ticket');
  return <TicketPageSkeleton label={t('loading')} />;
}
