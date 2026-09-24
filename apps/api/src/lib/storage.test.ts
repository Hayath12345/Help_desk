import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  StorageValidationError,
  buildObjectKey,
  createStorage,
  isAllowedMimeType,
  noopScanHook,
  normalizeMimeType,
  sanitizeFileName,
} from './storage.ts';

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\Desktop\\photo.JPG', 'photo.jpg'],
    ['  spaced   out   name .txt ', 'spaced out name .txt'],
    ['...hidden', 'hidden'],
    ['inv<a>l|d:na"me?.log', 'inv_a_l_d_na_me_.log'],
    ['CON.txt', '_CON.txt'],
    ['nul', '_nul'],
    ['', 'file'],
    ['....', 'file'],
    ['تقرير الحادث.pdf', 'تقرير الحادث.pdf'],
    ['evil\u202Etxt.exe', 'eviltxt.exe'],
    ['tab\tand\nnewline.txt', 'tabandnewline.txt'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['noext.', 'noext'],
    ['weird.ext-with-dash', 'weird.ext-with-dash'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('caps the length and keeps the extension', () => {
    const out = sanitizeFileName(`${'a'.repeat(400)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('never returns path separators', () => {
    for (const input of ['a/b/c.txt', 'a\\b\\c.txt', '/', '\\', 'x/../y']) {
      expect(sanitizeFileName(input)).not.toMatch(/[/\\]/);
    }
  });
});

describe('MIME allow-list', () => {
  it('accepts images, video, PDF, text/log and zip', () => {
    for (const mime of [
      'image/png',
      'image/jpeg',
      'video/mp4',
      'application/pdf',
      'text/plain',
      'text/x-log',
      'application/zip',
    ]) {
      expect(isAllowedMimeType(mime)).toBe(true);
    }
  });

  it('normalizes case and parameters', () => {
    expect(normalizeMimeType('Image/PNG; charset=binary')).toBe('image/png');
    expect(isAllowedMimeType('TEXT/PLAIN; charset=utf-8')).toBe(true);
  });

  it('rejects executables, scripts and HTML', () => {
    for (const mime of [
      'application/x-msdownload',
      'application/x-sh',
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'application/octet-stream',
      '',
    ]) {
      expect(isAllowedMimeType(mime)).toBe(false);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALLOWED_UPLOAD_MIME_TYPES).size).toBe(ALLOWED_UPLOAD_MIME_TYPES.length);
  });
});

describe('storage presigning (no network)', () => {
  const s3 = {
    region: 'me-central-1',
    bucket: 'test-bucket',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    uploadMaxBytes: 25 * 1024 * 1024,
  };
  const storage = createStorage(s3);

  it('builds keys as <scope>/<uuid>/<sanitized name>', () => {
    expect(buildObjectKey('tickets/abc', '../x y.PDF')).toMatch(
      /^tickets\/abc\/[0-9a-f-]{36}\/x y\.pdf$/,
    );
  });

  it('creates a POST policy with a size range and exact content type', async () => {
    const post = await storage.createUploadPost({
      key: 'tickets/t1/u1/a.png',
      contentType: 'image/png',
      maxBytes: 1024,
    });
    expect(post.url).toBe('http://localhost:9000/test-bucket');
    expect(post.fields['Content-Type']).toBe('image/png');
    expect(post.fields.key).toBe('tickets/t1/u1/a.png');
    const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8'));
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, 1024],
        ['eq', '$Content-Type', 'image/png'],
      ]),
    );
  });

  it('refuses disallowed types and sizes above UPLOAD_MAX_BYTES', async () => {
    await expect(
      storage.createUploadPost({ key: 'k', contentType: 'text/html', maxBytes: 10 }),
    ).rejects.toBeInstanceOf(StorageValidationError);
    await expect(
      storage.createUploadPost({
        key: 'k',
        contentType: 'image/png',
        maxBytes: s3.uploadMaxBytes + 1,
      }),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('signs short-lived download URLs with an attachment disposition', async () => {
    const url = new URL(
      await storage.getDownloadUrl('tickets/t1/u1/a.pdf', { fileName: 'تقرير.pdf', expiresIn: 60 }),
    );
    expect(url.origin + url.pathname).toBe('http://localhost:9000/test-bucket/tickets/t1/u1/a.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('response-content-disposition')).toContain(
      "attachment; filename*=UTF-8''",
    );
    expect(url.searchParams.has('x-amz-checksum-mode')).toBe(false);
  });

  it('the default scan hook reports NOT_SCANNED', async () => {
    expect(
      await noopScanHook.scan({ bucket: 'b', key: 'k', contentType: 'image/png', sizeBytes: 1 }),
    ).toEqual({
      verdict: 'NOT_SCANNED',
    });
  });
});
