'use client';

import type { TicketDetailDto } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import { InitialsAvatar } from '@/components/common/initials-avatar';
import { Kicker } from '@/components/common/kicker';
import { ContractBadge } from '@/components/tickets/org-chip';
import { formatDate, formatNumber, initialsFrom } from '@/lib/format';
import { placeName } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import { focusInboxList } from './inbox-focus';
import { INBOX_PATH, inboxHref, updateInboxUrl } from './inbox-url';
import { isPlainClick } from './views-sidebar';

/**
 * Opens the company view in place when the card is in the Inbox (a plain click): the list shows
 * every ticket of the organisation; the view underneath is kept for "Clear", the search and the
 * open ticket are dropped (design 1670: `view: 'co:' + client, selectedId: null`), and with it
 * this link, so the focus moves to the list. Anywhere else, or a new-tab click, the link navigates.
 */
function openCompanyView(orgId: string, event: React.MouseEvent<HTMLAnchorElement>) {
  if (!isPlainClick(event) || window.location.pathname !== INBOX_PATH) return;
  event.preventDefault();
  updateInboxUrl({ orgId, teamId: null, ticket: null, q: '' }, 'push');
  focusInboxList();
}

/**
 * Requester card (design 867–881): the client contact, their organisation, contract (AMC /
 * Billable), AMC expiry, sites covered, account manager and how many other tickets the client
 * has raised — a link to the Inbox company view ("N from this client", "View client" when none).
 */
export function RequesterCard({
  ticket,
  className,
}: {
  ticket: Pick<TicketDetailDto, 'requester' | 'requesterCard'>;
  className?: string;
}) {
  const t = useTranslations('console.requester');
  const locale = useLocale();
  const titleId = useId();
  const { requester, requesterCard: card } = ticket;
  const none = t('none');

  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex flex-col gap-3.5 border-t border-divider pt-5', className)}
    >
      <Kicker as="h3" id={titleId}>
        {t('title')}
      </Kicker>
      <div className="flex min-w-0 items-center gap-3">
        <InitialsAvatar initials={initialsFrom(requester.name) || '?'} variant="track" size="xl" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold text-ink">{requester.name}</span>
          <a
            href={`mailto:${requester.email}`}
            dir="ltr"
            className="truncate text-start text-[13px] text-ink-muted no-underline hover:text-ink hover:underline rtl:text-end"
          >
            {requester.email}
          </a>
        </div>
      </div>
      <dl className="grid grid-cols-[118px_minmax(0,1fr)] items-center gap-x-3 gap-y-[9px] text-sm">
        <dt className="text-ink-muted">{t('client')}</dt>
        <dd className="min-w-0 truncate text-ink">{placeName(card.org, locale)}</dd>
        <dt className="text-ink-muted">{t('contract')}</dt>
        <dd>
          <ContractBadge
            contract={card.org.contractType}
            className="rounded-sm px-2 text-xs font-semibold"
          />
        </dd>
        <dt className="text-ink-muted">{t('amcExpiry')}</dt>
        <dd className="text-ink">
          {card.org.amcExpiry ? (
            <time dateTime={card.org.amcExpiry}>
              {formatDate(`${card.org.amcExpiry}T12:00:00Z`, locale)}
            </time>
          ) : (
            none
          )}
        </dd>
        <dt className="text-ink-muted">{t('sitesCovered')}</dt>
        <dd className="text-ink">
          {t('sites', { count: card.sitesCount, n: formatNumber(card.sitesCount, locale) })}
        </dd>
        <dt className="text-ink-muted">{t('accountManager')}</dt>
        <dd className="min-w-0 truncate text-ink">{card.accountManager?.name ?? none}</dd>
        <dt className="text-ink-muted">{t('otherTickets')}</dt>
        <dd className="min-w-0">
          {/* Design 879: a link-styled control to the Inbox company view (Phase 5 F9). */}
          <a
            href={inboxHref({ orgId: card.org.id })}
            onClick={(event) => openCompanyView(card.org.id, event)}
            data-company-link=""
            className="text-brand-ink no-underline hover:underline"
          >
            {t('others', {
              count: card.otherTicketsCount,
              n: formatNumber(card.otherTicketsCount, locale),
            })}
          </a>
        </dd>
      </dl>
    </section>
  );
}
