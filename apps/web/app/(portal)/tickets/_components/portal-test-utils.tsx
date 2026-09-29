// Test harness for the portal screens (not imported by application code): the providers a
// portal page runs under (TanStack Query, next-intl, viewer, realtime over a fake socket).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { RealtimeClient } from '@/lib/realtime/client';
import { fakeSocketFactory, type FakeSocket } from '@/lib/realtime/fake-socket';
import { RealtimeProvider } from '@/lib/realtime/provider';
import { IDS } from '@/lib/tickets/test-fixtures';
import type { Viewer } from '@/lib/tickets/types';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arErrors from '@/messages/ar/errors.json';
import arPortal from '@/messages/ar/portal.json';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enPortal from '@/messages/en/portal.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';

export const CLIENT_VIEWER: Viewer = {
  id: IDS.requester,
  name: 'Dr. Aisha Al-Kuwari',
  role: 'CLIENT',
};

const MESSAGES = {
  en: {
    common: enCommon,
    portal: enPortal,
    tickets: enTickets,
    errors: enErrors,
    validation: enValidation,
  },
  ar: {
    common: arCommon,
    portal: arPortal,
    tickets: arTickets,
    errors: arErrors,
    validation: arValidation,
  },
};

export interface PortalHarness {
  queryClient: QueryClient;
  client: RealtimeClient;
  /** The sockets the realtime client opened (the last one is the live one). */
  sockets: FakeSocket[];
  socket: () => FakeSocket;
  wrapper: (props: { children: React.ReactNode }) => React.ReactElement;
}

/**
 * Fresh caches and a realtime client on a fake socket. Test files route `getRealtimeClient()` to
 * `harness.client` with `vi.mock('@/lib/realtime/client', …)`.
 */
export function createPortalHarness(
  options: { locale?: 'en' | 'ar'; viewer?: Viewer } = {},
): PortalHarness {
  const { locale = 'en', viewer = CLIENT_VIEWER } = options;
  const fake = fakeSocketFactory();
  const client = new RealtimeClient({
    url: 'http://api.test',
    getToken: async () => 'token',
    createSocket: fake.factory,
    idleCloseMs: 10,
    backoffMs: () => 10,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={viewer}>
          <RealtimeProvider>{children}</RealtimeProvider>
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return {
    queryClient,
    client,
    sockets: fake.sockets,
    socket: () => fake.sockets[fake.sockets.length - 1]!,
    wrapper,
  };
}

/** A promise the test resolves or rejects by hand. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Text without the bidi isolation marks the UI puts around names. */
export function plain(text: string | null | undefined): string {
  return (text ?? '').replace(/[⁦-⁩]/g, '');
}
