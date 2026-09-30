// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import enTickets from '@/messages/en/tickets.json';
import { useConfiguredBusinessDayMinutes } from './business-day';
import { useSlaWindowFormatter } from './i18n';
import { ticketKeys } from './keys';
import { BUSINESS_DAY_MINUTES, slaWindowParts } from './sla-format';
import { FORM_CONFIG } from './test-fixtures';

// E12: "N business days" labels use the configured business-day length (the form config's
// `businessDayMinutes`, derived from the business hours), not a fixed 9 hours.

afterEach(cleanup);

describe('slaWindowParts with a configured day length', () => {
  it('counts whole business days of the given length', () => {
    expect(slaWindowParts(480, true, 480)).toEqual({ unit: 'businessDays', n: 1 });
    expect(slaWindowParts(960, true, 480)).toEqual({ unit: 'businessDays', n: 2 });
    // The same minutes on a 9-hour day are hours.
    expect(slaWindowParts(480, true, 540)).toEqual({ unit: 'hours', n: 8 });
    expect(slaWindowParts(540, true)).toEqual({ unit: 'businessDays', n: 1 });
    // Calendar policies never talk about business days; a bad length falls back to 9 h.
    expect(slaWindowParts(480, false, 480)).toEqual({ unit: 'hours', n: 8 });
    expect(slaWindowParts(1080, true, 0)).toEqual({ unit: 'businessDays', n: 2 });
    expect(BUSINESS_DAY_MINUTES).toBe(540);
  });
});

describe('useConfiguredBusinessDayMinutes / useSlaWindowFormatter', () => {
  function setup(withClient = true) {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => {
      const intl = (
        <NextIntlClientProvider locale="en" messages={{ tickets: enTickets }}>
          {children}
        </NextIntlClientProvider>
      );
      return withClient ? (
        <QueryClientProvider client={queryClient}>{intl}</QueryClientProvider>
      ) : (
        intl
      );
    };
    return { queryClient, wrapper };
  }

  it('reads the cached form config and follows it when it changes', () => {
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(
      () => ({ day: useConfiguredBusinessDayMinutes(), format: useSlaWindowFormatter() }),
      { wrapper },
    );
    expect(result.current.day).toBe(540);
    expect(result.current.format(480, true)).toBe('8 hours');
    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), {
        ...FORM_CONFIG,
        businessDayMinutes: 480,
      });
    });
    expect(result.current.day).toBe(480);
    expect(result.current.format(480, true)).toBe('1 business day');
  });

  it('an explicit length wins; without a QueryClient the 9-hour default applies', () => {
    const { wrapper } = setup(false);
    const { result } = renderHook(
      () => ({
        day: useConfiguredBusinessDayMinutes(),
        explicit: useSlaWindowFormatter(480),
        fallback: useSlaWindowFormatter(),
      }),
      { wrapper },
    );
    expect(result.current.day).toBe(540);
    expect(result.current.explicit(960, true)).toBe('2 business days');
    expect(result.current.fallback(1080, true)).toBe('2 business days');
  });
});
