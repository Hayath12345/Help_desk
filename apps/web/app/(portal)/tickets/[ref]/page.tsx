import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/session';
import { canonicalTicketRef } from '../_components/types';
import { TicketPage } from './_components/ticket-page';

interface TicketPageProps {
  params: Promise<{ ref: string }>;
}

export async function generateMetadata({ params }: TicketPageProps): Promise<Metadata> {
  const { ref } = await params;
  const canonical = canonicalTicketRef(ref);
  if (canonical?.startsWith('LG-')) return { title: canonical };
  const t = await getTranslations('portal.ticket');
  return { title: canonical ? t('loading') : t('notFoundTitle') };
}

/**
 * `/tickets/LG-4771` (also `/tickets/4771` or the ticket uuid). The thread loads in the browser
 * (TanStack Query + the ticket's realtime room); anything that can't be a ticket reference 404s
 * here without asking the API.
 */
export default async function TicketThreadPage({ params }: TicketPageProps) {
  const [, { ref }] = await Promise.all([requireUser(['CLIENT']), params]);
  const canonical = canonicalTicketRef(ref);
  if (!canonical) notFound();
  return <TicketPage key={canonical} ticketRef={canonical} />;
}
