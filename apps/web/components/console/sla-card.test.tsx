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

  it('turns amber at the stored at-risk instant, then red and full when overdue', () => {
    // At risk from 12:11:15 (75 % of the 15-minute window, stored by the API), not before.
    expect(slaCardModel(makeDetail(), Date.parse('2026-09-23T12:11:14.999Z')).tone).toBe('ok');
    expect(slaCardModel(makeDetail(), Date.parse('2026-09-23T12:11:15.000Z')).tone).toBe('risk');
    // The instant decides, not the time left (no calendar maths in the browser, D2).
    expect(
      slaCardModel(makeDetail({ firstReplyAtRiskAt: '2026-09-23T12:05:00.000Z' }), NOW).tone,
    ).toBe('risk');
    expect(
      slaCardModel(makeDetail({ firstReplyAtRiskAt: null }), Date.parse('2026-09-23T12:14:00.000Z'))
        .tone,
    ).toBe('ok');
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

describe('slaCardModel per-target flags (D1/D16)', () => {
  // First reply due 12:15 (at risk 12:11:15), resolution due 16:00 (at risk 15:00).
  const at = (iso: string) => Date.parse(`2026-09-23T${iso}Z`);

  it('flags the first reply at risk from its stored instant, breached once overdue', () => {
    expect(slaCardModel(makeDetail(), at('12:11:14.999')).firstReplyFlag).toBeNull();
    expect(slaCardModel(makeDetail(), at('12:11:15.000')).firstReplyFlag).toBe('atRisk');
    expect(slaCardModel(makeDetail(), at('12:15:00.001')).firstReplyFlag).toBe('breached');
    // Unknown instant: never at risk, still breached from the due date.
    const unknown = makeDetail({ firstReplyAtRiskAt: null });
    expect(slaCardModel(unknown, at('12:14:00.000')).firstReplyFlag).toBeNull();
    expect(slaCardModel(unknown, at('12:16:00.000')).firstReplyFlag).toBe('breached');
  });

  it('keeps a late first reply breached after it was sent; an on-time one has no flag', () => {
    const late = makeDetail({ firstRepliedAt: '2026-09-23T12:20:00.000Z' });
    expect(slaCardModel(late, at('12:30:00.000')).firstReplyFlag).toBe('breached');
    const onTime = makeDetail({ firstRepliedAt: '2026-09-23T12:14:00.000Z' });
    expect(slaCardModel(onTime, at('12:30:00.000')).firstReplyFlag).toBeNull();
  });

  it('flags the running resolution target at risk, then breached', () => {
    const replied = makeDetail({ firstRepliedAt: '2026-09-23T12:05:00.000Z' });
    expect(slaCardModel(replied, at('14:59:59.999')).resolutionFlag).toBeNull();
    expect(slaCardModel(replied, at('15:00:00.000')).resolutionFlag).toBe('atRisk');
    expect(slaCardModel(replied, at('16:00:00.001')).resolutionFlag).toBe('breached');
  });

  it('judges a stopped resolution clock by when it stopped (solved, or paused while PENDING)', () => {
    const base = { firstRepliedAt: '2026-09-23T12:05:00.000Z' };
    const solvedLate = makeDetail({
      ...base,
      status: 'SOLVED',
      solvedAt: '2026-09-23T16:30:00.000Z',
    });
    expect(slaCardModel(solvedLate, at('18:00:00.000')).resolutionFlag).toBe('breached');
    const solvedInTime = makeDetail({
      ...base,
      status: 'SOLVED',
      solvedAt: '2026-09-23T15:30:00.000Z',
    });
    expect(slaCardModel(solvedInTime, at('18:00:00.000')).resolutionFlag).toBeNull();
    // Paused at 14:00, before the due date: not breached however long the client takes.
    const paused = makeDetail({
      ...base,
      status: 'PENDING',
      slaPausedAt: '2026-09-23T14:00:00.000Z',
    });
    expect(slaCardModel(paused, at('18:00:00.000')).resolutionFlag).toBeNull();
    const pausedLate = makeDetail({
      ...base,
      status: 'PENDING',
      slaPausedAt: '2026-09-23T16:10:00.000Z',
    });
    expect(slaCardModel(pausedLate, at('18:00:00.000')).resolutionFlag).toBe('breached');
  });

  it("says the API's sticky breach flag only when the dates don't show a breach", () => {
    const replied = { firstRepliedAt: '2026-09-23T12:05:00.000Z' };
    expect(
      slaCardModel(makeDetail({ ...replied, slaBreached: true }), at('13:00:00.000')),
    ).toMatchObject({ breachedEarlier: true, firstReplyFlag: null, resolutionFlag: null });
    expect(
      slaCardModel(makeDetail({ slaBreached: true }), at('12:20:00.000')).breachedEarlier,
    ).toBe(false);
    expect(slaCardModel(makeDetail(), at('13:00:00.000')).breachedEarlier).toBe(false);
  });
});

describe('SlaCard per-target states', () => {
  it('shows an At risk pill beside the first-reply countdown', () => {
    renderCard(makeDetail({ firstReplyAtRiskAt: '2026-09-23T12:05:00.000Z' }));
    const pill = document.querySelector('[data-sla-flag]');
    expect(pill?.getAttribute('data-sla-flag')).toBe('atRisk');
    expect(pill?.textContent).toBe('At risk');
  });

  it('shows Breached for a late first reply and an amber resolution line at risk', () => {
    renderCard(
      makeDetail({
        firstRepliedAt: '2026-09-23T12:01:00.000Z',
        firstReplyDueAt: '2026-09-23T12:00:30.000Z',
        resolveAtRiskAt: '2026-09-23T12:06:00.000Z',
      }),
    );
    expect(document.querySelector('[data-sla-flag]')?.textContent).toBe('Breached');
    const line = document.querySelector('[data-sla-resolution="risk"]');
    expect(line?.className).toContain('text-p2-fg');
    expect(line?.textContent).toBe(' · 3h 54m left · at risk');
  });

  it('says a solved ticket missed its resolution target, and a sticky breach', () => {
    renderCard(
      makeDetail({
        status: 'SOLVED',
        firstRepliedAt: '2026-09-23T12:05:00.000Z',
        resolveDueAt: '2026-09-23T12:03:00.000Z',
        solvedAt: '2026-09-23T12:04:00.000Z',
      }),
    );
    expect(document.querySelector('[data-sla-resolution="breached"]')?.textContent).toBe(
      ' · breached',
    );
    cleanup();
    renderCard(makeDetail({ firstRepliedAt: '2026-09-23T12:05:00.000Z', slaBreached: true }), 'ar');
    expect(document.querySelector('[data-sla-resolution="breached-earlier"]')?.textContent).toBe(
      ' · تم تجاوز أحد أهداف مهلة الخدمة',
    );
  });

  it('labels the pills in Arabic', () => {
    renderCard(makeDetail({ firstReplyAtRiskAt: '2026-09-23T12:05:00.000Z' }), 'ar');
    expect(document.querySelector('[data-sla-flag]')?.textContent).toBe('معرضة للخطر');
  });
});
