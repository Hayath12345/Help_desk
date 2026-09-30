// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import type { TicketSummaryDto } from '@loons/shared';
import { TEAMS, makeSummary } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arPortal from '@/messages/ar/portal.json';
import enCommon from '@/messages/en/common.json';
import enPortal from '@/messages/en/portal.json';
import { TicketHeader } from './ticket-header';

// Decision E6: the portal header keeps showing a category, sub-type, site or team archived since
// the ticket was raised, marked "(archived)".

afterEach(cleanup);

function renderHeader(ticket: TicketSummaryDto, locale: 'en' | 'ar' = 'en') {
  const messages =
    locale === 'en'
      ? { common: enCommon, portal: enPortal }
      : { common: arCommon, portal: arPortal };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={messages}>
        <TicketHeader ticket={ticket} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const archived = (): TicketSummaryDto => {
  const ticket = makeSummary();
  return {
    ...ticket,
    category: { ...ticket.category, isActive: false },
    subtype: ticket.subtype ? { ...ticket.subtype, isActive: false } : null,
    site: ticket.site ? { ...ticket.site, isActive: false } : null,
    team: { ...TEAMS.elv, isActive: false },
  };
};

describe('TicketHeader with archived config (E6)', () => {
  it('marks archived items and keeps their names', () => {
    const ticket = archived();
    const { container } = renderHeader(ticket);
    const path = container.querySelector('p')?.textContent ?? '';
    expect(path).toContain(
      `${ticket.category.labelEn} (archived) › ${ticket.subtype?.labelEn} (archived)`,
    );
    expect(path).toContain(`${ticket.site?.name} (archived)`);
    expect(screen.getByText(/Handled by/).textContent).toContain('ELV Field (archived)');
  });

  it('shows active items without a marker', () => {
    renderHeader(makeSummary());
    expect(document.body.textContent).not.toContain('(archived)');
  });

  it('Arabic marker in the Arabic UI', () => {
    renderHeader(archived(), 'ar');
    expect(document.body.textContent).toContain('(مؤرشف)');
  });
});
