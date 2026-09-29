// @vitest-environment jsdom
import type { AcknowledgeTicketResponse, TicketDetailDto } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { ticketKeys } from '@/lib/tickets/keys';
import { useTicket } from '@/lib/tickets/queries';
import { IDS, makeDetail, makeSummary } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import { P1Banner, isUnacknowledgedP1, p1BannerModel } from './p1-banner';
import { TicketRow } from './ticket-row';

const api = vi.hoisted(() => ({
  calls: [] as { method: string; path: string }[],
  /** The next acknowledge answer (or error), resolved when `release()` is called if held. */
  answer: null as null | (() => unknown),
  hold: false,
  release: null as null | (() => void),
}));
vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      throw new ApiRequestError(404, 'NOT_FOUND', 'not in this test');
    }),
    post: vi.fn(async (path: string) => {
      api.calls.push({ method: 'POST', path });
      if (api.hold) await new Promise<void>((resolve) => (api.release = resolve));
      return api.answer?.();
    }),
  },
  getApiToken: vi.fn(async () => 'token'),
  clearApiToken: vi.fn(),
}));

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// Created 12:00 as P1; now 12:07.
const NOW = new Date('2026-09-23T12:07:00.000Z');
const MESSAGES = {
  en: { common: enCommon, console: enConsole, errors: enErrors, tickets: enTickets },
  ar: { common: arCommon, console: arConsole, errors: arErrors, tickets: arTickets },
};

beforeEach(() => {
  api.calls = [];
  api.answer = null;
  api.hold = false;
  api.release = null;
  toast.mockReset();
});
afterEach(cleanup);

const acked = (overrides: Partial<TicketDetailDto> = {}): TicketDetailDto =>
  makeDetail({
    p1AckedAt: '2026-09-23T12:08:00.000Z',
    p1AckedBy: { id: IDS.staff, name: 'Maya Ruiz' },
    p1EscalationStep: 1,
    updatedAt: '2026-09-23T12:08:00.000Z',
    ...overrides,
  });

/** The banner as the conversation shows it: from the cached ticket detail. */
function Harness() {
  const ticket = useTicket('LG-4771');
  return ticket.data ? (
    <>
      <h2 id="conversation-heading" tabIndex={-1}>
        Heading
      </h2>
      <button type="button">before</button>
      <P1Banner ticket={ticket.data} focusFallbackId="conversation-heading" />
    </>
  ) : null;
}

function renderBanner(detail: TicketDetailDto, locale: 'en' | 'ar' = 'en') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(ticketKeys.detail('LG-4771'), detail);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        now={NOW}
        messages={MESSAGES[locale]}
      >
        <Harness />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe('p1BannerModel', () => {
  const now = NOW.getTime();

  it('shows nothing for other priorities', () => {
    expect(p1BannerModel(makeSummary({ priority: 'P2' }), now)).toBeNull();
    expect(isUnacknowledgedP1(makeSummary({ priority: 'P2' }))).toBe(false);
  });

  it('an unacknowledged P1: the step fired so far and the time since it became P1', () => {
    // A list row (no chain): the step only.
    expect(p1BannerModel(makeSummary({ p1EscalationStep: 2 }), now)).toEqual({
      kind: 'unacknowledged',
      step: 2,
      elapsedMs: 7 * 60_000,
      stepCount: null,
      nextAt: null,
    });
    expect(isUnacknowledgedP1(makeSummary())).toBe(true);
    // A later upgrade to P1 counts from p1Since, not the creation.
    expect(p1BannerModel(makeSummary({ p1Since: '2026-09-23T12:05:00.000Z' }), now)).toMatchObject({
      elapsedMs: 2 * 60_000,
    });
  });

  it('a P1 without a P1 period (before Phase 3): no step, no timer — still acknowledgeable', () => {
    expect(p1BannerModel(makeSummary({ p1Since: null, p1EscalationStep: 0 }), now)).toEqual({
      kind: 'unacknowledged',
      step: null,
      elapsedMs: null,
      stepCount: null,
      nextAt: null,
    });
  });

  it('with the team’s chain (detail): step N of M and when the next step fires (D3)', () => {
    const since = Date.parse('2026-09-23T12:00:00.000Z');
    expect(p1BannerModel(makeDetail({ p1EscalationStep: 1 }), now)).toMatchObject({
      step: 1,
      stepCount: 3,
      nextAt: since + 5 * 60_000,
    });
    // Team rules replace the global chain: its own steps and times.
    const own = makeDetail({
      p1EscalationStep: 1,
      p1Chain: [
        { step: 1, afterMins: 0 },
        { step: 4, afterMins: 30 },
      ],
    });
    expect(p1BannerModel(own, now)).toMatchObject({ stepCount: 2, nextAt: since + 30 * 60_000 });
    // The last step fired: nothing next.
    expect(p1BannerModel(makeDetail({ p1EscalationStep: 3 }), now)).toMatchObject({
      stepCount: 3,
      nextAt: null,
    });
    // No chain (a client's view, or no rules): no count, no time.
    expect(p1BannerModel(makeDetail({ p1Chain: null }), now)).toMatchObject({
      stepCount: null,
      nextAt: null,
    });
  });

  it('acknowledged: who and when (the first acknowledger), whatever the status', () => {
    expect(p1BannerModel(acked(), now)).toEqual({
      kind: 'acknowledged',
      by: 'Maya Ruiz',
      at: '2026-09-23T12:08:00.000Z',
    });
    expect(p1BannerModel(acked({ p1AckedBy: null, status: 'SOLVED' }), now)).toMatchObject({
      kind: 'acknowledged',
      by: null,
    });
    expect(isUnacknowledgedP1(acked())).toBe(false);
  });

  it('a solved or closed P1 that nobody acknowledged shows nothing (nothing escalates)', () => {
    expect(p1BannerModel(makeSummary({ status: 'SOLVED' }), now)).toBeNull();
    expect(p1BannerModel(makeSummary({ status: 'CLOSED' }), now)).toBeNull();
    expect(isUnacknowledgedP1(makeSummary({ status: 'SOLVED' }))).toBe(false);
    expect(p1BannerModel(makeSummary({ status: 'PENDING' }), now)?.kind).toBe('unacknowledged');
  });
});

describe('P1Banner', () => {
  it('says what is going on and acknowledges (server-confirmed), then shows who and when', async () => {
    renderBanner(makeDetail({ p1EscalationStep: 2 }));
    const banner = document.querySelector('[data-p1="unacknowledged"]')!;
    // Step 3 (operations manager) fires at 12:15 UTC = 15:15 in Doha.
    expect(banner.textContent).toContain(
      'P1 not acknowledged · escalation step 2 of 3 · next step in 8m (15:15) · P1 for 7m',
    );

    api.hold = true;
    api.answer = (): AcknowledgeTicketResponse => ({ ticket: acked(), alreadyAcknowledged: false });
    const button = screen.getByRole('button', { name: 'Acknowledge' });
    button.focus();
    fireEvent.click(button);
    // Not optimistic: while the API works, the button says so and stays focused.
    const pending = await screen.findByRole('button', { name: 'Acknowledging…' });
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(pending);
    expect(document.querySelector('[data-p1="acknowledged"]')).toBeNull();
    fireEvent.click(pending); // ignored while pending
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: `/tickets/${IDS.ticket}/acknowledge` },
    ]);

    await act(async () => api.release?.());
    const done = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-p1="acknowledged"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(done.textContent).toBe(
      `Acknowledged by ${String.fromCharCode(0x2068)}Maya Ruiz${String.fromCharCode(0x2069)} · Sep 23, 15:08`,
    );
    // The focus moves from the vanished button to the new line.
    expect(document.activeElement).toBe(done);
    expect(screen.queryByRole('button', { name: /Acknowledg/ })).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows the failure in the banner and keeps the button', async () => {
    api.answer = () => {
      throw new ApiRequestError(409, 'CONFLICT', 'Not a P1');
    };
    renderBanner(makeDetail());
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The P1 wasn’t acknowledged.');
    expect(alert.textContent).toContain(enErrors.CONFLICT);
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(document.querySelector('[data-p1="acknowledged"]')).toBeNull();
  });

  it('a 409 whose reload removes the banner is toasted, and the focus goes to the heading', async () => {
    api.answer = () => {
      throw new ApiRequestError(409, 'CONFLICT', 'Not a P1');
    };
    const { queryClient } = renderBanner(makeDetail());
    const button = screen.getByRole('button', { name: 'Acknowledge' });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('alert');
    // The message outlives the banner (the toast region stays mounted).
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('The P1 wasn’t acknowledged.'),
    );
    // Another agent had downgraded it: the reloaded ticket has no banner.
    act(() =>
      queryClient.setQueryData(
        ticketKeys.detail('LG-4771'),
        makeDetail({ priority: 'P2', p1Since: null }),
      ),
    );
    await waitFor(() => expect(document.querySelector('[data-p1]')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Heading' }));
  });

  it('the focused "Acknowledged by" line shows a focus ring; the red banner keeps a frame in forced colours', () => {
    renderBanner(acked());
    expect(document.querySelector('[data-p1="acknowledged"]')?.className).toMatch(
      /focus-visible:ring-2/,
    );
    cleanup();
    renderBanner(makeDetail());
    expect(document.querySelector('[data-p1="unacknowledged"]')?.className).toContain(
      'forced-colors:border-[CanvasText]',
    );
  });

  it('a repeat shows the first acknowledger and says so', async () => {
    api.answer = (): AcknowledgeTicketResponse => ({
      ticket: acked({ p1AckedBy: { id: IDS.requester, name: 'Theo Kim' } }),
      alreadyAcknowledged: true,
    });
    renderBanner(makeDetail());
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(document.querySelector('[data-p1="acknowledged"]')).not.toBeNull());
    expect(document.querySelector('[data-p1="acknowledged"]')?.textContent).toContain('Theo Kim');
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('had already acknowledged this P1.'),
    );
  });

  it('an acknowledgement pushed by someone else never takes the focus', async () => {
    const { queryClient } = renderBanner(makeDetail());
    const before = screen.getByRole('button', { name: 'before' });
    before.focus();
    act(() => queryClient.setQueryData(ticketKeys.detail('LG-4771'), acked()));
    await waitFor(() => expect(document.querySelector('[data-p1="acknowledged"]')).not.toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it('works in Arabic', () => {
    renderBanner(makeDetail({ p1EscalationStep: 1 }), 'ar');
    const banner = document.querySelector('[data-p1="unacknowledged"]')!;
    expect(banner.textContent).toContain('لم يتم تأكيد استلام P1');
    expect(banner.textContent).toContain('مرحلة التصعيد 1 من 3');
    // Each part isolated right-to-left: "P1" and "1" of neighbouring parts can't pair up.
    const parts = [...banner.querySelectorAll('bdi')];
    expect(parts.map((b) => b.getAttribute('dir'))).toEqual(['rtl', 'rtl', 'rtl', 'rtl']);
    expect(parts.map((b) => b.textContent)).toEqual([
      'لم يتم تأكيد استلام P1',
      'مرحلة التصعيد 1 من 3',
      'المرحلة التالية مستحقة الآن',
      'P1 منذ 7 د',
    ]);
    expect(screen.getByRole('button', { name: 'تأكيد الاستلام' })).toBeTruthy();
    cleanup();
    renderBanner(makeDetail({ p1Since: null }), 'ar');
    // No P1 period: only the title.
    expect(document.querySelector('[data-p1="unacknowledged"] p')?.textContent).toBe(
      'لم يتم تأكيد استلام P1',
    );
  });

  it('says "escalation not started" before step 1 fired', () => {
    renderBanner(makeDetail({ p1EscalationStep: 0 }));
    expect(document.querySelector('[data-p1="unacknowledged"]')?.textContent).toContain(
      'escalation not started',
    );
  });
});

describe('TicketRow P1 marker', () => {
  function renderRow(ticket = makeSummary()) {
    return render(
      <NextIntlClientProvider locale="en" timeZone="Asia/Qatar" now={NOW} messages={MESSAGES.en}>
        <ul>
          <TicketRow
            ticket={ticket}
            href="/console/inbox?ticket=LG-4771"
            selected={false}
            now={NOW.getTime()}
            onSelect={() => undefined}
          />
        </ul>
      </NextIntlClientProvider>,
    );
  }

  it('marks an unacknowledged P1 row (part of the link name), not the others', () => {
    renderRow();
    expect(screen.getByRole('link').textContent).toContain('Not acknowledged');
    cleanup();
    renderRow(acked());
    expect(document.querySelector('[data-p1-marker]')).toBeNull();
    cleanup();
    renderRow(makeSummary({ priority: 'P2' }));
    expect(document.querySelector('[data-p1-marker]')).toBeNull();
  });
});
