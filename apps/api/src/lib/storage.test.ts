import { describe, expect, it } from 'vitest';
import { toWellFormed } from '@loons/shared';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  StorageValidationError,
  buildObjectKey,
  buildStoredKey,
  contentMatchesMimeType,
  copySource,
  createStorage,
  detectAllowedImageType,
  fileNameForDetectedType,
  fileNameForMimeType,
  isAllowedImageMimeType,
  isAllowedMimeType,
  noopScanHook,
  normalizeMimeType,
  rfc5987,
  MAX_FILE_NAME_BYTES,
  sanitizeFileName,
} from './storage.ts';

const bytes = (...values: Array<number | string>): Uint8Array =>
  Uint8Array.from(
    values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );

describe('fileNameForMimeType (review SEC-ATT-2)', () => {
  it.each([
    ['report.pdf', 'application/pdf', 'report.pdf'],
    ['REPORT.PDF', 'application/pdf', 'REPORT.pdf'],
    ['Invoice.pdf.exe', 'application/pdf', 'Invoice.pdf.exe.pdf'],
    ['help.hta', 'text/plain', 'help.hta.txt'],
    ['firewall.log', 'text/plain', 'firewall.log'],
    ['firewall.log', 'text/x-log', 'firewall.log'],
    ['notes', 'text/plain', 'notes.txt'],
    ['photo.png.scr', 'image/png', 'photo.png.scr.png'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['IMG_1.HEIC', 'image/heif', 'IMG_1.heic'],
    ['clip.mov', 'video/quicktime', 'clip.mov'],
    ['clip.mov', 'video/mp4', 'clip.mov.mp4'],
    ['weird.ext-with-dash', 'text/plain', 'weird.ext-with-dash.txt'],
    ['../../evil.bat', 'Application/ZIP; x=1', 'evil.bat.zip'],
    ['', 'application/pdf', 'file.pdf'],
  ])('%j as %s → %j', (name, mime, expected) => {
    expect(fileNameForMimeType(name, mime)).toBe(expected);
  });

  it('keeps the length cap with the appended extension', () => {
    const out = fileNameForMimeType(`${'a'.repeat(400)}.exe`, 'application/pdf');
    expect(Buffer.byteLength(out)).toBe(MAX_FILE_NAME_BYTES);
    expect(out.endsWith('.pdf')).toBe(true);
  });
});

describe('contentMatchesMimeType (magic numbers)', () => {
  const MZ = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00);
  it.each([
    ['application/pdf', bytes('%PDF-1.7\n')],
    ['application/pdf', bytes('\xef\xbb\xbf  %PDF-1.4')],
    ['image/png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/gif', bytes('GIF89a')],
    ['image/webp', bytes('RIFF', 1, 2, 3, 4, 'WEBPVP8 ')],
    ['image/bmp', bytes('BM', 0, 0)],
    ['image/tiff', bytes('II*', 0)],
    ['image/tiff', bytes('MM', 0, '*')],
    ['image/heic', bytes(0, 0, 0, 24, 'ftypheic')],
    ['video/mp4', bytes(0, 0, 0, 32, 'ftypisom')],
    ['video/quicktime', bytes(0, 0, 0, 8, 'wide')],
    ['video/webm', bytes(0x1a, 0x45, 0xdf, 0xa3)],
    ['video/x-matroska', bytes(0x1a, 0x45, 0xdf, 0xa3)],
    ['video/x-msvideo', bytes('RIFF', 1, 2, 3, 4, 'AVI LIST')],
    ['application/zip', bytes('PK', 3, 4)],
    ['application/x-zip-compressed', bytes('PK', 5, 6)],
    ['text/plain', MZ],
    ['text/x-log', bytes('')],
  ])('%s accepts its signature', (mime, head) => {
    expect(contentMatchesMimeType(mime, head)).toBe(true);
  });

  it.each([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/heic',
    'video/mp4',
    'video/webm',
    'application/zip',
  ])('%s refuses an executable', (mime) => {
    expect(contentMatchesMimeType(mime, MZ)).toBe(false);
    expect(contentMatchesMimeType(mime, bytes())).toBe(false);
  });

  it('refuses types outside the allow-list', () => {
    expect(contentMatchesMimeType('text/html', bytes('<html>'))).toBe(false);
  });
});

describe('server-only copies (review SEC-ATT-1)', () => {
  it('stored keys live under files/<attachmentId>/ with a fresh uuid', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const a = buildStoredKey(id, 'تقرير.pdf');
    expect(a).toMatch(new RegExp(`^files/${id}/[0-9a-f-]{36}/تقرير\\.pdf$`));
    expect(buildStoredKey(id, 'تقرير.pdf')).not.toBe(a);
  });

  it('copySource URL-encodes every path segment', () => {
    expect(copySource('bucket', 'attachments/u1/My file (1)#.pdf')).toBe(
      'bucket/attachments/u1/My%20file%20(1)%23.pdf',
    );
    expect(copySource('b', 'a/تقرير.pdf')).toBe(`b/a/${encodeURIComponent('تقرير.pdf')}`);
  });
});

describe('rfc5987', () => {
  it('percent-encodes everything outside attr-char, incl. quote and parentheses', () => {
    expect(rfc5987("it's (final)*!.pdf")).toBe('it%27s%20%28final%29%2A%21.pdf');
    expect(rfc5987('تقرير.pdf')).toBe(encodeURIComponent('تقرير.pdf'));
  });
});

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
    expect(out).toBe(`${'a'.repeat(196)}.pdf`);
  });

  it('caps by UTF-8 bytes, cutting whole code points (MinIO: 255 bytes per key segment)', () => {
    const cases = [
      [`${'ت'.repeat(140)}.txt`, `${'ت'.repeat(98)}.txt`], // 2 bytes each
      [`${'😀'.repeat(100)}.png`, `${'😀'.repeat(49)}.png`], // 4 bytes each, never split
      [`a${'€'.repeat(80)}.pdf`, `a${'€'.repeat(65)}.pdf`], // 1 + 3 × 65 = 196
      [`${'ت'.repeat(98)}.txt`, `${'ت'.repeat(98)}.txt`], // exactly 200: kept
    ];
    for (const [input, expected] of cases) {
      const out = sanitizeFileName(input!);
      expect(out).toBe(expected);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    }
  });

  it('replaces lone surrogates (well-formed before normalising; review RR-SEC-3)', () => {
    expect(sanitizeFileName('r\udc00\ud800.txt')).toBe('r��.txt');
    expect(sanitizeFileName('x\ud800y.txt')).toBe('x�y.txt');
    expect(sanitizeFileName('😀 ok.png')).toBe('😀 ok.png'); // a valid pair
    // A name cut at the byte cap never ends in half a surrogate pair either.
    const cut = sanitizeFileName(`${'😀'.repeat(60)}\ud800.png`);
    expect(cut).toBe(`${'😀'.repeat(49)}.png`);
  });

  it('never returns path separators', () => {
    for (const input of ['a/b/c.txt', 'a\\b\\c.txt', '/', '\\', 'x/../y']) {
      expect(sanitizeFileName(input)).not.toMatch(/[/\\]/);
    }
  });

  it('strips every directional mark and invisible format character (round-2 verify)', () => {
    // RLM, ALM (U+061C), RLO … PDF, ZWSP, word joiner, invisible times, Mongolian separator.
    expect(sanitizeFileName('\u200f\u061c\u202eabc\u202c.txt')).toBe('abc.txt');
    expect(sanitizeFileName('a\u2060b\u2062c\u180ed.txt')).toBe('abcd.txt');
    expect(sanitizeFileName('\u061c١٢.pdf')).toBe('١٢.pdf');
  });

  it('composes (NFC) after stripping, so a second pass changes nothing (round-2 verify)', () => {
    // A mark between a letter and its combining accent used to block the composition: the stored
    // name kept "e\u0301" while the key and the download name (sanitised again) had "é".
    expect(sanitizeFileName('e\u200f\u0301 cafe\u200f\u0301.txt')).toBe('\u00e9 caf\u00e9.txt');
    expect(sanitizeFileName('\u1100\u200b\u1161.txt')).toBe('\uac00.txt');
    // NFC maps U+037E to ';' and U+1FEF to '`': still replaced like the characters themselves.
    expect(sanitizeFileName('a\u037eb\u1fefc.txt')).toBe('a_b_c.txt');
  });

  it('is idempotent, and so is fileNameForMimeType (fuzzed)', () => {
    // A seeded generator (xorshift32) over the characters each step cares about.
    let seed = 0x2545f491;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 2 ** 32;
    };
    const pool = [
      ...'aZ09 ._-/\\:;<>"|?*`$%{}~#',
      ...'\u0000\u001f\u007f\u0085\u00a0\u061c\u180e\u200b\u200d\u200e\u200f\u202a\u202e',
      ...'\u2060\u2062\u2066\u2069\ufeff\u2000\u3000',
      '\u0301',
      '\u0308',
      '\u0338',
      '\u0345',
      '\u1100',
      '\u1161',
      '\u11a8',
      '\u0958',
      '\u037e',
      '\u1fef',
      '\u212b',
      '\u2126',
      '\u0130',
      '\u00c5',
      'e',
      'A',
      'i',
      '\u0627',
      '\u062a',
      '\u0661',
      '\ud800',
      '\udc00',
      '\ud83d\ude00',
      '\u00e9',
      '\u01c4',
      'CON',
      'pdf',
      'PNG',
      'txt',
      '\u2126x',
    ];
    const types = ['application/pdf', 'image/png', 'text/plain', 'image/jpeg', 'application/zip'];
    for (let i = 0; i < 5000; i++) {
      const length = Math.floor(random() * (i % 10 === 0 ? 160 : 24));
      const name = Array.from({ length }, () => pool[Math.floor(random() * pool.length)]).join('');
      const once = sanitizeFileName(name);
      expect(sanitizeFileName(once), JSON.stringify(name)).toBe(once);
      expect(toWellFormed(once)).toBe(once);
      expect(once.normalize('NFC')).toBe(once);
      expect(Buffer.byteLength(once)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      const typed = fileNameForMimeType(name, types[i % types.length]!);
      expect(fileNameForMimeType(typed, types[i % types.length]!), JSON.stringify(name)).toBe(
        typed,
      );
      expect(sanitizeFileName(typed)).toBe(typed);
      // An image accepted as its detected type: same guarantees, extension of that type.
      const detectedType = (['image/jpeg', 'image/png', 'image/heic', 'image/tiff'] as const)[
        i % 4
      ]!;
      const renamed = fileNameForDetectedType(typed, detectedType);
      expect(fileNameForDetectedType(renamed, detectedType), JSON.stringify(name)).toBe(renamed);
      expect(sanitizeFileName(renamed)).toBe(renamed);
      expect(Buffer.byteLength(renamed)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
      expect(fileNameForMimeType(renamed, detectedType)).toBe(renamed);
    }
  });
});

describe('images accepted as their detected type', () => {
  const png = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'IHDR');
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16, 'JFIF', 0);
  const gif = bytes('GIF89a', 1, 0, 1, 0);
  const webp = bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ');
  const tiff = bytes(0x49, 0x49, 0x2a, 0, 8, 0, 0, 0);
  const ftyp = (brand: string) => bytes(0, 0, 0, 24, 'ftyp', brand, 0, 0, 0, 0);
  const bmp = (dibSize: number) =>
    bytes('BM', 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, dibSize, 0, 0, 0, 1, 0);

  it('detectAllowedImageType reads the real image type from the magic bytes', () => {
    expect(detectAllowedImageType(png)).toBe('image/png');
    expect(detectAllowedImageType(jpeg)).toBe('image/jpeg');
    expect(detectAllowedImageType(gif)).toBe('image/gif');
    expect(detectAllowedImageType(webp)).toBe('image/webp');
    expect(detectAllowedImageType(tiff)).toBe('image/tiff');
    expect(detectAllowedImageType(ftyp('heic'))).toBe('image/heic');
    expect(detectAllowedImageType(ftyp('hevc'))).toBe('image/heic');
    expect(detectAllowedImageType(ftyp('mif1'))).toBe('image/heif');
    expect(detectAllowedImageType(bmp(40))).toBe('image/bmp');
    expect(detectAllowedImageType(bmp(124))).toBe('image/bmp');
  });

  it('detectAllowedImageType: anything that is no allowed image → null (stricter than the declared-type check)', () => {
    expect(detectAllowedImageType(bytes('%PDF-1.7'))).toBeNull();
    expect(detectAllowedImageType(bytes('MZ', 0x90, 0, 3, 0))).toBeNull();
    expect(detectAllowedImageType(bytes('PK', 3, 4, 20, 0))).toBeNull();
    expect(detectAllowedImageType(bytes('hello world'))).toBeNull();
    expect(detectAllowedImageType(new Uint8Array())).toBeNull();
    // Video in an ISO box is no HEIF image (the lenient declared-type check would pass it).
    expect(detectAllowedImageType(ftyp('isom'))).toBeNull();
    expect(detectAllowedImageType(ftyp('qt  '))).toBeNull();
    // "BM" text is no bitmap without a DIB header.
    expect(detectAllowedImageType(bytes('BMW parts list, 2024 edition'))).toBeNull();
    expect(detectAllowedImageType(bmp(41))).toBeNull();
    // SVG / HTML are not allowed images.
    expect(detectAllowedImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });

  it('a declared image/heic or image/heif needs a HEIF image brand, not just any ftyp box', () => {
    // ftyp box: size, 'ftyp', major brand, minor version, compatible brands.
    const box = (major: string, ...compatible: string[]) =>
      bytes(0, 0, 0, 16 + 4 * compatible.length, 'ftyp', major, 0, 0, 0, 0, ...compatible);
    for (const declared of ['image/heic', 'image/heif']) {
      // One family: either declared type takes a HEIC or a generic HEIF image.
      expect(contentMatchesMimeType(declared, box('heic', 'mif1', 'heic')), declared).toBe(true);
      expect(contentMatchesMimeType(declared, box('heix')), declared).toBe(true);
      expect(contentMatchesMimeType(declared, box('mif1', 'heic')), declared).toBe(true);
      expect(contentMatchesMimeType(declared, box('msf1')), declared).toBe(true);
      // A camera's own major brand with a HEVC image brand among the compatible ones.
      expect(contentMatchesMimeType(declared, box('MiHE', 'MiHE', 'mif1', 'heic'))).toBe(true);
      // Video and AVIF are ISO files too, but no HEIC / HEIF image.
      expect(contentMatchesMimeType(declared, box('isom', 'isom', 'iso2', 'mp41'))).toBe(false);
      expect(contentMatchesMimeType(declared, box('mp42', 'mp42', 'isom'))).toBe(false);
      expect(contentMatchesMimeType(declared, box('qt  ', 'qt  '))).toBe(false);
      expect(contentMatchesMimeType(declared, box('avif', 'avif', 'mif1', 'miaf'))).toBe(false);
      expect(contentMatchesMimeType(declared, bytes(0, 0, 0, 8, 'moov'))).toBe(false);
      // A compatible brand past the end of the box does not count.
      expect(
        contentMatchesMimeType(declared, bytes(0, 0, 0, 16, 'ftypisom', 0, 0, 0, 0, 'heic')),
      ).toBe(false);
    }
    expect(detectAllowedImageType(box('MiHE', 'mif1', 'heic'))).toBe('image/heic');
    expect(detectAllowedImageType(box('avif', 'avif', 'mif1', 'miaf'))).toBeNull();
  });

  it('only allowed image/* types may be corrected', () => {
    for (const mime of ['image/png', 'image/JPEG', 'image/heif; x=1', 'image/tiff']) {
      expect(isAllowedImageMimeType(mime), mime).toBe(true);
    }
    for (const mime of ['application/pdf', 'video/mp4', 'text/plain', 'image/svg+xml', 'x']) {
      expect(isAllowedImageMimeType(mime), mime).toBe(false);
    }
  });

  it.each([
    ['photo.png', 'image/jpeg', 'photo.jpg'],
    ['photo.PNG', 'image/jpeg', 'photo.jpg'],
    ['shot.jpeg', 'image/png', 'shot.png'],
    ['scan.tiff', 'image/png', 'scan.png'],
    ['report.pdf.png', 'image/jpeg', 'report.pdf.jpg'],
    ['archive.zip', 'image/png', 'archive.zip.png'],
    ['scan', 'image/jpeg', 'scan.jpg'],
    ['IMG_1.jpg', 'image/heic', 'IMG_1.heic'],
    ['IMG_1.heif', 'image/heic', 'IMG_1.heif'],
    ['already.jpeg', 'image/jpeg', 'already.jpeg'],
  ] as const)('%s as %s → %s', (name, mime, expected) => {
    expect(fileNameForDetectedType(name, mime)).toBe(expected);
  });

  it('keeps the 200-byte cap and the new extension', () => {
    const long = `${'ب'.repeat(98)}.png`; // 196 + 4 bytes
    expect(Buffer.byteLength(long)).toBe(MAX_FILE_NAME_BYTES);
    const renamed = fileNameForDetectedType(long, 'image/jpeg');
    expect(renamed).toBe(`${'ب'.repeat(98)}.jpg`);
    const appended = fileNameForDetectedType(`${'a'.repeat(196)}.zip`, 'image/jpeg');
    expect(Buffer.byteLength(appended)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(appended.endsWith('.jpg')).toBe(true);
    expect(fileNameForDetectedType(appended, 'image/jpeg')).toBe(appended);
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

  it('download URLs can override the served Content-Type (images stored as their detected type)', async () => {
    const url = new URL(
      await storage.getDownloadUrl('files/a/u/p.png', {
        fileName: 'p.jpg',
        contentType: 'image/jpeg',
      }),
    );
    expect(url.searchParams.get('response-content-type')).toBe('image/jpeg');
    const plain = new URL(await storage.getDownloadUrl('files/a/u/p.png', { fileName: 'p.png' }));
    expect(plain.searchParams.has('response-content-type')).toBe(false);
  });

  it('the default scan hook reports NOT_SCANNED', async () => {
    expect(
      await noopScanHook.scan({ bucket: 'b', key: 'k', contentType: 'image/png', sizeBytes: 1 }),
    ).toEqual({
      verdict: 'NOT_SCANNED',
    });
  });
});
