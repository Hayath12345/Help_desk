// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { ticketKeys } from '@/lib/tickets/keys';
import { FORM_CONFIG, FORM_CONTEXT, IDS, makeDetail } from '@/lib/tickets/test-fixtures';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { NewTicketProvider, ticketHref, useNewTicket } from './new-ticket-context';

const api = vi.hoisted(() => ({
  createTicket: vi.fn(),
  fetchRequesters: vi.fn(),
  fetchTicket: vi.fn(),
}));
vi.mock('@/lib/tickets/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

// Presign bodies are recorded and never answered (the upload stays in progress).
const presigns = vi.hoisted(() => ({ bodies: [] as unknown[] }));
vi.mock('@/lib/api/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/browser')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      post: (path: string, ...rest: unknown[]) => {
        if (path !== '/attachments/presign') {
          return (actual.apiClient.post as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
        }
        presigns.bodies.push(rest[0]);
        return new Promise(() => undefined);
      },
    },
  };
});

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  // What Radix needs from a browser that jsdom lacks.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  api.createTicket.mockReset();
  api.fetchRequesters.mockReset();
  api.fetchTicket.mockReset();
  router.push.mockReset();
  toast.success.mockReset();
});
afterEach(cleanup);

const CLIENT = { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', role: 'CLIENT' as const };
const AGENT = { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' as const };

function Opener() {
  const newTicket = useNewTicket();
  return (
    <>
      <button type="button" onClick={() => newTicket.open()}>
        open
      </button>
      <button type="button" onClick={() => newTicket.close()}>
        close from outside
      </button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const MESSAGES = {
  en: { common: enCommon, tickets: enTickets, validation: enValidation, errors: enErrors },
  ar: { common: arCommon, tickets: arTickets, validation: arValidation, errors: arErrors },
};

function renderModal(viewer: typeof CLIENT | typeof AGENT = CLIENT, locale: 'en' | 'ar' = 'en') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(ticketKeys.formConfig(), FORM_CONFIG);
  queryClient.setQueryData(ticketKeys.formContext(null), FORM_CONTEXT);
  queryClient.setQueryData(ticketKeys.formContext(IDS.requester), FORM_CONTEXT);
  queryClient.setQueryData(ticketKeys.requesters(''), [
    {
      id: IDS.requester,
      name: FORM_CONTEXT.requester.name,
      email: FORM_CONTEXT.requester.email,
      org: FORM_CONTEXT.org,
    },
  ]);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={viewer}>
          <NewTicketProvider>
            <Opener />
          </NewTicketProvider>
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open' }));
  return {
    ...utils,
    queryClient,
    dialog: () =>
      screen.getByRole('dialog', {
        name: locale === 'ar' ? arTickets.newTicket.title : 'New ticket',
      }),
  };
}

/** Opens a Radix select with the keyboard and picks the option whose text starts with `label`. */
async function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const option = await screen.findByRole('option', { name: new RegExp(`^${escape(label)}`) });
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}
/** Opens a combobox (requester / site), clicks an option and waits for the popover to close. */
async function pick(trigger: HTMLElement, option: RegExp) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('option', { name: option }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });
const radio = (group: HTMLElement, name: string) =>
  within(group).getByRole('radio', { name: new RegExp(`^${escape(name)}`) });

describe('New ticket modal', () => {
  it('opens with the client organisation and focuses the ticket type', async () => {
    const { dialog } = renderModal();
    expect(within(dialog()).getByRole('heading', { name: 'New ticket' })).toBeTruthy();
    expect(within(dialog()).getByText('Hamad Medical Corporation')).toBeTruthy();
    expect(within(dialog()).getByText('AMC')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Incident'));
    expect(within(dialog()).getByText(/Routed to/).textContent).toBe(
      'Routed to — · Target first response —',
    );
  });

  it('makes the sub-type depend on the category and sets the priority from it', async () => {
    const { dialog } = renderModal();
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    expect(subtype.hasAttribute('disabled')).toBe(true);
    expect(subtype.textContent).toContain('Choose a category first');

    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'CCTV');
    expect(subtype.hasAttribute('disabled')).toBe(false);
    await choose(subtype, 'NVR / VMS recording failure');

    const priority = within(dialog()).getByRole('radiogroup', { name: 'Priority' });
    expect(radio(priority, 'P1 Critical').getAttribute('aria-checked')).toBe('true');
    expect(within(dialog()).getByText('Auto-set from sub-type')).toBeTruthy();
    expect(
      within(dialog()).getByText('Target first response: 15 min · resolution 4 hours'),
    ).toBeTruthy();
    // P1 banner with the SOC phone.
    const banner = within(dialog()).getByRole('alert');
    expect(banner.textContent).toContain('Critical');
    expect(
      within(banner)
        .getByRole('link', { name: /Call 24\/7 SOC/ })
        .getAttribute('href'),
    ).toBe('tel:+97440000000');
    expect(within(dialog()).getByText(/Routed to/).textContent).toBe(
      'Routed to ELV Field · Target first response 15 min',
    );
    // The category's asset placeholder and custom field appear.
    expect(
      within(dialog())
        .getByLabelText(/Asset \/ device ID/)
        .getAttribute('placeholder'),
    ).toBe('e.g. CAM-014');
    expect(within(dialog()).getByLabelText(/Camera ID/)).toBeTruthy();

    // Picking a priority makes it manual.
    fireEvent.click(radio(priority, 'P3 Medium'));
    expect(within(dialog()).getByText('Set manually')).toBeTruthy();
    await waitFor(() => expect(within(dialog()).queryByRole('alert')).toBeNull());

    // A new category clears the sub-type.
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'Other');
    expect(subtype.textContent).toContain('Choose a sub-type…');
  });

  it('Security Incident shows the checklist and locks the category to Cybersecurity / SOC', async () => {
    const { dialog } = renderModal();
    fireEvent.click(
      radio(within(dialog()).getByRole('radiogroup', { name: 'Ticket type' }), 'Security Incident'),
    );
    expect(
      within(dialog()).getByText(
        'Security incident checklist — Category set to Cybersecurity / SOC',
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByText('Do not power off affected devices')).toBeTruthy();
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    expect(category.textContent).toContain('Cybersecurity / SOC');
    expect(category.hasAttribute('disabled')).toBe(true);
    expect(
      within(dialog()).getByText('Security incidents always go to Cybersecurity / SOC.'),
    ).toBeTruthy();
  });

  it('arrowing through Security Incident leaves the chosen category and sub-type as they were (DA-2)', async () => {
    const { dialog } = renderModal();
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    await choose(category, 'CCTV');
    await choose(subtype, 'NVR / VMS recording failure');

    const types = within(dialog()).getByRole('radiogroup', { name: 'Ticket type' });
    /** The polite live region that says what a type change did to the category. */
    const announced = (text: string) =>
      expect(within(dialog()).getByText(text).getAttribute('aria-live')).toBe('polite');
    act(() => radio(types, 'Incident').focus());
    // Radix radios select the one arrows land on (the radio pattern).
    for (const expected of ['Service Request', 'Change Request', 'Security Incident']) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
      await waitFor(() => expect(document.activeElement?.textContent).toBe(expected));
      fireEvent.keyUp(document.activeElement!, { key: 'ArrowRight' });
    }
    await waitFor(() => expect(category.textContent).toContain('Cybersecurity / SOC'));
    expect(category.hasAttribute('disabled')).toBe(true);
    announced('Category set to Cybersecurity / SOC and locked for security incidents.');

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Enquiry'));
    await waitFor(() => expect(radio(types, 'Enquiry').getAttribute('aria-checked')).toBe('true'));
    expect(category.textContent).toContain('CCTV & Video Surveillance');
    expect(category.hasAttribute('disabled')).toBe(false);
    expect(subtype.textContent).toContain('NVR / VMS recording failure');
    announced('Category set back to CCTV & Video Surveillance.');
    // The sub-type's priority came back with it.
    const priority = within(dialog()).getByRole('radiogroup', { name: 'Priority' });
    expect(radio(priority, 'P1 Critical').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a security sub-type picked on purpose when the type changes again', async () => {
    const { dialog } = renderModal();
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    await choose(category, 'CCTV');
    const types = within(dialog()).getByRole('radiogroup', { name: 'Ticket type' });
    fireEvent.click(radio(types, 'Security Incident'));
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    await choose(subtype, 'Phishing report');
    fireEvent.click(radio(types, 'Incident'));
    expect(category.textContent).toContain('Cybersecurity / SOC');
    expect(subtype.textContent).toContain('Phishing report');
  });

  it('uses the Arabic words around the English example of the asset placeholder (DA-11)', async () => {
    const { dialog } = renderModal(CLIENT, 'ar');
    const asset = () => within(dialog()).getByLabelText(/الأصل|الجهاز/);
    // Isolated right-to-left (RLI … PDI) for the console's LTR asset input, the ID inside it
    // left-to-right (LRI … PDI); harmless here (UI-RR-2).
    await choose(within(dialog()).getByRole('combobox', { name: /^الفئة/ }), 'الدوائر');
    expect(asset().getAttribute('placeholder')).toBe('\u2067مثال: \u2066CAM-014\u2069\u2069');
    await choose(within(dialog()).getByRole('combobox', { name: /^الفئة/ }), 'أخرى');
    expect(asset().getAttribute('placeholder')).toBe('\u2067اختياري\u2069');
  });

  it('keeps a Latin asset placeholder and a digit-first example in their own order in Arabic (UI-RR-2)', async () => {
    const { dialog, queryClient } = renderModal(CLIENT, 'ar');
    queryClient.setQueryData(ticketKeys.formConfig(), {
      ...FORM_CONFIG,
      categories: FORM_CONFIG.categories.map((c) =>
        c.id === IDS.cyber
          ? { ...c, assetPlaceholder: 'Serial on the label.' }
          : c.id === IDS.cctv
            ? { ...c, assetPlaceholder: 'e.g. 2026-018' }
            : c,
      ),
    });
    const asset = () => within(dialog()).getByLabelText(/الأصل|الجهاز/);
    const category = () => within(dialog()).getByRole('combobox', { name: /^الفئة/ });
    // The RTL input: the configured English text is isolated left-to-right, so its full stop
    // stays at its end instead of moving to the start of the line.
    await choose(category(), 'الأمن');
    expect(asset().getAttribute('placeholder')).toBe('\u2066Serial on the label.\u2069');
    await choose(category(), 'الدوائر');
    expect(asset().getAttribute('placeholder')).toBe('\u2067مثال: \u20662026-018\u2069\u2069');
  });

  it('shows the category’s own Arabic asset example in Arabic, the English one in English', async () => {
    const withArabic = {
      ...FORM_CONFIG,
      categories: FORM_CONFIG.categories.map((c) =>
        c.id === IDS.cctv ? { ...c, assetPlaceholderAr: 'مثال: كاميرا-014' } : c,
      ),
    };
    const ar = renderModal(CLIENT, 'ar');
    ar.queryClient.setQueryData(ticketKeys.formConfig(), withArabic);
    await choose(within(ar.dialog()).getByRole('combobox', { name: /^الفئة/ }), 'الدوائر');
    expect(
      within(ar.dialog())
        .getByLabelText(/الأصل|الجهاز/)
        .getAttribute('placeholder'),
    ).toBe('⁧مثال: كاميرا-014⁩');
    cleanup();

    const en = renderModal(CLIENT, 'en');
    en.queryClient.setQueryData(ticketKeys.formConfig(), withArabic);
    await choose(within(en.dialog()).getByRole('combobox', { name: /^Category/ }), 'CCTV');
    expect(within(en.dialog()).getByLabelText(/Asset/).getAttribute('placeholder')).toBe(
      'e.g. CAM-014',
    );
  });

  it('shows per-field errors and the error count after a submit attempt', async () => {
    const { dialog } = renderModal();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await within(dialog()).findByText('Add a short subject.');
    for (const text of [
      'Choose a category.',
      'Choose a category first.',
      'Choose the site or location.',
      'Describe the fault (at least 10 characters).',
      '5 fields need attention',
    ]) {
      expect(within(dialog()).getByText(text)).toBeTruthy();
    }
    const subject = within(dialog()).getByLabelText(/^Subject/);
    expect(subject.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(subject.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Add a short subject.',
    );
    expect(document.activeElement).toBe(subject);

    type(subject, 'Cameras down');
    await waitFor(() => expect(within(dialog()).queryByText('Add a short subject.')).toBeNull());
    expect(within(dialog()).getByText('4 fields need attention')).toBeTruthy();
    expect(api.createTicket).not.toHaveBeenCalled();
  });

  it('creates the ticket, toasts and opens it (client)', async () => {
    api.createTicket.mockResolvedValueOnce(makeDetail({ number: 4900, ref: 'LG-4900' }));
    const { dialog } = renderModal();
    type(within(dialog()).getByLabelText(/^Subject/), 'Cameras not recording');
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'CCTV');
    await choose(within(dialog()).getByRole('combobox', { name: /Sub-type/ }), 'Camera offline');
    fireEvent.click(
      radio(within(dialog()).getByRole('radiogroup', { name: 'Impact' }), 'Entire site'),
    );
    const site = within(dialog()).getByRole('combobox', { name: /Site/ });
    await pick(site, /Main Data Center/);
    expect(site.textContent).toContain('HMC – Main Data Center');
    type(within(dialog()).getByLabelText(/Camera ID/), 'CAM-014');
    type(within(dialog()).getByLabelText(/^Description/), 'Nothing recorded since 06:40.');

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
    expect(api.createTicket.mock.calls[0]?.[0]).toEqual({
      type: 'INCIDENT',
      categoryId: IDS.cctv,
      subtypeId: IDS.cameraOffline,
      impact: 'ENTIRE_SITE',
      siteId: IDS.siteB,
      subject: 'Cameras not recording',
      description: 'Nothing recorded since 06:40.',
      customFields: { camera_id: 'CAM-014' },
      attachmentIds: [],
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/tickets/LG-4900'));
    expect(toast.success).toHaveBeenCalledWith('Ticket LG-4900 created · routed to ELV Field');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /** Fills the minimum valid form (client: the org's site is chosen from the list). */
  async function fillValidForm(dialog: () => HTMLElement) {
    type(within(dialog()).getByLabelText(/^Subject/), 'Printer');
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'Other');
    await choose(within(dialog()).getByRole('combobox', { name: /Sub-type/ }), 'Describe below');
    await pick(within(dialog()).getByRole('combobox', { name: /Site/ }), /Building 3/);
    type(within(dialog()).getByLabelText(/^Description/), 'The printer on level 2 is jammed.');
  }

  it('Cancel does nothing while the ticket is being created, which then opens (F7)', async () => {
    const created = deferred<ReturnType<typeof makeDetail>>();
    api.createTicket.mockReturnValueOnce(created.promise);
    const { dialog } = renderModal();
    await fillValidForm(dialog);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    const cancel = await within(dialog()).findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel.getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(cancel);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'New ticket' })).toBeTruthy();

    await act(async () => {
      created.resolve(makeDetail({ number: 4900, ref: 'LG-4900' }));
      await created.promise;
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/tickets/LG-4900'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a form closed while its ticket is being created reports it but never navigates (F7)', async () => {
    const created = deferred<ReturnType<typeof makeDetail>>();
    api.createTicket.mockReturnValueOnce(created.promise);
    const { dialog } = renderModal();
    await fillValidForm(dialog);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
    // Closed from elsewhere (useNewTicket().close()), e.g. by a keyboard shortcut.
    fireEvent.click(screen.getByRole('button', { name: 'close from outside', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await act(async () => {
      created.resolve(makeDetail({ number: 4900, ref: 'LG-4900' }));
      await created.promise;
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Ticket LG-4900 created · routed to ELV Field'),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('staff who raise a ticket for a team they are not on stay where they are (P2-CC-4)', async () => {
    // Routed to ELV Field, unassigned: the API gives it to the creator only on their own team.
    api.createTicket.mockResolvedValueOnce(
      makeDetail({ number: 4900, ref: 'LG-4900', assignee: null }),
    );
    api.fetchTicket.mockRejectedValueOnce(
      new ApiRequestError(404, 'NOT_FOUND', 'Ticket not found'),
    );
    api.fetchRequesters.mockResolvedValue([]);
    const { dialog, queryClient } = renderModal(AGENT);
    await pick(
      within(dialog()).getByRole('combobox', { name: /Requester/ }),
      /Dr\. Aisha Al-Kuwari/,
    );
    await fillValidForm(dialog);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Ticket LG-4900 created and routed to ELV Field', {
        description: "You're not on that team, so it stays out of your inbox.",
      }),
    );
    expect(api.fetchTicket).toHaveBeenCalledWith('LG-4900', expect.anything());
    expect(router.push).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(ticketKeys.detail('LG-4900'))).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('staff assigned to the ticket they raised open it in the console without an extra request', async () => {
    api.createTicket.mockResolvedValueOnce(
      makeDetail({ number: 4900, ref: 'LG-4900', assignee: { id: AGENT.id, name: AGENT.name } }),
    );
    api.fetchRequesters.mockResolvedValue([]);
    const { dialog } = renderModal(AGENT);
    await pick(
      within(dialog()).getByRole('combobox', { name: /Requester/ }),
      /Dr\. Aisha Al-Kuwari/,
    );
    await fillValidForm(dialog);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/console/inbox?ticket=LG-4900'));
    expect(toast.success).toHaveBeenCalledWith('Ticket LG-4900 created · routed to ELV Field');
    expect(api.fetchTicket).not.toHaveBeenCalled();
  });

  it('maps API validation issues onto the fields', async () => {
    // The API's shape for a business rule: the generic key plus the rule's code.
    api.createTicket.mockRejectedValueOnce(
      new ApiRequestError(400, 'VALIDATION_FAILED', 'Request validation failed', undefined, [
        { location: 'body', path: ['siteId'], message: 'validation.invalid', code: 'site' },
      ]),
    );
    const { dialog } = renderModal();
    type(within(dialog()).getByLabelText(/^Subject/), 'Printer');
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'Other');
    await choose(within(dialog()).getByRole('combobox', { name: /Sub-type/ }), 'Describe below');
    await pick(within(dialog()).getByRole('combobox', { name: /Site/ }), /Building 3/);
    type(within(dialog()).getByLabelText(/^Description/), 'The printer on level 2 is jammed.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    expect(await within(dialog()).findByText('Choose the site or location.')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ['client', CLIENT],
    ['staff', AGENT],
  ] as const)('%s: presigns the description’s files as public (SEC-WEB-1)', async (_, viewer) => {
    presigns.bodies = [];
    const { dialog } = renderModal(viewer);
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(['log'], 'firewall.log', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(presigns.bodies).toHaveLength(1));
    // A new ticket has no id yet, so no ticketId either.
    expect(presigns.bodies[0]).toEqual({
      fileName: 'firewall.log',
      mimeType: 'text/plain',
      sizeBytes: 3,
      visibility: 'public',
    });
  });

  it('staff pick the requester first; the org chip and sites follow', async () => {
    api.fetchRequesters.mockResolvedValue([]);
    const { dialog } = renderModal(AGENT);
    const requester = within(dialog()).getByRole('combobox', { name: /Requester/ });
    await waitFor(() => expect(document.activeElement).toBe(requester));
    expect(within(dialog()).queryByText('Hamad Medical Corporation')).toBeNull();
    const site = within(dialog()).getByRole('combobox', { name: /Site/ });
    expect(site.hasAttribute('disabled')).toBe(true);
    expect(site.textContent).toContain('Choose the requester first');

    await pick(requester, /Dr\. Aisha Al-Kuwari/);
    await waitFor(() =>
      expect(within(dialog()).getByText('Hamad Medical Corporation')).toBeTruthy(),
    );
    expect(site.hasAttribute('disabled')).toBe(false);
  });
});

describe('entry points', () => {
  it('ticketHref sends clients to the thread and staff to the console', () => {
    expect(ticketHref({ ref: 'LG-4900', number: 4900 }, false)).toBe('/tickets/LG-4900');
    expect(ticketHref({ ref: 'LG-4900', number: 4900 }, true)).toBe(
      '/console/inbox?ticket=LG-4900',
    );
    expect(ticketHref({ ref: 'javascript:x', number: 7 }, false)).toBe('/tickets/LG-7');
  });

  it('the "+ New ticket" button opens the modal, and is inert without a provider', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ticketKeys.formConfig(), FORM_CONFIG);
    queryClient.setQueryData(ticketKeys.formContext(null), FORM_CONTEXT);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tree = (withProvider: boolean) => (
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider
          locale="en"
          timeZone="UTC"
          messages={{
            common: enCommon,
            tickets: enTickets,
            validation: enValidation,
            errors: enErrors,
          }}
        >
          <ViewerProvider viewer={CLIENT}>
            {withProvider ? (
              <NewTicketProvider>
                <NewTicketButton />
              </NewTicketProvider>
            ) : (
              <NewTicketButton />
            )}
          </ViewerProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
    render(tree(false));
    const inert = screen.getByRole('button', { name: 'New ticket' });
    expect(inert.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(inert);
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    render(tree(true));
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    warn.mockRestore();
  });
});

describe('config changes while the form is open (Phase 4, E18)', () => {
  const withoutCctv = (version: number) => ({
    ...FORM_CONFIG,
    categories: FORM_CONFIG.categories.filter((c) => c.key !== 'cctv'),
    version,
  });

  it('keeps the input and clears an archived category with a polite notice', async () => {
    const { dialog, queryClient } = renderModal();
    const subject = within(dialog()).getByRole('textbox', { name: /Subject/ });
    type(subject, 'Cameras offline on level 2');
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    await choose(category, 'CCTV');
    await choose(subtype, 'NVR / VMS recording failure');

    // An admin archives CCTV: the refetched configuration no longer has it.
    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), withoutCctv(2));
    });
    const text =
      '“CCTV & Video Surveillance” is no longer available, so it was cleared. Choose another category.';
    const notice = await within(dialog()).findByText(text);
    expect(notice.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(category.textContent).toContain('Choose a category…');
    expect(subtype.hasAttribute('disabled')).toBe(true);
    expect((subject as HTMLInputElement).value).toBe('Cameras offline on level 2');
    // The P1 banner of the cleared sub-type is gone too.
    await waitFor(() => expect(within(dialog()).queryByRole('alert')).toBeNull());

    // Choosing another category dismisses the notice.
    await choose(category, 'Other');
    expect(within(dialog()).queryByText(text)).toBeNull();
  });

  it('clears an archived sub-type but keeps its category', async () => {
    const { dialog, queryClient } = renderModal();
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    await choose(category, 'CCTV');
    await choose(subtype, 'NVR / VMS recording failure');

    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), {
        ...FORM_CONFIG,
        version: 3,
        categories: FORM_CONFIG.categories.map((c) =>
          c.key === 'cctv'
            ? { ...c, subtypes: c.subtypes.filter((s) => s.key !== 'nvr-failure') }
            : c,
        ),
      });
    });
    expect(
      await within(dialog()).findByText(
        'The sub-type “NVR / VMS recording failure” is no longer available, so it was cleared. Choose another one.',
      ),
    ).toBeTruthy();
    expect(category.textContent).toContain('CCTV & Video Surveillance');
    expect(subtype.textContent).toContain('Choose a sub-type…');
  });

  it('shows new options and fields of the chosen category without losing the input', async () => {
    const { dialog, queryClient } = renderModal();
    const subject = within(dialog()).getByRole('textbox', { name: /Subject/ });
    type(subject, 'Door reader');
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'CCTV');
    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), {
        ...FORM_CONFIG,
        version: 4,
        categories: FORM_CONFIG.categories.map((c) =>
          c.key === 'cctv'
            ? {
                ...c,
                fields: [
                  ...c.fields,
                  {
                    id: '00000000-0000-4000-8000-000000009001',
                    key: 'e2e_zone',
                    labelEn: 'Zone',
                    labelAr: 'المنطقة',
                    type: 'TEXT' as const,
                    options: [],
                    placeholderEn: null,
                    placeholderAr: null,
                    required: false,
                  },
                ],
              }
            : c,
        ),
      });
    });
    const zone = await within(dialog()).findByLabelText(/Zone/);
    expect((zone as HTMLInputElement).value).toBe('');
    expect((subject as HTMLInputElement).value).toBe('Door reader');
    expect(within(dialog()).queryByText(/no longer available/)).toBeNull();
  });

  /** The config with options of the Lab category's fields archived (dropped from the config). */
  const labWithout = (version: number, drop: Record<string, string>) => ({
    ...FORM_CONFIG,
    version,
    categories: FORM_CONFIG.categories.map((c) =>
      c.key === 'lab'
        ? {
            ...c,
            fields: c.fields.map((f) =>
              drop[f.key] ? { ...f, options: f.options.filter((o) => o.value !== drop[f.key]) } : f,
            ),
          }
        : c,
    ),
  });

  it('clears a chosen option an admin archived (multi-select, dropdown) so the form can be sent', async () => {
    api.createTicket.mockResolvedValueOnce(makeDetail({ number: 4901, ref: 'LG-4901' }));
    const { dialog, queryClient } = renderModal();
    type(within(dialog()).getByLabelText(/^Subject/), 'Lab check');
    await choose(within(dialog()).getByRole('combobox', { name: /^Category/ }), 'Lab');
    await choose(within(dialog()).getByRole('combobox', { name: /Sub-type/ }), 'Lab sub-type');
    await pick(within(dialog()).getByRole('combobox', { name: /Site/ }), /Building 3/);
    type(within(dialog()).getByLabelText(/^Description/), 'Every field type.');
    type(within(dialog()).getByLabelText(/^Room/), 'B-12');
    const vendor = within(dialog()).getByRole('combobox', { name: /^Vendor/ });
    await choose(vendor, 'Hikvision');
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Zone A' }));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Zone B' }));
    fireEvent.click(
      within(within(dialog()).getByRole('radiogroup', { name: /Engineer on site/ })).getByRole(
        'radio',
        { name: 'Yes' },
      ),
    );

    // An admin archives Zone B and Hikvision while the form is open.
    act(() => {
      queryClient.setQueryData(
        ticketKeys.formConfig(),
        labWithout(6, { zones: 'b', vendor: 'hik' }),
      );
    });
    const notice = await within(dialog()).findByText(
      'An option chosen in Vendor and Zones is no longer available, so it was cleared.',
    );
    expect(notice.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    const boxes = within(dialog()).getAllByRole('checkbox');
    expect(
      boxes.map((b) => [b.parentElement?.textContent, b.getAttribute('aria-checked')]),
    ).toEqual([['Zone A', 'true']]);
    expect(vendor.textContent).not.toContain('Hikvision');

    // The required dropdown needs a new choice; then the ticket goes out with what is left.
    await choose(vendor, 'Axis');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledTimes(1));
    expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({
      categoryId: IDS.lab,
      customFields: { room: 'B-12', vendor: 'axis', zones: ['a'], on_site: true },
    });
  });

  it('moves a Security Incident to the new security category when an admin changes it', async () => {
    api.createTicket.mockResolvedValueOnce(makeDetail({ number: 4902, ref: 'LG-4902' }));
    const { dialog, queryClient } = renderModal();
    fireEvent.click(
      radio(within(dialog()).getByRole('radiogroup', { name: 'Ticket type' }), 'Security Incident'),
    );
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    const subtype = within(dialog()).getByRole('combobox', { name: /Sub-type/ });
    await waitFor(() => expect(category.textContent).toContain('Cybersecurity / SOC'));
    await choose(subtype, 'Phishing');

    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), {
        ...FORM_CONFIG,
        version: 7,
        securityCategoryKey: 'other',
      });
    });
    expect(
      await within(dialog()).findByText(
        'Security incidents now go to Other, so the category was changed. Choose a sub-type.',
      ),
    ).toBeTruthy();
    expect(category.textContent).toContain('Other');
    expect(category.hasAttribute('disabled')).toBe(true);
    expect(subtype.textContent).toContain('Choose a sub-type…');

    type(within(dialog()).getByLabelText(/^Subject/), 'Suspicious email');
    await choose(subtype, 'Describe below');
    await pick(within(dialog()).getByRole('combobox', { name: /Site/ }), /Building 3/);
    type(within(dialog()).getByLabelText(/^Description/), 'A link asking for passwords.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledTimes(1));
    expect(api.createTicket.mock.calls[0]?.[0]).toMatchObject({
      type: 'SECURITY_INCIDENT',
      categoryId: IDS.other,
      subtypeId: IDS.describe,
    });
  });

  it('the moved-category notice goes once the type changes again', async () => {
    const { dialog, queryClient } = renderModal();
    const types = within(dialog()).getByRole('radiogroup', { name: 'Ticket type' });
    fireEvent.click(radio(types, 'Security Incident'));
    const category = within(dialog()).getByRole('combobox', { name: /^Category/ });
    await waitFor(() => expect(category.textContent).toContain('Cybersecurity / SOC'));
    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), {
        ...FORM_CONFIG,
        version: 7,
        securityCategoryKey: 'other',
      });
    });
    const moved =
      'Security incidents now go to Other, so the category was changed. Choose a sub-type.';
    expect(await within(dialog()).findByText(moved)).toBeTruthy();
    fireEvent.click(radio(types, 'Incident'));
    await waitFor(() => expect(within(dialog()).queryByText(moved)).toBeNull());
  });

  it('says it in Arabic too', async () => {
    const { dialog, queryClient } = renderModal(CLIENT, 'ar');
    await choose(within(dialog()).getByRole('combobox', { name: /^الفئة/ }), 'الدوائر');
    act(() => {
      queryClient.setQueryData(ticketKeys.formConfig(), withoutCctv(5));
    });
    expect(
      await within(dialog()).findByText(
        'لم تعد الفئة «الدوائر التلفزيونية والمراقبة بالفيديو» متاحة، لذا أُزيل اختيارها. اختر فئة أخرى.',
      ),
    ).toBeTruthy();
  });
});
