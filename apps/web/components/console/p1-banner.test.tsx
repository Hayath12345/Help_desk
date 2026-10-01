// @vitest-environment jsdom
import type { AcknowledgeTicketResponse, P1NextStep, TicketDetailDto } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { RealtimeClient } from '@/lib/realtime/client';
import { fakeSocketFactory } from '@/lib/realtime/fake-socket';
import { connectRealtimeToCache } from '@/lib/realtime/provider';
import { ticketKeys } from '@/lib/tickets/keys';
import { useTicket } from '@/lib/tickets/queries';
import { IDS, fixtureId, makeDetail, makeSummary } from '@/lib/tickets/test-fixtures';
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
  /** GET /tickets/LG-4771 answers this detail when set (a refetch). */
  detail: null as null | TicketDetailDto,
}));
vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path === '/tickets/LG-4771' && api.detail) return { ticket: api.detail };
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
  api.detail = null;
  toast.mockReset();
});
afterEach(cleanup);

/** The server's next step (F15): the operations manager (step 3) at 12:15 UTC by default. */
const nextStep = (overrides: Partial<P1NextStep> = {}): P1NextStep => ({
  step: 3,
  ruleId: fixtureId(1301),
  ruleStep: 3,
  targetType: 'USER',
  afterMins: 15,
  dueAt: '2026-09-23T12:15:00.000Z',
  ...overrides,
});

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

  it('detail: step N of M from the team’s chain (D3), the next step from the server (F15)', () => {
    const due = nextStep({ step: 2, ruleStep: 2, afterMins: 5, dueAt: '2026-09-23T12:05:00.000Z' });
    expect(p1BannerModel(makeDetail({ p1EscalationStep: 1, p1NextStep: due }), now)).toMatchObject({
      step: 1,
      stepCount: 3,
      nextAt: Date.parse('2026-09-23T12:05:00.000Z'),
    });
    // Team rules replace the global chain: its length is the count.
    const own = makeDetail({
      p1EscalationStep: 1,
      p1Chain: [
        { step: 1, afterMins: 0 },
        { step: 4, afterMins: 30 },
      ],
      p1NextStep: nextStep({
        step: 2,
        ruleStep: 2,
        afterMins: 30,
        dueAt: '2026-09-23T12:30:00.000Z',
      }),
    });
    expect(p1BannerModel(own, now)).toMatchObject({
      stepCount: 2,
      nextAt: Date.parse('2026-09-23T12:30:00.000Z'),
    });
    // Nothing more will fire (end of the chain, every rule fired): no next step.
    expect(p1BannerModel(makeDetail({ p1EscalationStep: 3, p1NextStep: null }), now)).toMatchObject(
      { stepCount: 3, nextAt: null },
    );
    // No chain (a client's view, or no rules): no count, no time.
    expect(p1BannerModel(makeDetail({ p1Chain: null }), now)).toMatchObject({
      stepCount: null,
      nextAt: null,
    });
  });

  it('never derives the next step from the chain: after an admin reorder it follows p1NextStep', () => {
    // Step 1 fired; the chain would say "step 2 at 12:05", but the rule that moved into slot 2
    // had already fired this P1 period, so the worker fires the step-3 rule at 12:15 next.
    const detail = makeDetail({
      p1EscalationStep: 1,
      p1NextStep: nextStep({ step: 2, ruleStep: 3, dueAt: '2026-09-23T12:15:00.000Z' }),
    });
    expect(p1BannerModel(detail, now)).toMatchObject({
      kind: 'unacknowledged',
      nextAt: Date.parse('2026-09-23T12:15:00.000Z'),
    });
    // And without a server next step there is no next-step time, whatever the chain says.
    expect(p1BannerModel(makeDetail({ p1EscalationStep: 1, p1NextStep: null }), now)).toMatchObject(
      { step: 1, stepCount: 3, nextAt: null },
    );
    // An overdue step (due in the past) keeps its time: the banner says it is due now.
    const overdue = makeDetail({
      p1NextStep: nextStep({
        step: 1,
        ruleStep: 1,
        afterMins: 0,
        dueAt: '2026-09-23T12:00:00.000Z',
      }),
    });
    expect(p1BannerModel(overdue, now)).toMatchObject({
      nextAt: Date.parse('2026-09-23T12:00:00.000Z'),
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
    renderBanner(makeDetail({ p1EscalationStep: 2, p1NextStep: nextStep() }));
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
    // The next step (step 2 at 12:05) is already due at 12:07.
    renderBanner(
      makeDetail({
        p1EscalationStep: 1,
        p1NextStep: nextStep({
          step: 2,
          ruleStep: 2,
          afterMins: 5,
          dueAt: '2026-09-23T12:05:00.000Z',
        }),
      }),
      'ar',
    );
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

  it('the next-step part follows p1NextStep: its time, "due now" when past, nothing when null', () => {
    const banner = () => document.querySelector('[data-p1="unacknowledged"] p')?.textContent ?? '';
    // Step 2 at 12:30 UTC (15:30 in Doha), 23 minutes from now.
    renderBanner(
      makeDetail({
        p1EscalationStep: 1,
        p1NextStep: nextStep({
          step: 2,
          ruleStep: 2,
          afterMins: 30,
          dueAt: '2026-09-23T12:30:00.000Z',
        }),
      }),
    );
    expect(banner()).toBe(
      'P1 not acknowledged · escalation step 1 of 3 · next step in 23m (15:30) · P1 for 7m',
    );
    cleanup();
    // Overdue (the worker fires it at once): "due now", never a negative countdown.
    renderBanner(
      makeDetail({
        p1EscalationStep: 1,
        p1NextStep: nextStep({
          step: 2,
          ruleStep: 2,
          afterMins: 5,
          dueAt: '2026-09-23T12:05:00.000Z',
        }),
      }),
    );
    expect(banner()).toBe(
      'P1 not acknowledged · escalation step 1 of 3 · next step due now · P1 for 7m',
    );
    cleanup();
    // Nothing more will fire: no next-step part (the chain alone never makes one up).
    renderBanner(makeDetail({ p1EscalationStep: 1, p1NextStep: null }));
    expect(banner()).toBe('P1 not acknowledged · escalation step 1 of 3 · P1 for 7m');
  });

  it('a pushed step refetches the detail, so the banner shows the server’s new next step', async () => {
    // Step 2 is due (12:05); the worker fires it and pushes the summary. The push alone can't
    // carry the next step (detail only): the detail is refetched (lib/tickets/cache.ts), even
    // when the push has the same `updatedAt` as the cached copy.
    const { queryClient } = renderBanner(
      makeDetail({
        p1EscalationStep: 1,
        p1NextStep: nextStep({ step: 2, ruleStep: 2, dueAt: '2026-09-23T12:05:00.000Z' }),
      }),
    );
    const { factory, sockets } = fakeSocketFactory();
    const client = new RealtimeClient({
      url: 'http://api.test',
      getToken: async () => 'token',
      createSocket: factory,
    });
    const disconnect = connectRealtimeToCache(client, queryClient);
    client.start();
    const socket = sockets[0]!;
    socket.accept();
    const banner = () => document.querySelector('[data-p1="unacknowledged"]')?.textContent ?? '';
    expect(banner()).toContain('escalation step 1 of 3 · next step due now');

    api.detail = makeDetail({ p1EscalationStep: 2, p1NextStep: nextStep() });
    act(() => socket.receive('ticket:updated', { ticket: makeSummary({ p1EscalationStep: 2 }) }));
    await waitFor(() =>
      expect(banner()).toContain('escalation step 2 of 3 · next step in 8m (15:15)'),
    );
    expect(api.calls).toContainEqual({ method: 'GET', path: '/tickets/LG-4771' });

    // A push that changes nothing the next step depends on (same `updatedAt`) reloads nothing.
    api.calls = [];
    act(() =>
      socket.receive('ticket:updated', {
        ticket: makeSummary({ p1EscalationStep: 2, subject: 'Renamed' }),
      }),
    );
    await act(async () => {});
    expect(api.calls).toEqual([]);
    disconnect();
    client.stop();
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
