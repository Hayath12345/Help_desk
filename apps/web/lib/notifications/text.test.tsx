// @vitest-environment jsdom
import { NOTIFICATION_TYPES, type NotificationDto } from '@loons/shared';
import { cleanup, render, renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import { makeNotification } from './test-fixtures';
import { notificationHref, useNotificationText } from './text';

afterEach(cleanup);

const LRI = String.fromCharCode(0x2066);
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
const ARABIC = /\p{Script=Arabic}/u;

function wordsFor(locale: 'en' | 'ar') {
  const messages =
    locale === 'en'
      ? { common: enCommon, console: enConsole }
      : { common: arCommon, console: arConsole };
  const { result } = renderHook(() => useNotificationText(), {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={messages}>
        {children}
      </NextIntlClientProvider>
    ),
  });
  return result.current;
}

const FULL_DATA = {
  subject: 'Firewall blocking the VPN',
  priority: 'P1' as const,
  target: 'RESOLUTION' as const,
  step: 3,
  status: 'PENDING' as const,
  actor: { id: fixtureId(801), name: 'Maya Ruiz' },
};

describe('useNotificationText', () => {
  it('words every type in English, with and without its optional data', () => {
    const words = wordsFor('en');
    const expected: Record<string, [full: string, bare: string]> = {
      TICKET_CREATED: ['New ticket LG-4821', 'New ticket LG-4821'],
      TICKET_ASSIGNED: ['Maya Ruiz assigned LG-4821 to you', 'LG-4821 was assigned to you'],
      CLIENT_REPLY: ['Maya Ruiz replied on LG-4821', 'New client reply on LG-4821'],
      AGENT_REPLY: ['Maya Ruiz replied on LG-4821', 'New reply on LG-4821'],
      STATUS_CHANGED: ['LG-4821 is now Pending', 'LG-4821 changed status'],
      SLA_AT_RISK: ['Resolution SLA at risk on LG-4821', 'SLA at risk on LG-4821'],
      SLA_BREACHED: ['Resolution SLA breached on LG-4821', 'SLA breached on LG-4821'],
      P1_CREATED: ['New P1 ticket LG-4821', 'New P1 ticket LG-4821'],
      P1_ESCALATED: ['P1 LG-4821 escalated · step 3', 'P1 LG-4821 escalated'],
      P1_ACKNOWLEDGED: ['Maya Ruiz acknowledged P1 LG-4821', 'P1 LG-4821 acknowledged'],
    };
    const strip = (s: string) => [...s].filter((c) => c < LRI || c > PDI).join('');
    for (const type of NOTIFICATION_TYPES) {
      const full = words(makeNotification(1, { type, data: FULL_DATA }));
      const bare = words(makeNotification(1, { type, data: {} }));
      expect([strip(full.plain), strip(bare.plain)], type).toEqual(expected[type]);
      // The ticket number is LTR-isolated; names first-strong isolated.
      expect(full.plain).toContain(`${LRI}LG-4821${PDI}`);
      if (full.plain.includes('Maya')) expect(full.plain).toContain(`${FSI}Maya Ruiz${PDI}`);
    }
    // First reply target, and SLA breached.
    expect(
      strip(
        words(makeNotification(1, { type: 'SLA_AT_RISK', data: { target: 'FIRST_REPLY' } })).plain,
      ),
    ).toBe('First-reply SLA at risk on LG-4821');
  });

  it('words every type in Arabic, keeping the number left-to-right', () => {
    const words = wordsFor('ar');
    for (const type of NOTIFICATION_TYPES) {
      for (const data of [FULL_DATA, {}]) {
        const { plain } = words(makeNotification(1, { type, data }));
        expect(plain, type).toMatch(ARABIC);
        expect(plain).toContain(`${LRI}LG-4821${PDI}`);
        expect(plain).not.toMatch(/[{}]/);
      }
    }
    // Latin digits in the step, the Arabic status label.
    expect(words(makeNotification(1, { type: 'P1_ESCALATED', data: { step: 2 } })).plain).toContain(
      'المرحلة 2',
    );
    expect(
      words(makeNotification(1, { type: 'STATUS_CHANGED', data: { status: 'SOLVED' } })).plain,
    ).toContain('تم الحل');
  });

  it('renders the ticket number in a left-to-right bdi for the list', () => {
    const words = wordsFor('ar');
    const { container } = render(<p>{words(makeNotification(1)).rich}</p>);
    const bdi = container.querySelector('bdi');
    expect(bdi?.getAttribute('dir')).toBe('ltr');
    expect(bdi?.textContent).toBe('LG-4821');
  });

  it('handles a notification without a ticket (no link, generic words)', () => {
    const noTicket: NotificationDto = makeNotification(1, {
      type: 'TICKET_CREATED',
      ticketId: null,
      ticketNumber: null,
    });
    expect(notificationHref(noTicket)).toBeNull();
    expect(wordsFor('en')(noTicket).plain).toContain('a ticket');
    expect(notificationHref(makeNotification(1))).toBe('/console/inbox?ticket=LG-4821');
  });
});
