import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { UploadError, uploadAttachment } from './upload';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({ apiClient: api }));

const ATTACHMENT_ID = '00000000-0000-4000-8000-000000001101';
const PRESIGN = {
  attachmentId: ATTACHMENT_ID,
  upload: {
    url: 'http://localhost:9000/loons-attachments',
    fields: { key: 'k/1', 'Content-Type': 'text/plain', Policy: 'p', 'X-Amz-Signature': 's' },
  },
  expiresAt: '2026-09-23T12:15:00.000Z',
};
const STORED = {
  id: ATTACHMENT_ID,
  fileName: 'syslog.log',
  mimeType: 'text/plain',
  sizeBytes: 3,
  createdAt: '2026-09-23T12:00:00.000Z',
};

/** Records the storage POST and answers with `status` (after two progress events). */
class FakeXhr {
  static last: FakeXhr | null = null;
  static status = 204;
  static fail = false;
  method = '';
  url = '';
  body: FormData | null = null;
  status = 0;
  private listeners = new Map<string, (event?: unknown) => void>();
  upload = {
    listeners: new Map<string, (event: unknown) => void>(),
    addEventListener(type: string, fn: (event: unknown) => void) {
      this.listeners.set(type, fn);
    },
  };
  addEventListener(type: string, fn: (event?: unknown) => void) {
    this.listeners.set(type, fn);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXhr.last = this;
    queueMicrotask(() => {
      if (FakeXhr.fail) {
        this.listeners.get('error')?.();
        return;
      }
      const progress = this.upload.listeners.get('progress');
      progress?.({ lengthComputable: true, loaded: 1, total: 2 });
      progress?.({ lengthComputable: true, loaded: 2, total: 2 });
      this.status = FakeXhr.status;
      this.listeners.get('load')?.();
    });
  }
  abort() {
    this.listeners.get('abort')?.();
  }
}

beforeEach(() => {
  api.post.mockReset();
  FakeXhr.last = null;
  FakeXhr.status = 204;
  FakeXhr.fail = false;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

const logFile = () => new File(['abc'], 'syslog.log', { type: '' });

describe('uploadAttachment', () => {
  it('presigns, posts the policy fields then the file to storage, and completes', async () => {
    api.post.mockResolvedValueOnce(PRESIGN).mockResolvedValueOnce({ attachment: STORED });
    const progress: number[] = [];
    const ticketId = '00000000-0000-4000-8000-000000000901';

    await expect(
      uploadAttachment(logFile(), { ticketId, onProgress: (p) => progress.push(p) }),
    ).resolves.toEqual(STORED);

    expect(api.post).toHaveBeenNthCalledWith(1, '/attachments/presign', {
      fileName: 'syslog.log',
      mimeType: 'text/plain',
      sizeBytes: 3,
      ticketId,
    });
    expect(api.post).toHaveBeenNthCalledWith(2, `/attachments/${ATTACHMENT_ID}/complete`);
    const xhr = FakeXhr.last!;
    expect([xhr.method, xhr.url]).toEqual(['POST', PRESIGN.upload.url]);
    const keys = [...xhr.body!.keys()];
    expect(keys).toEqual(['key', 'Content-Type', 'Policy', 'X-Amz-Signature', 'file']);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('refuses files the API would refuse, before presigning', async () => {
    await expect(uploadAttachment(new File(['x'], 'a.exe'))).rejects.toMatchObject({
      reason: 'type',
    });
    await expect(
      uploadAttachment(new File([], 'empty.txt', { type: 'text/plain' })),
    ).rejects.toMatchObject({
      reason: 'empty',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('maps failures to reasons: storage, network, rejected (scan), aborted', async () => {
    api.post.mockResolvedValue(PRESIGN);
    FakeXhr.status = 403;
    await expect(uploadAttachment(logFile())).rejects.toMatchObject({ reason: 'storage' });

    FakeXhr.status = 204;
    FakeXhr.fail = true;
    await expect(uploadAttachment(logFile())).rejects.toMatchObject({ reason: 'network' });

    FakeXhr.fail = false;
    api.post
      .mockReset()
      .mockResolvedValueOnce(PRESIGN)
      .mockRejectedValueOnce(new ApiRequestError(422, 'VALIDATION_FAILED', 'infected'));
    const error = await uploadAttachment(logFile()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ reason: 'rejected' });

    // complete's refusal reason (details.reason) picks the message: a file whose bytes aren't its
    // type is not "rejected by the scan"; a size/type mismatch reads as an unfinished upload.
    for (const [refusal, reason] of [
      ['content', 'content'],
      ['infected', 'rejected'],
      ['mismatch', 'storage'],
    ] as const) {
      api.post
        .mockReset()
        .mockResolvedValueOnce(PRESIGN)
        .mockRejectedValueOnce(
          new ApiRequestError(400, 'BAD_REQUEST', 'refused', 'req-1', { reason: refusal }),
        );
      await expect(uploadAttachment(logFile()), refusal).rejects.toMatchObject({ reason });
    }

    api.post.mockReset().mockResolvedValueOnce(PRESIGN);
    const controller = new AbortController();
    controller.abort();
    await expect(uploadAttachment(logFile(), { signal: controller.signal })).rejects.toMatchObject({
      reason: 'aborted',
    });
  });
});
