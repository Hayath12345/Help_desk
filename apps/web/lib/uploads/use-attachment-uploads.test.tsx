// @vitest-environment jsdom
import type { AttachmentDto } from '@loons/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UploadError, type UploadAttachmentOptions } from './upload';
import { useAttachmentUploads } from './use-attachment-uploads';

type Pending = {
  file: File;
  options: UploadAttachmentOptions;
  resolve: (a: AttachmentDto) => void;
  reject: (e: unknown) => void;
};

function fakeUploader() {
  const calls: Pending[] = [];
  const upload = vi.fn(
    (file: File, options: UploadAttachmentOptions = {}) =>
      new Promise<AttachmentDto>((resolve, reject) => {
        calls.push({ file, options, resolve, reject });
      }),
  );
  return { upload, calls };
}

const stored = (id: number, name: string): AttachmentDto => ({
  id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  fileName: name,
  mimeType: 'text/plain',
  sizeBytes: 3,
  createdAt: '2026-09-23T12:00:00.000Z',
});

const txt = (name: string) => new File(['abc'], name, { type: 'text/plain' });

describe('useAttachmentUploads', () => {
  it('uploads accepted files in parallel with progress and exposes the finished ids', async () => {
    const { upload, calls } = fakeUploader();
    const { result } = renderHook(() => useAttachmentUploads({ ticketId: 't1', upload }));

    let rejected: ReturnType<typeof result.current.add> = [];
    act(() => {
      rejected = result.current.add([txt('a.txt'), new File(['x'], 'b.exe'), txt('c.txt')]);
    });
    expect(rejected.map((r) => r.reason)).toEqual(['type']);
    expect(result.current.items.map((i) => [i.name, i.status])).toEqual([
      ['a.txt', 'uploading'],
      ['c.txt', 'uploading'],
    ]);
    expect(calls[0]?.options.ticketId).toBe('t1');
    expect(result.current.isUploading).toBe(true);

    act(() => calls[0]!.options.onProgress?.(0.5));
    expect(result.current.items[0]?.progress).toBe(0.5);

    await act(async () => {
      calls[0]!.resolve(stored(1, 'a.txt'));
      calls[1]!.resolve(stored(2, 'c.txt'));
    });
    await waitFor(() => expect(result.current.isUploading).toBe(false));
    expect(result.current.attachmentIds).toEqual([stored(1, 'a.txt').id, stored(2, 'c.txt').id]);
    expect(result.current.attachments).toHaveLength(2);
  });

  it('marks failures, retries them, and cancels removed or reset uploads', async () => {
    const { upload, calls } = fakeUploader();
    const { result } = renderHook(() => useAttachmentUploads({ upload }));
    act(() => {
      result.current.add([txt('a.txt'), txt('b.txt')]);
    });
    await act(async () => calls[0]!.reject(new UploadError('storage', 'nope')));
    expect(result.current.items[0]).toMatchObject({ status: 'error', error: 'storage' });
    expect(result.current.hasFailed).toBe(true);

    act(() => result.current.retry(result.current.items[0]!.id));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(result.current.items[0]).toMatchObject({ status: 'uploading', error: null });

    const second = calls[1]!;
    act(() => result.current.remove(result.current.items[1]!.id));
    expect(second.options.signal?.aborted).toBe(true);
    expect(result.current.items.map((i) => i.name)).toEqual(['a.txt']);

    act(() => result.current.reset());
    expect(calls[2]!.options.signal?.aborted).toBe(true);
    expect(result.current.items).toEqual([]);
  });

  it('counts uploads towards the 10-file and 25 MB limits', () => {
    const { upload } = fakeUploader();
    const { result } = renderHook(() =>
      useAttachmentUploads({ upload, limits: { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 5 } }),
    );
    let rejected: ReturnType<typeof result.current.add> = [];
    act(() => {
      rejected = result.current.add([txt('a.txt'), txt('b.txt')]);
    });
    expect(rejected.map((r) => r.reason)).toEqual(['total']);
    act(() => {
      rejected = result.current.add([
        new File(['a'], 'c.txt', { type: 'text/plain' }),
        txt('d.txt'),
      ]);
    });
    expect(rejected.map((r) => r.reason)).toEqual(['count']);
    expect(result.current.items).toHaveLength(2);
  });

  it('aborts in-flight uploads on unmount', () => {
    const { upload, calls } = fakeUploader();
    const { result, unmount } = renderHook(() => useAttachmentUploads({ upload }));
    act(() => {
      result.current.add([txt('a.txt')]);
    });
    unmount();
    expect(calls[0]!.options.signal?.aborted).toBe(true);
  });
});
