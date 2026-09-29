// @vitest-environment jsdom
import type { AttachmentDto } from '@loons/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UploadError, type UploadAttachmentOptions } from '@/lib/uploads/upload';
import { useAttachmentUploads } from '@/lib/uploads/use-attachment-uploads';
import arTickets from '@/messages/ar/tickets.json';
import enTickets from '@/messages/en/tickets.json';
import { AttachmentDropzone } from './attachment-dropzone';

const FSI = '⁨';
const PDI = '⁩';

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterEach(cleanup);

function Harness({
  upload,
}: {
  upload: (file: File, options?: UploadAttachmentOptions) => Promise<AttachmentDto>;
}) {
  const uploads = useAttachmentUploads({ upload });
  return <AttachmentDropzone uploads={uploads} />;
}

function renderZone(
  locale: 'en' | 'ar',
  upload = vi.fn(() => new Promise<AttachmentDto>(() => {})),
) {
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Qatar"
      messages={{ tickets: locale === 'ar' ? arTickets : enTickets }}
    >
      <Harness upload={upload} />
    </NextIntlClientProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  return {
    upload,
    add: (...files: File[]) => fireEvent.change(input, { target: { files } }),
  };
}

/** An upload the test fails on demand. */
function failingUpload() {
  let fail!: (error: unknown) => void;
  const upload = vi.fn(
    () =>
      new Promise<AttachmentDto>((_, reject) => {
        fail = reject;
      }),
  );
  return { upload, fail: (error: unknown) => act(async () => fail(error)) };
}

/** The chip of a file (the box with the icon, name, size and buttons) and its list item. */
function chipOf(name: string) {
  const chip = screen.getByTitle(name).parentElement!;
  return { chip, item: chip.parentElement! };
}

describe('AttachmentDropzone', () => {
  it('isolates file names in Arabic rejection messages, so a leading date keeps its order (DA-7)', () => {
    const { add } = renderZone('ar');
    add(new File(['MZ'], '2026-09-24 firewall.exe', { type: 'application/x-msdownload' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(`${FSI}2026-09-24 firewall.exe${PDI}: نوع الملف غير مدعوم.`);
  });

  it('says in text why an upload failed, and announces it politely (DA-10)', async () => {
    const { upload, fail } = failingUpload();
    const { add } = renderZone('en', upload);
    add(new File(['log'], '2026-09-24 firewall.log', { type: 'text/plain' }));
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');

    await fail(new UploadError('storage', 'boom'));

    // Under the chip: the reason in words (not only a red border).
    const { chip, item } = chipOf('2026-09-24 firewall.log');
    expect(item.textContent).toContain(enTickets.attachments.error.storage);
    expect(chip.className).toContain('bg-danger-tint');
    // The size stays readable on the failed chip's tint (ink-muted is below 4.5:1 there).
    expect(chip.querySelector('.font-mono')?.className).toContain('text-ink-secondary');
    expect(live.textContent?.trim()).toBe(
      `Couldn't upload ${FSI}2026-09-24 firewall.log${PDI}. The upload didn't finish.`,
    );
  });

  it('a file whose content is not its type is not "rejected by the scan"', async () => {
    const { upload, fail } = failingUpload();
    const { add } = renderZone('en', upload);
    add(new File(['not a png'], 'camera-12.png', { type: 'image/png' }));
    await fail(new UploadError('content', 'The file content does not match'));
    const { item } = chipOf('camera-12.png');
    expect(item.textContent).toContain('The file’s content doesn’t match its type.');
    expect(item.textContent).not.toContain(enTickets.attachments.error.rejected);
  });

  it('keeps the reason under the chip, so the name and the buttons stay inside it (UI-RR-1)', async () => {
    const { upload, fail } = failingUpload();
    const { add } = renderZone('en', upload);
    add(new File(['not a png'], 'camera-12-lobby-entrance.png', { type: 'image/png' }));
    await fail(new UploadError('content', 'The file content does not match'));

    const reason = enTickets.attachments.error.content;
    const { chip, item } = chipOf('camera-12-lobby-entrance.png');
    // The list item stacks the chip and the reason; the reason is a sibling of the chip, not
    // inside it (inside, its nowrap text used to squeeze the name to 0 px at 390 px and push the
    // buttons out of the clipped chip).
    expect(item.className).toContain('flex-col');
    const reasonEl = screen.getByText(reason);
    expect(reasonEl.parentElement).toBe(item);
    expect(reasonEl.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(chip.contains(reasonEl)).toBe(false);
    expect(chip.textContent).not.toContain(reason);
    expect(reasonEl.className).toContain('text-danger');
    expect(reasonEl.className).not.toContain('whitespace-nowrap');

    // Both buttons live in the chip and are described by the reason.
    const retry = within(chip).getByRole('button', {
      name: 'Retry uploading camera-12-lobby-entrance.png',
    });
    const remove = within(chip).getByRole('button', {
      name: 'Remove camera-12-lobby-entrance.png',
    });
    expect(reasonEl.id).toBeTruthy();
    for (const button of [retry, remove]) {
      const ids = button.getAttribute('aria-describedby')?.split(' ') ?? [];
      expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([reason]);
    }

    // The failure is announced through a status live region, with the name isolated.
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      `Couldn't upload ${FSI}camera-12-lobby-entrance.png${PDI}. ${reason}`,
    );

    // Removing the file clears the chip, the reason and the announcement.
    fireEvent.click(remove);
    expect(screen.queryByText(reason)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('announces only the newest failure, and nothing new when another failed file is removed (UI-RR-1)', async () => {
    // One pending upload per file, in the order the files were added.
    const rejecters: ((error: unknown) => void)[] = [];
    const upload = vi.fn(
      () =>
        new Promise<AttachmentDto>((_, reject) => {
          rejecters.push(reject);
        }),
    );
    const { add } = renderZone('en', upload);
    const names = ['nvr-a.log', 'nvr-b.log'];
    add(...names.map((name) => new File([name], name, { type: 'text/plain' })));
    expect(upload).toHaveBeenCalledTimes(2);
    const live = screen.getByRole('status');
    const fail = (name: string, reason: 'storage' | 'network') =>
      act(async () => rejecters[names.indexOf(name)]!(new UploadError(reason, 'boom')));
    const said = (name: string, reason: 'storage' | 'network') =>
      `Couldn't upload ${FSI}${name}${PDI}. ${enTickets.attachments.error[reason]}`;

    await fail('nvr-a.log', 'storage');
    expect(live.textContent).toBe(said('nvr-a.log', 'storage'));
    // The second failure is announced alone: the atomic region doesn't repeat the first.
    await fail('nvr-b.log', 'network');
    expect(live.textContent).toBe(said('nvr-b.log', 'network'));
    // Removing the other failed file changes nothing in the region (nothing is re-announced).
    fireEvent.click(screen.getByRole('button', { name: 'Remove nvr-a.log' }));
    expect(live.textContent).toBe(said('nvr-b.log', 'network'));
    // Removing the newest clears it; the earlier failures are not brought back.
    fireEvent.click(screen.getByRole('button', { name: 'Remove nvr-b.log' }));
    expect(live.textContent).toBe('');
  });

  it('a second file with the same name and reason still changes the region (round-2 verify)', async () => {
    const rejecters: ((error: unknown) => void)[] = [];
    const upload = vi.fn(
      () =>
        new Promise<AttachmentDto>((_, reject) => {
          rejecters.push(reject);
        }),
    );
    const { add } = renderZone('en', upload);
    add(
      new File(['one'], 'export.log', { type: 'text/plain' }),
      new File(['two!'], 'export.log', { type: 'text/plain' }),
    );
    expect(upload).toHaveBeenCalledTimes(2);
    const live = screen.getByRole('status');
    await act(async () => rejecters[0]!(new UploadError('network', 'boom')));
    const first = live.firstElementChild;
    expect(first?.textContent).toBe(
      `Couldn't upload ${FSI}export.log${PDI}. ${enTickets.attachments.error.network}`,
    );
    // The same words for another file: the text is replaced (a new node), so it is announced
    // again instead of leaving the region untouched.
    await act(async () => rejecters[1]!(new UploadError('network', 'boom')));
    const second = live.firstElementChild;
    expect(second?.textContent).toBe(first?.textContent);
    expect(second).not.toBe(first);
  });

  it('a chip that is still uploading describes its Remove button with nothing', () => {
    const { add } = renderZone('en');
    add(new File(['log'], 'switch.log', { type: 'text/plain' }));
    const remove = screen.getByRole('button', { name: 'Remove switch.log' });
    expect(remove.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });
});
