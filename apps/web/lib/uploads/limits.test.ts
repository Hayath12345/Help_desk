import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from '@/security-headers';
import { addConnectSrc, uploadOrigin, withUploadConnectSrc } from './csp';
import { UPLOAD_ACCEPT, UPLOAD_LIMITS, checkFiles, resolveUploadMimeType } from './limits';

const MB = 1024 * 1024;
const file = (name: string, size: number, type = '') =>
  new File([new Uint8Array(size)], name, { type });

describe('resolveUploadMimeType', () => {
  it('accepts allowed reported types and falls back to the extension', () => {
    expect(resolveUploadMimeType({ name: 'a.PNG', type: 'Image/PNG' })).toBe('image/png');
    expect(resolveUploadMimeType({ name: 'syslog.log', type: '' })).toBe('text/plain');
    expect(resolveUploadMimeType({ name: 'IMG_1.HEIC', type: '' })).toBe('image/heic');
    expect(
      resolveUploadMimeType({ name: 'backup.zip', type: 'application/x-zip-compressed' }),
    ).toBe('application/x-zip-compressed');
    expect(
      resolveUploadMimeType({ name: 'tool.exe', type: 'application/x-msdownload' }),
    ).toBeNull();
    expect(resolveUploadMimeType({ name: 'page.html', type: 'text/html' })).toBeNull();
    expect(UPLOAD_ACCEPT).toContain('.log');
  });
});

describe('checkFiles', () => {
  it('enforces type, empty, 25 MB each, 25 MB total and 10 files', () => {
    const { accepted, rejected } = checkFiles(
      [
        file('a.pdf', 10 * MB, 'application/pdf'),
        file('b.exe', 1),
        file('c.txt', 0),
        file('d.mp4', 26 * MB, 'video/mp4'),
        file('e.jpg', 10 * MB, 'image/jpeg'),
        file('f.jpg', 6 * MB, 'image/jpeg'),
      ],
      { count: 0, totalBytes: 0 },
    );
    expect(accepted.map((a) => a.file.name)).toEqual(['a.pdf', 'e.jpg']);
    expect(rejected.map((r) => [r.file.name, r.reason])).toEqual([
      ['b.exe', 'type'],
      ['c.txt', 'empty'],
      ['d.mp4', 'size'],
      ['f.jpg', 'total'],
    ]);

    const many = Array.from({ length: 3 }, (_, i) => file(`${i}.txt`, 1, 'text/plain'));
    const result = checkFiles(many, { count: UPLOAD_LIMITS.maxFiles - 1, totalBytes: 0 });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((r) => r.reason)).toEqual(['count', 'count']);
  });
});

describe('CSP connect-src for uploads', () => {
  it('adds NEXT_PUBLIC_UPLOAD_ORIGIN (origin only) to connect-src', () => {
    expect(uploadOrigin(' http://localhost:9000/bucket ')).toBe('http://localhost:9000');
    expect(uploadOrigin('javascript:alert(1)')).toBeNull();
    expect(uploadOrigin('')).toBeNull();

    const csp = contentSecurityPolicy({ nodeEnv: 'production', apiUrl: 'https://api.example.com' });
    const withUpload = addConnectSrc(csp, 'https://files.example.com');
    expect(withUpload).toContain(
      "connect-src 'self' https://api.example.com wss://api.example.com https://files.example.com",
    );
    expect(addConnectSrc(withUpload, 'https://files.example.com')).toBe(withUpload);
    expect(addConnectSrc("default-src 'self'", 'https://x.test')).toBe(
      "default-src 'self'; connect-src 'self' https://x.test",
    );
  });

  it('rewrites only the CSP header', () => {
    const headers = securityHeaders({ nodeEnv: 'production', apiUrl: 'https://api.example.com' });
    const out = withUploadConnectSrc(headers, 'https://bucket.s3.me-central-1.amazonaws.com');
    const csp = out.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).toContain('https://bucket.s3.me-central-1.amazonaws.com');
    expect(out.filter((h) => h.key !== 'Content-Security-Policy')).toEqual(
      headers.filter((h) => h.key !== 'Content-Security-Policy'),
    );
    expect(withUploadConnectSrc(headers, undefined)).toEqual(headers);
  });
});
