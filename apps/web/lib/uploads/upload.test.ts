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
const PUBLIC = { visibility: 'public' } as const;

describe('uploadAttachment', () => {
  it('presigns, posts the policy fields then the file to storage, and completes', async () => {
    api.post.mockResolvedValueOnce(PRESIGN).mockResolvedValueOnce({ attachment: STORED });
    const progress: number[] = [];
    const ticketId = '00000000-0000-4000-8000-000000000901';

    await expect(
      uploadAttachment(logFile(), {
        visibility: 'public',
        ticketId,
        onProgress: (p) => progress.push(p),
      }),
    ).resolves.toEqual(STORED);

    expect(api.post).toHaveBeenNthCalledWith(1, '/attachments/presign', {
      fileName: 'syslog.log',
      mimeType: 'text/plain',
      sizeBytes: 3,
      ticketId,
      visibility: 'public',
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
    await expect(uploadAttachment(new File(['x'], 'a.exe'), PUBLIC)).rejects.toMatchObject({
      reason: 'type',
    });
    await expect(
      uploadAttachment(new File([], 'empty.txt', { type: 'text/plain' }), PUBLIC),
    ).rejects.toMatchObject({
      reason: 'empty',
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('maps failures to reasons: storage, network, rejected (scan), aborted', async () => {
    api.post.mockResolvedValue(PRESIGN);
    FakeXhr.status = 403;
    await expect(uploadAttachment(logFile(), PUBLIC)).rejects.toMatchObject({ reason: 'storage' });

    FakeXhr.status = 204;
    FakeXhr.fail = true;
    await expect(uploadAttachment(logFile(), PUBLIC)).rejects.toMatchObject({ reason: 'network' });

    FakeXhr.fail = false;
    api.post
      .mockReset()
      .mockResolvedValueOnce(PRESIGN)
      .mockRejectedValueOnce(new ApiRequestError(422, 'VALIDATION_FAILED', 'infected'));
    const error = await uploadAttachment(logFile(), PUBLIC).catch((e: unknown) => e);
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
      await expect(uploadAttachment(logFile(), PUBLIC), refusal).rejects.toMatchObject({ reason });
    }

    api.post.mockReset().mockResolvedValueOnce(PRESIGN);
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadAttachment(logFile(), { ...PUBLIC, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'aborted' });
  });
});

describe('uploadAttachment: visibility (SEC-WEB-1)', () => {
  it('sends who the file is for with presign', async () => {
    for (const visibility of ['internal', 'public'] as const) {
      api.post
        .mockReset()
        .mockResolvedValueOnce(PRESIGN)
        .mockResolvedValueOnce({ attachment: STORED });
      await uploadAttachment(logFile(), { visibility });
      expect(api.post.mock.calls[0]?.[0]).toBe('/attachments/presign');
      expect(api.post.mock.calls[0]?.[1]).toMatchObject({ visibility });
    }
  });
});

describe('uploadAttachment: daily upload budget', () => {
  const quota = (details: unknown) =>
    new ApiRequestError(429, 'RATE_LIMITED', 'Daily upload limit reached', 'req-2', details);

  it('a presign 429 with daily-quota details is a quota failure that says when to retry', async () => {
    api.post.mockRejectedValueOnce(
      quota({ reason: 'daily-quota', limitBytes: 2 * 1024 ** 3, retryAfterSeconds: 5400 }),
    );
    const error = await uploadAttachment(logFile(), PUBLIC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ reason: 'quota', retryAfterSeconds: 5400 });
    // Nothing was sent to storage or completed.
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(FakeXhr.last).toBeNull();
  });

  it('other 429s are not read as the daily quota, nor as the security scan: busy', async () => {
    for (const details of [
      undefined,
      // The presign request limit (60 per 10 min) says only when to retry.
      { retryAfterSeconds: 120 },
      { reason: 'daily-quota' },
      { reason: 'other' },
    ]) {
      api.post.mockReset().mockRejectedValueOnce(quota(details));
      const error = await uploadAttachment(logFile(), PUBLIC).catch((e: unknown) => e);
      expect(error, JSON.stringify(details)).toMatchObject({
        reason: 'busy',
        retryAfterSeconds: null,
      });
    }
  });

  it('a file larger than the whole budget (presign 400 file_too_large) is an allowance failure', async () => {
    api.post.mockRejectedValueOnce(
      new ApiRequestError(400, 'VALIDATION_FAILED', 'Request validation failed', 'req-3', [
        {
          location: 'body',
          path: ['sizeBytes'],
          code: 'file_too_large',
          message: 'validation.tooLong',
        },
      ]),
    );
    const error = await uploadAttachment(logFile(), PUBLIC).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'allowance', retryAfterSeconds: null });
    expect(FakeXhr.last).toBeNull();

    // Other presign 400s keep the generic refusal.
    api.post.mockReset().mockRejectedValueOnce(
      new ApiRequestError(400, 'VALIDATION_FAILED', 'Request validation failed', 'req-4', [
        {
          location: 'body',
          path: ['mimeType'],
          code: 'file_type',
          message: 'validation.invalid',
        },
      ]),
    );
    await expect(uploadAttachment(logFile(), PUBLIC)).rejects.toMatchObject({
      reason: 'rejected',
    });
  });
});

describe('uploadAttachment: an image stored as its real type', () => {
  it('returns the stored name and type when complete corrected them (a JPEG named .png)', async () => {
    const corrected = { ...STORED, fileName: 'camera-14.jpg', mimeType: 'image/jpeg' };
    api.post.mockResolvedValueOnce(PRESIGN).mockResolvedValueOnce({ attachment: corrected });
    const jpegNamedPng = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'camera-14.png', {
      type: 'image/png',
    });
    await expect(uploadAttachment(jpegNamedPng, PUBLIC)).resolves.toEqual(corrected);
    // Declared as what the browser reported: the API detects and corrects it at complete.
    expect(api.post.mock.calls[0]?.[1]).toMatchObject({
      fileName: 'camera-14.png',
      mimeType: 'image/png',
    });
  });
});
