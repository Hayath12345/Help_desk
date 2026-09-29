// @vitest-environment jsdom
import type { AttachmentDto, MessageDto, TicketDetailDto, TicketSummaryDto } from '@loons/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import type { RealtimeClient } from '@/lib/realtime/client';
import { toSummary } from '@/lib/tickets/cache';
import { IDS, TEAMS, fixtureId, makeDetail, makeMessage } from '@/lib/tickets/test-fixtures';
import {
  createPortalHarness,
  deferred,
  plain,
  type PortalHarness,
} from '../../_components/portal-test-utils';
import { TicketPage } from './ticket-page';

const api = vi.hoisted(() => ({
  fetchTicket: vi.fn(),
  fetchAllMessages: vi.fn(),
  postMessage: vi.fn(),
  updateTicket: vi.fn(),
}));
vi.mock('@/lib/tickets/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

const uploads = vi.hoisted(() => ({ uploadAttachment: vi.fn(), downloadAttachment: vi.fn() }));
vi.mock('@/lib/uploads/upload', async (importOriginal) => ({
  ...(await importOriginal()),
  ...uploads,
}));

const holder = vi.hoisted(() => ({ client: null as RealtimeClient | null }));
vi.mock('@/lib/realtime/client', async (importOriginal) => ({
  ...(await importOriginal()),
  getRealtimeClient: () => holder.client,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const PRIYA = { id: IDS.staff, name: 'Priya Shah' };
const TICKET = makeDetail({ assignee: PRIYA });
const FIRST = makeMessage();
const later = (minutes: number) =>
  new Date(Date.parse('2026-09-23T12:00:00.000Z') + minutes * 60_000).toISOString();

const agentReply = (overrides: Partial<MessageDto> = {}): MessageDto =>
  makeMessage({
    id: fixtureId(1002),
    body: 'Hi Aisha — I’m on it. Restarting the NVR service now.',
    author: { id: IDS.staff, name: 'Priya Shah', role: 'AGENT' },
    createdAt: later(5),
    ...overrides,
  });

const summaryOf = (ticket: TicketDetailDto, overrides: Partial<TicketSummaryDto> = {}) => ({
  ...toSummary(ticket),
  ...overrides,
});

let harness: PortalHarness;

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  Object.values(uploads).forEach((fn) => fn.mockReset());
  toast.success.mockReset();
  toast.error.mockReset();
  api.fetchTicket.mockResolvedValue(TICKET);
  api.fetchAllMessages.mockResolvedValue([FIRST]);
  harness = createPortalHarness();
  holder.client = harness.client;
});
afterEach(cleanup);

async function renderPage(ticket: TicketDetailDto = TICKET, h: PortalHarness = harness) {
  api.fetchTicket.mockResolvedValue(ticket);
  const view = render(<TicketPage ticketRef="LG-4771" />, { wrapper: h.wrapper });
  await screen.findByRole('heading', { level: 1 });
  await screen.findByText(FIRST.body);
  return view;
}

const pill = () => screen.getByRole('heading', { level: 1 }).parentElement!.lastElementChild!;
const replyBox = () => screen.getByRole('textbox', { name: 'Your reply' }) as HTMLTextAreaElement;

describe('Ticket thread page', () => {
  it('shows the header, the conversation and the reply box like the design', async () => {
    render(<TicketPage ticketRef="LG-4771" />, { wrapper: harness.wrapper });
    expect(screen.getByRole('status').textContent).toBe('Loading the ticket…');

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(TICKET.subject);
    expect(api.fetchTicket).toHaveBeenCalledWith('LG-4771', expect.anything());
    expect(screen.getByRole('link', { name: 'All tickets' }).getAttribute('href')).toBe('/tickets');
    const meta = screen.getByText(
      (_, el) => el?.tagName === 'P' && /^LG-4771/.test(el.textContent ?? ''),
    );
    expect(meta.textContent).toBe(
      'LG-4771 · CCTV & Video Surveillance › NVR / VMS recording failure · HMC – Building 3, Level 2',
    );
    expect(pill().textContent).toBe('Open');
    // Design copy: "Handled by Maya Ruiz (SOC) · Opened …" (UI-RR-4).
    expect(plain(screen.getByText(/^Handled by/).textContent)).toBe(
      'Handled by Priya Shah (ELV Field) · Opened Sep 23, 15:00',
    );
    expect(screen.getByRole('button', { name: 'Mark as solved' })).toBeTruthy();

    const log = await screen.findByRole('log');
    const bubble = within(log).getByRole('article');
    expect(within(bubble).getByText('Dr. Aisha Al-Kuwari')).toBeTruthy();
    expect(within(bubble).getByText('Client')).toBeTruthy();
    expect(within(bubble).getByText(FIRST.body)).toBeTruthy();

    expect(replyBox().getAttribute('placeholder')).toBe('Write a reply…');
    expect(screen.getByText('We’ll email you when an engineer responds.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeTruthy();
  });

  it('names only the team while nobody is assigned', async () => {
    await renderPage(makeDetail({ assignee: null }));
    expect(plain(screen.getByText(/^Handled by/).textContent)).toBe(
      'Handled by ELV Field · Opened Sep 23, 15:00',
    );
  });

  it('names only the team in Arabic too, without adding "فريق" to its name (UI-RR-4)', async () => {
    const ar = createPortalHarness({ locale: 'ar' });
    holder.client = ar.client;
    // ELV's Arabic name already starts with "فريق" ("team"): the header must not say it twice.
    await renderPage(makeDetail({ assignee: null, team: TEAMS.elv }), ar);
    const header = plain(screen.getByText(/^يتولاها/).textContent);
    expect(header).toMatch(/^يتولاها فريق الأنظمة الميدانية · /);
    expect(header).not.toContain('فريق فريق');
    cleanup();

    // Design: "يتولاها" followed directly by the team's name.
    const ar2 = createPortalHarness({ locale: 'ar' });
    holder.client = ar2.client;
    await renderPage(makeDetail({ assignee: null, team: TEAMS.soc }), ar2);
    expect(plain(screen.getByText(/^يتولاها/).textContent)).toMatch(
      /^يتولاها مركز العمليات الأمنية · /,
    );
  });

  it('marks the ticket solved optimistically, keeps focus and confirms with a toast', async () => {
    await renderPage();
    const call = deferred<TicketDetailDto>();
    api.updateTicket.mockReturnValueOnce(call.promise);

    const button = screen.getByRole('button', { name: 'Mark as solved' });
    button.focus();
    fireEvent.click(button);

    await waitFor(() => expect(pill().textContent).toBe('Solved'));
    expect(api.updateTicket).toHaveBeenCalledWith(TICKET.id, { status: 'SOLVED' });
    expect(button.textContent).toBe('Reopen ticket');
    expect(document.activeElement).toBe(button);
    expect(screen.getByText('Replying will reopen this ticket.')).toBeTruthy();

    // A second click while the save is in flight is ignored.
    fireEvent.click(button);
    expect(api.updateTicket).toHaveBeenCalledTimes(1);

    await act(async () =>
      call.resolve({ ...TICKET, status: 'SOLVED', solvedAt: later(1), updatedAt: later(1) }),
    );
    expect(toast.success).toHaveBeenCalledWith('Ticket marked as solved');
    expect(pill().textContent).toBe('Solved');
  });

  it('rolls a failed reopen back and explains why', async () => {
    const solved = makeDetail({ assignee: PRIYA, status: 'SOLVED', solvedAt: later(1) });
    await renderPage(solved);
    api.updateTicket.mockRejectedValueOnce(new ApiRequestError(409, 'CONFLICT', 'changed'));

    fireEvent.click(screen.getByRole('button', { name: 'Reopen ticket' }));
    await waitFor(() =>
      expect(api.updateTicket).toHaveBeenCalledWith(TICKET.id, { status: 'OPEN' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(pill().textContent).toBe('Solved');
    expect(screen.getByRole('button', { name: 'Reopen ticket' })).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('sends a reply optimistically and reconciles the server and realtime copies', async () => {
    await renderPage();
    act(() => harness.socket().accept());
    const call = deferred<{ message: MessageDto; ticket: TicketSummaryDto }>();
    api.postMessage.mockReturnValueOnce(call.promise);

    fireEvent.change(replyBox(), { target: { value: '  Camera 14 is still not recording.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(replyBox().value).toBe('');
    expect(document.activeElement).toBe(replyBox());
    await screen.findByText('Sending…');
    expect(api.postMessage).toHaveBeenCalledWith(TICKET.id, {
      type: 'PUBLIC',
      body: 'Camera 14 is still not recording.',
      clientTempId: expect.any(String),
      attachmentIds: [],
      andSolve: false,
    });
    const { clientTempId } = api.postMessage.mock.calls[0]![1] as { clientTempId: string };

    const stored = makeMessage({
      id: fixtureId(1003),
      body: 'Camera 14 is still not recording.',
      clientTempId,
      createdAt: later(2),
    });
    // The realtime copy can arrive before the HTTP answer: still one message.
    act(() => harness.socket().receive('message:new', { ticketId: TICKET.id, message: stored }));
    await act(async () =>
      call.resolve({ message: stored, ticket: summaryOf(TICKET, { updatedAt: later(2) }) }),
    );
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
    expect(screen.getAllByText('Camera 14 is still not recording.')).toHaveLength(1);
    expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(2);
  });

  it('predicts the reopen when replying to a solved ticket', async () => {
    await renderPage(makeDetail({ assignee: PRIYA, status: 'SOLVED', solvedAt: later(1) }));
    api.postMessage.mockReturnValueOnce(new Promise(() => undefined));
    expect(screen.getByText('Replying will reopen this ticket.')).toBeTruthy();

    fireEvent.change(replyBox(), { target: { value: 'It stopped again.' } });
    fireEvent.keyDown(replyBox(), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(pill().textContent).toBe('Open'));
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByText('We’ll email you when an engineer responds.')).toBeTruthy();
  });

  it('asks for a message instead of sending an empty reply', async () => {
    await renderPage();
    fireEvent.change(replyBox(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    expect(screen.getByRole('alert').textContent).toBe('Write a message first.');
    expect(replyBox().getAttribute('aria-invalid')).toBe('true');
    expect(replyBox().getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    expect(api.postMessage).not.toHaveBeenCalled();

    fireEvent.change(replyBox(), { target: { value: 'Hello' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(replyBox().getAttribute('aria-invalid')).toBeNull();
  });

  it('attaches files to a reply once they have uploaded', async () => {
    await renderPage();
    const upload = deferred<AttachmentDto>();
    uploads.uploadAttachment.mockReturnValueOnce(upload.promise);
    api.postMessage.mockReturnValueOnce(new Promise(() => undefined));

    const attach = screen.getByRole('button', { name: 'Attach files' });
    fireEvent.click(attach);
    expect(attach.getAttribute('aria-expanded')).toBe('true');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['png'], 'camera-14.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(uploads.uploadAttachment).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ ticketId: TICKET.id }),
      ),
    );

    fireEvent.change(replyBox(), { target: { value: 'Screenshot attached.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Wait for the attachments to finish uploading.',
    );
    expect(api.postMessage).not.toHaveBeenCalled();

    const stored: AttachmentDto = {
      id: fixtureId(2001),
      fileName: 'camera-14.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      createdAt: later(1),
    };
    await act(async () => upload.resolve(stored));
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(api.postMessage).toHaveBeenCalledWith(
        TICKET.id,
        expect.objectContaining({ body: 'Screenshot attached.', attachmentIds: [stored.id] }),
      ),
    );
    // The optimistic bubble already shows the file; the attachment zone closes.
    const log = screen.getByRole('log');
    await waitFor(() =>
      expect(within(log).getByRole('button', { name: /camera-14\.png/ })).toBeTruthy(),
    );
    await waitFor(() => expect(document.querySelector('input[type="file"]')).toBeNull());
  });

  it('isolates the names of files dropped beside the attachment zone and refused (DA-7)', async () => {
    await renderPage();
    const form = screen.getByRole('form', { name: 'Your reply' });
    const file = new File(['MZ'], '2026-09-24 setup.exe', { type: 'application/x-msdownload' });
    fireEvent.drop(form, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(screen.getByRole('alert').textContent).toBe(
      "⁨2026-09-24 setup.exe⁩: this file type isn't supported.",
    );
  });

  it('shows agents’ replies and status changes live, and colleagues typing', async () => {
    await renderPage();
    act(() => harness.socket().accept());
    expect(harness.socket().eventsNamed('ticket:join')).toEqual([{ ticketId: TICKET.id }]);

    const reply = agentReply();
    act(() => harness.socket().receive('message:new', { ticketId: TICKET.id, message: reply }));
    const bubble = (await screen.findByText(reply.body)).closest('article')!;
    expect(within(bubble).getByText('Loons Support')).toBeTruthy();

    // The API now answers with the new state (the push also refreshes the detail).
    api.fetchTicket.mockResolvedValue({ ...TICKET, status: 'PENDING', updatedAt: later(5) });
    act(() =>
      harness.socket().receive('ticket:updated', {
        ticket: summaryOf(TICKET, { status: 'PENDING', updatedAt: later(5) }),
      }),
    );
    await waitFor(() => expect(pill().textContent).toBe('Pending'));

    const colleague = { id: fixtureId(502), name: 'Khalid Mansouri' };
    act(() => {
      harness.socket().receive('message:typing', {
        ticketId: TICKET.id,
        user: colleague,
        isTyping: true,
        scope: 'public',
      });
      // Never delivered to clients by the server; ignored even if it were.
      harness.socket().receive('message:typing', {
        ticketId: TICKET.id,
        user: { id: IDS.staff, name: 'Priya Shah' },
        isTyping: true,
        scope: 'internal',
      });
    });
    expect(screen.getByText('Khalid Mansouri is typing…')).toBeTruthy();
    expect(screen.queryByText(/Priya Shah is/)).toBeNull();
  });

  it('announces its own typing to the ticket room and stops after sending', async () => {
    await renderPage();
    act(() => harness.socket().accept());
    api.postMessage.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.change(replyBox(), { target: { value: 'Typing…' } });
    const typing = () => harness.socket().eventsNamed('message:typing');
    expect(typing()).toEqual([{ ticketId: TICKET.id, isTyping: true, scope: 'public' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(typing().at(-1)).toEqual({ ticketId: TICKET.id, isTyping: false, scope: 'public' });
  });

  it('catches up on missed replies after a reconnect', async () => {
    await renderPage();
    act(() => harness.socket().accept());
    act(() => harness.socket().transportClose());

    const missed = agentReply();
    api.fetchAllMessages.mockResolvedValueOnce([missed]);
    act(() => harness.socket().accept());

    expect(await screen.findByText(missed.body)).toBeTruthy();
    expect(api.fetchAllMessages).toHaveBeenCalledWith(TICKET.id, { after: FIRST.id });
  });

  it('says when live updates have stopped', async () => {
    await renderPage();
    act(() => harness.client.stop());
    expect(
      await screen.findByText('Live updates are paused. Reload the page to see new replies.'),
    ).toBeTruthy();
  });

  it('shows a not-found page for unknown or hidden tickets', async () => {
    api.fetchTicket.mockRejectedValue(new ApiRequestError(404, 'NOT_FOUND', 'nope'));
    render(<TicketPage ticketRef="LG-9999" />, { wrapper: harness.wrapper });
    expect(
      (await screen.findByRole('heading', { level: 1, name: 'Ticket not found' })).textContent,
    ).toBe('Ticket not found');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('replaces the reply box on closed tickets', async () => {
    await renderPage(makeDetail({ assignee: PRIYA, status: 'CLOSED', solvedAt: later(1) }));
    expect(pill().textContent).toBe('Closed');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /solved|Reopen/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'This ticket is closed' })).toBeTruthy();
  });

  it('renders in Arabic with mirrored copy', async () => {
    const ar = createPortalHarness({ locale: 'ar' });
    holder.client = ar.client;
    render(<TicketPage ticketRef="LG-4771" />, { wrapper: ar.wrapper });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: 'كل التذاكر' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تحديد كمحلولة' })).toBeTruthy();
    expect(plain(screen.getByText(/^يتولاها/).textContent)).toContain(
      'يتولاها Priya Shah · فريق الأنظمة الميدانية',
    );
    expect(screen.getByRole('textbox', { name: 'ردّك' }).getAttribute('placeholder')).toBe(
      'اكتب ردًا…',
    );
    expect(screen.getByText('سنراسلك عندما يرد أحد المهندسين.')).toBeTruthy();
  });

  it('Arabic header: no double parentheses, and config names keep the page direction (DA-5, DA-6)', async () => {
    const ar = createPortalHarness({ locale: 'ar' });
    holder.client = ar.client;
    const soc = {
      id: fixtureId(104),
      key: 'soc',
      nameEn: 'SOC',
      nameAr: 'مركز العمليات الأمنية (SOC)',
    };
    const qnbSite = {
      id: IDS.siteA,
      name: 'QNB – Head Office, West Bay',
      nameAr: 'QNB – المقر الرئيسي، الخليج الغربي',
    };
    api.fetchTicket.mockResolvedValue(makeDetail({ assignee: PRIYA, team: soc, site: qnbSite }));
    render(<TicketPage ticketRef="LG-4771" />, { wrapper: ar.wrapper });
    await screen.findByRole('heading', { level: 1 });
    const handledBy = plain(screen.getByText(/^يتولاها/).textContent);
    expect(handledBy).toContain('يتولاها Priya Shah · مركز العمليات الأمنية (SOC) · ');
    expect(handledBy).not.toMatch(/\(\(|\)\)/);
    // An isolate with dir="auto" would take the Latin "QNB" as its direction and reverse the name.
    const site = screen.getByText(qnbSite.nameAr);
    expect(site.tagName).toBe('BDI');
    expect(site.getAttribute('dir')).toBe('rtl');
    // The subject is typed in either language: it keeps the automatic direction.
    expect(
      screen.getByRole('heading', { level: 1 }).querySelector('bdi')?.hasAttribute('dir'),
    ).toBe(false);
  });
});
