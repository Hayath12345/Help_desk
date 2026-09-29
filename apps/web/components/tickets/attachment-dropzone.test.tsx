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
import { quotaWait } from './upload-chip';

const FSI = '⁨';
const PDI = '⁩';

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterEach(cleanup);

function Harness({
  upload,
}: {
  upload: (file: File, options: UploadAttachmentOptions) => Promise<AttachmentDto>;
}) {
  const uploads = useAttachmentUploads({ visibility: 'public', upload });
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

describe('Upload over the daily budget', () => {
  it('rounds the wait up to whole minutes under an hour, whole hours from there', () => {
    expect(quotaWait(0)).toEqual({ unit: 'minutes', n: 1 });
    expect(quotaWait(1)).toEqual({ unit: 'minutes', n: 1 });
    expect(quotaWait(61)).toEqual({ unit: 'minutes', n: 2 });
    expect(quotaWait(3540)).toEqual({ unit: 'minutes', n: 59 });
    expect(quotaWait(3541)).toEqual({ unit: 'hours', n: 1 });
    expect(quotaWait(3600)).toEqual({ unit: 'hours', n: 1 });
    expect(quotaWait(3601)).toEqual({ unit: 'hours', n: 2 });
    expect(quotaWait(86_400)).toEqual({ unit: 'hours', n: 24 });
  });

  // Says that THIS file does not fit (a smaller one may still go through), not that nothing can.
  const EN =
    "This file doesn't fit in what's left of your upload allowance for the last 24 hours. Try again in ";
  const AR = 'هذا الملف أكبر مما تبقى من حد الرفع المسموح به خلال آخر 24 ساعة. حاول مرة أخرى بعد ';
  const cases = [
    // [locale, retryAfterSeconds, reason text]
    ['en', 5400, `${EN}2 hours.`],
    ['en', 3600, `${EN}1 hour.`],
    ['en', 30, `${EN}1 minute.`],
    ['en', 1500, `${EN}25 minutes.`],
    ['ar', 7200, `${AR}ساعتين.`],
    ['ar', 3 * 3600, `${AR}3 ساعات.`],
    ['ar', 11 * 3600, `${AR}11 ساعة.`],
    ['ar', 600, `${AR}10 دقائق.`],
    ['ar', 45, `${AR}دقيقة واحدة.`],
  ] as const;
  const words = {
    en: { failed: "Couldn't upload", retry: 'Retry uploading' },
    ar: { failed: 'تعذّر رفع', retry: 'إعادة رفع' },
  };

  it.each(cases)(
    '%s, %i s: says when to retry, under the chip and in the announcement, and keeps Retry',
    async (locale, seconds, reason) => {
      const { upload, fail } = failingUpload();
      const { add } = renderZone(locale, upload);
      add(new File(['log'], 'nvr-export.log', { type: 'text/plain' }));
      await fail(new UploadError('quota', 'limit', { retryAfterSeconds: seconds }));

      const { chip, item } = chipOf('nvr-export.log');
      expect(item.textContent).toContain(reason);
      expect(screen.getByRole('status').textContent?.trim()).toBe(
        `${words[locale].failed} ${FSI}nvr-export.log${PDI}. ${reason}`,
      );
      const retry = within(chip).getByRole('button', {
        name: `${words[locale].retry} nvr-export.log`,
      });
      const described = retry.getAttribute('aria-describedby')?.split(' ') ?? [];
      expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([reason]);

      // Retry starts the upload again.
      fireEvent.click(retry);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(reason)).toBeNull();
    },
  );
});

describe('Other presign refusals are not read as the security scan', () => {
  it.each([
    ['en', 'busy', 'Too many uploads in a short time. Wait a few minutes, then retry.'],
    ['ar', 'busy', 'عدد كبير من عمليات الرفع خلال وقت قصير. انتظر بضع دقائق ثم أعد المحاولة.'],
    ['en', 'allowance', 'The file is larger than your daily upload allowance.'],
    ['ar', 'allowance', 'حجم الملف أكبر من حد الرفع اليومي المسموح لك.'],
  ] as const)('%s, %s: its own text under the chip', async (locale, reason, text) => {
    const { upload, fail } = failingUpload();
    const { add } = renderZone(locale, upload);
    add(new File(['log'], 'nvr-export.log', { type: 'text/plain' }));
    await fail(new UploadError(reason, 'refused'));
    const { item } = chipOf('nvr-export.log');
    expect(item.textContent).toContain(text);
    expect(item.textContent).not.toContain(
      (locale === 'en' ? enTickets : arTickets).attachments.error.rejected,
    );
  });
});

describe('An image stored as its real type', () => {
  /** An upload the test finishes on demand with the stored attachment. */
  function finishingUpload() {
    let finish!: (attachment: AttachmentDto) => void;
    const upload = vi.fn(
      () =>
        new Promise<AttachmentDto>((resolve) => {
          finish = resolve;
        }),
    );
    return {
      upload,
      finish: (fileName: string, mimeType: string) =>
        act(async () =>
          finish({
            id: '00000000-0000-4000-8000-000000000042',
            fileName,
            mimeType,
            sizeBytes: 3,
            createdAt: '2026-09-23T12:00:00.000Z',
          }),
        ),
    };
  }

  it('the chip shows the stored name once the upload completed (a JPEG named .png)', async () => {
    const { upload, finish } = finishingUpload();
    const { add } = renderZone('en', upload);
    add(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'camera-14.png', { type: 'image/png' }));
    expect(screen.getByTitle('camera-14.png')).toBeTruthy();

    await finish('camera-14.jpg', 'image/jpeg');
    expect(screen.queryByTitle('camera-14.png')).toBeNull();
    const { chip } = chipOf('camera-14.jpg');
    expect(chip.textContent).toContain('camera-14.jpg');
    expect(chip.querySelector('svg.lucide-file-image')).toBeTruthy();
    expect(within(chip).getByRole('button', { name: 'Remove camera-14.jpg' })).toBeTruthy();
  });

  it('the chip icon follows the stored type', async () => {
    const { upload, finish } = finishingUpload();
    const { add } = renderZone('en', upload);
    add(new File(['x'], 'scan.txt', { type: 'text/plain' }));
    expect(chipOf('scan.txt').chip.querySelector('svg.lucide-file-text')).toBeTruthy();

    await finish('scan.png', 'image/png');
    const { chip } = chipOf('scan.png');
    expect(chip.querySelector('svg.lucide-file-image')).toBeTruthy();
    expect(chip.querySelector('svg.lucide-file-text')).toBeNull();
  });
});
