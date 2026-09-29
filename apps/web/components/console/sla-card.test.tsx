// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDetail } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enTickets from '@/messages/en/tickets.json';
import { SlaCard, slaCardModel } from './sla-card';

afterEach(cleanup);

// Created 12:00, first reply due 12:15, resolution due 16:00 (P1: 15 min / 4 h).
const NOW = Date.parse('2026-09-23T12:06:00.000Z');

function renderCard(ticket = makeDetail(), locale: 'en' | 'ar' = 'en') {
  const messages =
    locale === 'en'
      ? { common: enCommon, console: enConsole, tickets: enTickets }
      : { common: arCommon, console: arConsole, tickets: arTickets };
  return render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Qatar"
      now={new Date(NOW)}
      messages={messages}
    >
      <SlaCard ticket={ticket} />
    </NextIntlClientProvider>,
  );
}

describe('slaCardModel', () => {
  it('counts down to the first reply with the remaining share of the window', () => {
    const model = slaCardModel(makeDetail(), NOW);
    expect(model.kicker).toBe('firstReplyDue');
    expect(model.value).toEqual({ kind: 'countdown', ms: 9 * 60_000, overdue: false });
    expect(model.tone).toBe('ok');
    expect(model.percent).toBeCloseTo(60);
  });

  it('turns amber, then red and full when overdue', () => {
    expect(slaCardModel(makeDetail(), Date.parse('2026-09-23T12:10:00.000Z')).tone).toBe('risk');
    const overdue = slaCardModel(makeDetail(), Date.parse('2026-09-23T12:20:00.000Z'));
    expect(overdue.tone).toBe('overdue');
    expect(overdue.value).toEqual({ kind: 'countdown', ms: 5 * 60_000, overdue: true });
    expect(overdue.percent).toBe(100);
  });

  it('shows Replied (with the resolution clock), Paused and the done status', () => {
    const replied = slaCardModel(makeDetail({ firstRepliedAt: '2026-09-23T12:05:00.000Z' }), NOW);
    expect(replied.kicker).toBe('firstReply');
    expect(replied.value).toEqual({ kind: 'replied' });
    expect(replied.resolution?.remainingMs).toBe(234 * 60_000);
    const paused = slaCardModel(
      makeDetail({ status: 'PENDING', firstRepliedAt: '2026-09-23T12:05:00.000Z' }),
      NOW,
    );
    expect(paused.value).toEqual({ kind: 'paused' });
    expect(paused.resolutionPaused).toBe(true);
    expect(replied.resolutionPaused).toBe(false);
    expect(slaCardModel(makeDetail({ status: 'SOLVED' }), NOW).value).toEqual({
      kind: 'done',
      status: 'SOLVED',
    });
  });

  it('keeps the first-reply countdown of an unanswered PENDING ticket (resolution paused)', () => {
    const model = slaCardModel(makeDetail({ status: 'PENDING' }), NOW);
    expect(model.kicker).toBe('firstReplyDue');
    expect(model.value).toEqual({ kind: 'countdown', ms: 9 * 60_000, overdue: false });
    expect(model.resolutionPaused).toBe(true);
    expect(model.resolution).toBeNull();
  });
});

describe('SlaCard', () => {
  it('renders the design card: kicker, window, countdown, bar and resolution target', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'First reply due' })).toBeTruthy();
    expect(screen.getByText('15 min')).toBeTruthy();
    expect(screen.getByText('First reply due in 9m')).toBeTruthy();
    expect(screen.getByText('Resolution target: 4 hours')).toBeTruthy();
    const value = document.querySelector('[data-sla]');
    expect(value?.getAttribute('data-sla')).toBe('ok');
    expect(value?.className).toContain('text-success');
  });

  it('says the resolution clock is paused while the first-reply countdown runs', () => {
    renderCard(makeDetail({ status: 'PENDING' }));
    expect(screen.getByRole('heading', { name: 'First reply due' })).toBeTruthy();
    expect(screen.getByText('First reply due in 9m')).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === 'Resolution target: 4 hours · paused while waiting on the client',
      ),
    ).toBeTruthy();
  });

  it('adds the resolution countdown once replied, in Arabic too', () => {
    renderCard(makeDetail({ firstRepliedAt: '2026-09-23T12:05:00.000Z' }), 'ar');
    expect(screen.getByRole('heading', { name: 'الرد الأول' })).toBeTruthy();
    expect(screen.getByText(/هدف الحل: 4 ساعات/)).toBeTruthy();
    expect(screen.getByText(/متبقٍ/)).toBeTruthy();
  });
});
