// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import arCommon from '@/messages/ar/common.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enTickets from '@/messages/en/tickets.json';
import { IDS, fixtureId, makeMessage, makeSummary } from '@/lib/tickets/test-fixtures';
import type { ThreadMessage } from '@/lib/tickets/types';
import { MessageBubble, messageKind } from './message-bubble';
import { SlaText, slaTone } from './sla-text';
import { TicketThread } from './ticket-thread';
import { TypingIndicator } from './typing-indicator';
import { slaState } from '@loons/shared';

vi.mock('@/lib/uploads/upload', () => ({ downloadAttachment: vi.fn() }));

afterEach(cleanup);

function renderIntl(ui: React.ReactElement, locale: 'en' | 'ar' = 'en') {
  const messages =
    locale === 'en'
      ? { common: enCommon, tickets: enTickets }
      : { common: arCommon, tickets: arTickets };
  return render(
    <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const agent = { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' as const };

describe('MessageBubble', () => {
  it('tags clients, Loons Support and internal notes', () => {
    expect(messageKind(makeMessage())).toBe('client');
    expect(messageKind(makeMessage({ author: agent }))).toBe('support');
    expect(messageKind(makeMessage({ type: 'INTERNAL', author: agent }))).toBe('internal');
    expect(messageKind(makeMessage({ type: 'SYSTEM', author: null }))).toBe('system');

    renderIntl(<MessageBubble message={makeMessage({ type: 'INTERNAL', author: agent })} />);
    const article = screen.getByRole('article');
    expect(article.dataset.kind).toBe('internal');
    expect(within(article).getByText('Internal note')).toBeTruthy();
    expect(within(article).getByText('Maya Ruiz')).toBeTruthy();
    expect(article.querySelector('.bg-note-bg')).not.toBeNull();
  });

  it('keeps line breaks, links URLs safely and never renders HTML', () => {
    const body = 'Line one\n<img src=x onerror=alert(1)> https://example.com/runbook';
    renderIntl(<MessageBubble message={makeMessage({ body })} />);
    const link = screen.getByRole('link', { name: /example\.com\/runbook/ });
    expect(link.getAttribute('href')).toBe('https://example.com/runbook');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    expect(link.closest('[dir="auto"]')?.className).toContain('whitespace-pre-wrap');
  });

  it('shows pending and failed optimistic messages with Retry / Discard', () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const failed: ThreadMessage = {
      ...makeMessage({ id: fixtureId(9), clientTempId: fixtureId(9) }),
      local: { status: 'failed', input: { type: 'PUBLIC', body: 'x' } },
    };
    renderIntl(<MessageBubble message={failed} onRetry={onRetry} onDiscard={onDiscard} />);
    expect(screen.getByRole('alert').textContent).toContain('Not sent');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onRetry).toHaveBeenCalledWith(failed);
    expect(onDiscard).toHaveBeenCalledWith(failed);

    cleanup();
    renderIntl(
      <MessageBubble message={{ ...failed, local: { ...failed.local!, status: 'pending' } }} />,
    );
    expect(screen.getByRole('article').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Sending…')).toBeTruthy();
  });

  it('lists attachments as download buttons', () => {
    renderIntl(
      <MessageBubble
        message={makeMessage({
          attachments: [
            {
              id: fixtureId(1101),
              fileName: 'nvr.log',
              mimeType: 'text/plain',
              sizeBytes: 2_500_000,
              createdAt: '2026-09-23T12:00:00.000Z',
            },
          ],
        })}
      />,
    );
    const button = screen.getByRole('button', { name: 'Download nvr.log' });
    expect(button.textContent).toContain('2.4 MB');
  });
});

describe('TicketThread', () => {
  it('renders skeletons while loading, then a log of messages', () => {
    const { rerender } = renderIntl(<TicketThread messages={undefined} isLoading />);
    expect(screen.getByRole('status').textContent).toBe('Loading the conversation…');
    rerender(
      <NextIntlClientProvider
        locale="en"
        timeZone="Asia/Qatar"
        messages={{ common: enCommon, tickets: enTickets }}
      >
        <TicketThread
          messages={[
            makeMessage(),
            makeMessage({ id: fixtureId(2), author: agent, body: 'On it' }),
          ]}
          typingUsers={[{ id: 'x', name: 'Aisha', scope: 'public' }]}
        />
      </NextIntlClientProvider>,
    );
    const log = screen.getByRole('log');
    expect(within(log).getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Aisha is typing…')).toBeTruthy();
  });

  it('is a "Conversation" region, unless its container already is (UI-RR-3)', () => {
    const { unmount } = renderIntl(<TicketThread messages={[makeMessage()]} />);
    // The portal: the thread itself is the named region.
    expect(
      screen.getByRole('region', { name: 'Conversation' }).contains(screen.getByRole('log')),
    ).toBe(true);
    unmount();
    // The console: its scroller carries the name, so the thread adds no second landmark.
    renderIntl(<TicketThread messages={[makeMessage()]} labelled={false} />, 'ar');
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.queryAllByRole('region')).toEqual([]);
  });

  it('offers a retry when loading failed', () => {
    const onReload = vi.fn();
    renderIntl(<TicketThread messages={undefined} isError onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onReload).toHaveBeenCalled();
  });
});

describe('TypingIndicator', () => {
  it('phrases one, two, many and internal-note typists (EN / AR)', () => {
    const { rerender, container } = renderIntl(<TypingIndicator users={[]} />);
    const region = container.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toBe('');
    const wrap = (ui: React.ReactElement) => (
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ tickets: enTickets }}>
        {ui}
      </NextIntlClientProvider>
    );
    rerender(wrap(<TypingIndicator users={[{ id: '1', name: 'Maya', scope: 'internal' }]} />));
    expect(region.textContent).toContain('Maya is writing an internal note…');
    rerender(
      wrap(
        <TypingIndicator
          users={[
            { id: '1', name: 'Maya', scope: 'public' },
            { id: '2', name: 'Theo', scope: 'public' },
          ]}
        />,
      ),
    );
    expect(region.textContent).toContain('Maya and Theo are typing…');
    rerender(
      wrap(
        <TypingIndicator
          users={['A', 'B', 'C'].map((name, i) => ({ id: String(i), name, scope: 'public' }))}
        />,
      ),
    );
    expect(region.textContent).toContain('3 people are typing…');

    cleanup();
    renderIntl(<TypingIndicator users={[{ id: '1', name: 'مايا', scope: 'public' }]} />, 'ar');
    expect(document.body.textContent).toContain('مايا يكتب الآن…');
  });
});

describe('SlaText', () => {
  const now = Date.parse('2026-09-23T12:06:00.000Z');
  const text = (ticket: Parameters<typeof SlaText>[0]['ticket']) => {
    cleanup();
    const { container } = renderIntl(<SlaText ticket={ticket} now={now} />);
    const el = container.firstElementChild as HTMLElement;
    return {
      visible: el.querySelector('[aria-hidden]')?.textContent ?? el.textContent,
      tone: el.dataset.sla,
      sr: el.querySelector('.sr-only')?.textContent,
    };
  };

  it('shows the first-reply countdown coloured by risk', () => {
    expect(text(makeSummary())).toEqual({ visible: '9m', tone: 'ok', sr: 'First reply due in 9m' });
    expect(text(makeSummary({ firstReplyDueAt: '2026-09-23T12:08:00.000Z' })).tone).toBe('risk');
    expect(text(makeSummary({ firstReplyDueAt: '2026-09-23T12:00:00.000Z' }))).toMatchObject({
      visible: 'Overdue 6m',
      tone: 'overdue',
    });
  });

  it('shows Replied, Paused and done states', () => {
    expect(text(makeSummary({ firstRepliedAt: '2026-09-23T12:01:00.000Z' }))).toMatchObject({
      visible: 'Replied',
      tone: 'replied',
    });
    expect(
      text(makeSummary({ status: 'PENDING', firstRepliedAt: '2026-09-23T12:01:00.000Z' })),
    ).toMatchObject({ visible: 'Paused', tone: 'paused' });
    // PENDING pauses the resolution clock only: an unanswered ticket keeps its first-reply target.
    expect(text(makeSummary({ status: 'PENDING' }))).toEqual({
      visible: '9m',
      tone: 'ok',
      sr: 'First reply due in 9m',
    });
    expect(text(makeSummary({ status: 'SOLVED' }))).toMatchObject({
      visible: 'Solved',
      tone: 'done',
    });
    expect(slaTone(slaState(makeSummary({ status: 'CLOSED' }), now))).toBe('done');
  });
});
