// @vitest-environment jsdom
import type { AttachmentDto } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { uploadAttachment } from '@/lib/uploads/upload';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import { Composer, type ComposerMode, type ComposerProps } from './composer';
import { createInboxWorld } from './test-world';

// ── The API (macros) comes from the in-memory world; presign bodies are recorded. ──
const presigns = vi.hoisted(() => ({ bodies: [] as unknown[] }));
vi.mock('@/lib/api/browser', async () => {
  const { createInboxWorld: create, worldRequest } = await import('./test-world');
  const world = create();
  const call = (method: 'GET' | 'POST' | 'PATCH') => async (path: string, body?: unknown) =>
    worldRequest(world, method, path, body);
  const post = call('POST');
  return {
    apiClient: {
      get: call('GET'),
      // A presign is recorded and never answers (the upload stays in progress).
      post: (path: string, body?: unknown) => {
        if (path !== '/attachments/presign') return post(path, body);
        presigns.bodies.push(body);
        return new Promise(() => undefined);
      },
      patch: call('PATCH'),
    },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

// ── Storage uploads: each test decides how an upload ends. ──
const uploads = vi.hoisted(() => ({
  impl: null as null | typeof uploadAttachment,
  /** The real upload (presign through the recorded API above). */
  actual: null as null | typeof uploadAttachment,
  calls: [] as { name: string; ticketId?: string; visibility: string }[],
}));
vi.mock('@/lib/uploads/upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/uploads/upload')>();
  uploads.actual = actual.uploadAttachment;
  return {
    ...actual,
    uploadAttachment: (file: File, options: Parameters<typeof uploadAttachment>[1]) => {
      uploads.calls.push({
        name: file.name,
        ticketId: options.ticketId,
        visibility: options.visibility,
      });
      return uploads.impl!(file, options);
    },
  };
});

let seq = 0;
const attachmentFor = (file: File): AttachmentDto => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    createdAt: new Date().toISOString(),
  };
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  uploads.calls = [];
  uploads.impl = async (file) => attachmentFor(file);
  presigns.bodies = [];
});
afterEach(cleanup);

const ticket = createInboxWorld().getTicket('LG-4821');

function renderComposer() {
  const sender = {
    send: vi.fn(),
    mutateAsync: vi.fn(async () => ({})),
  };
  function Harness() {
    const [mode, setMode] = useState<ComposerMode>('public');
    return (
      <Composer
        ticket={ticket}
        mode={mode}
        onModeChange={setMode}
        sender={sender as unknown as ComposerProps['sender']}
      />
    );
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="en"
        timeZone="Asia/Qatar"
        messages={{ common: enCommon, console: enConsole, tickets: enTickets, errors: enErrors }}
      >
        <Harness />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const fileInput = utils.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const attach = (...files: File[]) => fireEvent.change(fileInput, { target: { files } });
  return { ...utils, sender, attach };
}

const file = (name: string, type: string, size = 2048) =>
  new File([new Uint8Array(size)], name, { type });

function switchTo(name: 'Public reply' | 'Internal note') {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

const FSI = '⁨';
const PDI = '⁩';

describe('Composer attachments are kept per mode', () => {
  it('never sends a file added to an internal note with a public reply', async () => {
    const { sender, attach } = renderComposer();
    switchTo('Internal note');
    attach(file('internal-network-diagram.png', 'image/png'));
    const chip = await screen.findByText('internal-network-diagram.png');
    expect(uploads.calls).toEqual([
      { name: 'internal-network-diagram.png', ticketId: ticket.id, visibility: 'internal' },
    ]);
    // Uploaded: the size replaces the progress.
    await waitFor(() => expect(chip.parentElement?.textContent).toContain('KB'));

    // The public reply neither shows nor sends the note's file.
    switchTo('Public reply');
    expect(screen.queryByText('internal-network-diagram.png')).toBeNull();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Public reply to Fatima' }), {
      target: { value: 'An engineer is on the way.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send.mock.calls[0]![0]).toMatchObject({
      type: 'PUBLIC',
      attachmentIds: [],
      attachments: [],
    });

    // The note still has it, and sends it.
    switchTo('Internal note');
    expect(await screen.findByText('internal-network-diagram.png')).toBeTruthy();
    fireEvent.change(await screen.findByRole('textbox', { name: /Internal note/ }), {
      target: { value: 'Diagram attached.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(sender.send).toHaveBeenCalledTimes(2);
    const noteInput = sender.send.mock.calls[1]![0] as { attachmentIds: string[]; type: string };
    expect(noteInput.type).toBe('INTERNAL');
    expect(noteInput.attachmentIds).toHaveLength(1);
    expect(screen.queryByText('internal-network-diagram.png')).toBeNull();
  });

  it('never adds a file of a public reply to an internal note', async () => {
    const { sender, attach } = renderComposer();
    attach(file('site-photo.jpg', 'image/jpeg'));
    await screen.findByText('site-photo.jpg');
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());

    switchTo('Internal note');
    expect(screen.queryByText('site-photo.jpg')).toBeNull();
    fireEvent.change(await screen.findByRole('textbox', { name: /Internal note/ }), {
      target: { value: 'Checked the photo.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(sender.send.mock.calls[0]![0]).toMatchObject({ type: 'INTERNAL', attachmentIds: [] });

    switchTo('Public reply');
    expect(await screen.findByText('site-photo.jpg')).toBeTruthy();
  });

  it('presigns note files as internal and reply files as public (SEC-WEB-1)', async () => {
    uploads.impl = uploads.actual;
    const { attach } = renderComposer();
    switchTo('Internal note');
    attach(file('firewall-rules.txt', 'text/plain'));
    await waitFor(() => expect(presigns.bodies).toHaveLength(1));
    switchTo('Public reply');
    attach(file('site-photo.jpg', 'image/jpeg'));
    await waitFor(() => expect(presigns.bodies).toHaveLength(2));
    expect(presigns.bodies).toEqual([
      expect.objectContaining({
        fileName: 'firewall-rules.txt',
        ticketId: ticket.id,
        visibility: 'internal',
      }),
      expect.objectContaining({
        fileName: 'site-photo.jpg',
        ticketId: ticket.id,
        visibility: 'public',
      }),
    ]);
  });

  it('keeps a macro’s armed status with the draft it filled', async () => {
    renderComposer();
    switchTo('Internal note');
    fireEvent.click(await screen.findByRole('button', { name: 'Awaiting client access' }));
    const armed = '“Awaiting client access” sets the status to Pending when sent';
    expect(screen.getByText(armed)).toBeTruthy();
    switchTo('Public reply');
    expect(screen.queryByText(armed)).toBeNull();
    switchTo('Internal note');
    expect(screen.getByText(armed)).toBeTruthy();
  });
});

describe('Composer upload chips', () => {
  it('isolates file names in the chip and in rejection messages', async () => {
    const { attach } = renderComposer();
    attach(file('2026-09-24 firewall.log', 'text/plain'), file('setup.exe', ''));
    const name = await screen.findByText('2026-09-24 firewall.log');
    expect(name.getAttribute('dir')).toBe('auto');
    expect(screen.getByRole('alert').textContent).toBe(
      enTickets.attachments.rejected.type.replace('{name}', `${FSI}setup.exe${PDI}`),
    );
  });

  it('says why an upload failed, describes its buttons with it and announces it', async () => {
    const { UploadError } = await import('@/lib/uploads/upload');
    uploads.impl = async () => {
      throw new UploadError('network', 'offline');
    };
    const { attach } = renderComposer();
    attach(file('dvr-export.mp4', 'video/mp4'));

    const reason = enTickets.attachments.error.network;
    const text = await screen.findByText(reason);
    const retry = screen.getByRole('button', { name: 'Retry uploading dvr-export.mp4' });
    const remove = screen.getByRole('button', { name: 'Remove dvr-export.mp4' });
    for (const button of [retry, remove]) {
      const ids = button.getAttribute('aria-describedby')?.split(' ') ?? [];
      expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([reason]);
    }
    expect(text.id).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      `${FSI}dvr-export.mp4${PDI} couldn’t be uploaded. ${reason}`,
    );

    // The size stays AA-legible on the failed chip's danger tint (ink-muted is 4.23:1 there).
    const chip = screen.getByText('dvr-export.mp4').parentElement!;
    expect(chip.className).toContain('bg-danger-tint');
    const size = within(chip).getByText('2 KB');
    expect(size.className).toContain('text-ink-secondary');
    expect(size.className).not.toContain('text-ink-muted');

    // Retrying clears the failure (and its announcement).
    uploads.impl = async (f) => attachmentFor(f);
    act(() => fireEvent.click(retry));
    await waitFor(() => expect(screen.queryByText(reason)).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('announces only the newest failure, and nothing on removals or tab switches (UI-RR-1)', async () => {
    const { UploadError } = await import('@/lib/uploads/upload');
    uploads.impl = async (f) => {
      throw new UploadError(f.name.startsWith('dvr') ? 'network' : 'storage', 'failed');
    };
    const { attach } = renderComposer();
    const live = screen.getByRole('status');
    const said = (name: string, reason: string) =>
      `${FSI}${name}${PDI} couldn’t be uploaded. ${reason}`;

    attach(file('dvr-export.mp4', 'video/mp4'));
    await screen.findByRole('button', { name: 'Retry uploading dvr-export.mp4' });
    expect(live.textContent).toBe(said('dvr-export.mp4', enTickets.attachments.error.network));

    attach(file('nvr-export.mp4', 'video/mp4'));
    await screen.findByRole('button', { name: 'Retry uploading nvr-export.mp4' });
    const second = said('nvr-export.mp4', enTickets.attachments.error.storage);
    // Only the new failure: the atomic region doesn't read the first one again.
    expect(live.textContent).toBe(second);

    // Removing the first failed file changes nothing in the region.
    fireEvent.click(screen.getByRole('button', { name: 'Remove dvr-export.mp4' }));
    expect(live.textContent).toBe(second);

    // Switching to the note and back announces nothing; the chip still says why it failed.
    switchTo('Internal note');
    expect(live.textContent).toBe('');
    switchTo('Public reply');
    expect(live.textContent).toBe('');
    expect(screen.getByText(enTickets.attachments.error.storage)).toBeTruthy();
  });

  it('a second file with the same name and reason still changes the region (round-2 verify)', async () => {
    const { UploadError } = await import('@/lib/uploads/upload');
    const fails: ((error: unknown) => void)[] = [];
    uploads.impl = () =>
      new Promise<AttachmentDto>((_, reject) => {
        fails.push(reject);
      });
    const { attach } = renderComposer();
    const live = screen.getByRole('status');
    attach(file('export.log', 'text/plain', 10), file('export.log', 'text/plain', 20));
    await waitFor(() => expect(fails).toHaveLength(2));
    await act(async () => fails[0]!(new UploadError('network', 'offline')));
    const first = live.firstElementChild;
    expect(first?.textContent).toBe(
      `${FSI}export.log${PDI} couldn’t be uploaded. ${enTickets.attachments.error.network}`,
    );
    await act(async () => fails[1]!(new UploadError('network', 'offline')));
    expect(live.firstElementChild?.textContent).toBe(first?.textContent);
    expect(live.firstElementChild).not.toBe(first);
  });

  it('a reply upload that fails while the note is shown is announced on switching back (round-2 verify)', async () => {
    const { UploadError } = await import('@/lib/uploads/upload');
    let fail!: (error: unknown) => void;
    uploads.impl = () =>
      new Promise<AttachmentDto>((_, reject) => {
        fail = reject;
      });
    const { attach } = renderComposer();
    const live = screen.getByRole('status');
    attach(file('dvr-export.mp4', 'video/mp4'));
    await screen.findByText('dvr-export.mp4');

    // The agent writes a note while the reply's file uploads, and the upload fails.
    switchTo('Internal note');
    await act(async () => fail(new UploadError('network', 'offline')));
    expect(live.textContent).toBe('');

    // Back on the reply: the failure is announced once (it used to be never).
    switchTo('Public reply');
    const said = `${FSI}dvr-export.mp4${PDI} couldn’t be uploaded. ${enTickets.attachments.error.network}`;
    await waitFor(() => expect(live.textContent).toBe(said));
    // Nothing new failed on the note meanwhile: going there and back again says nothing.
    switchTo('Internal note');
    expect(live.textContent).toBe('');
    switchTo('Public reply');
    expect(live.textContent).toBe('');
  });
});
