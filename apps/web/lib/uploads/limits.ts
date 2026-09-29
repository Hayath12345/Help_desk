// Client-side attachment rules (spec §12). They mirror the API's checks so users learn about a
// bad file before it is uploaded; the API re-checks everything (presign + complete).

import { ALLOWED_UPLOAD_MIME_TYPES, TICKET_LIMITS } from '@loons/shared';

/** Accepted MIME types: the API's allow-list (`ALLOWED_UPLOAD_MIME_TYPES` in @loons/shared). */
export const UPLOAD_MIME_TYPES = ALLOWED_UPLOAD_MIME_TYPES;

/**
 * Browsers often report no type (or a vendor type) for .log, .heic, .mkv and friends; the file
 * extension decides then.
 */
const EXTENSION_TYPES: Record<string, (typeof UPLOAD_MIME_TYPES)[number]> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  zip: 'application/zip',
};

/** `accept` attribute for file inputs (MIME types + extensions for types browsers don't know). */
export const UPLOAD_ACCEPT = [
  ...UPLOAD_MIME_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`),
].join(',');

export const UPLOAD_LIMITS = {
  maxFileBytes: TICKET_LIMITS.attachmentMaxBytes,
  maxTotalBytes: TICKET_LIMITS.attachmentsTotalMaxBytes,
  maxFiles: TICKET_LIMITS.attachmentsPerRequest,
} as const;

/** "Image/PNG; charset=binary" → "image/png". */
export function normalizeMimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** The MIME type to upload the file as, or null when it isn't an accepted kind of file. */
export function resolveUploadMimeType(file: { name: string; type: string }): string | null {
  const reported = normalizeMimeType(file.type);
  if ((UPLOAD_MIME_TYPES as readonly string[]).includes(reported)) return reported;
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name.trim())?.[1]?.toLowerCase();
  return (ext && EXTENSION_TYPES[ext]) || null;
}

export type FileRejectionReason = 'type' | 'size' | 'empty' | 'count' | 'total';

export interface AcceptedFile {
  file: File;
  mimeType: string;
}

export interface RejectedFile {
  file: File;
  reason: FileRejectionReason;
}

/**
 * Splits newly picked files into accepted and rejected ones, given what is already attached
 * (count and total size, including uploads in progress).
 */
export function checkFiles(
  files: readonly File[],
  current: { count: number; totalBytes: number },
  limits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number } = UPLOAD_LIMITS,
): { accepted: AcceptedFile[]; rejected: RejectedFile[] } {
  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];
  let count = current.count;
  let total = current.totalBytes;
  for (const file of files) {
    const mimeType = resolveUploadMimeType(file);
    let reason: FileRejectionReason | null = null;
    if (!mimeType) reason = 'type';
    else if (file.size <= 0) reason = 'empty';
    else if (file.size > limits.maxFileBytes) reason = 'size';
    else if (count + 1 > limits.maxFiles) reason = 'count';
    else if (total + file.size > limits.maxTotalBytes) reason = 'total';
    if (reason || !mimeType) {
      rejected.push({ file, reason: reason ?? 'type' });
      continue;
    }
    accepted.push({ file, mimeType });
    count += 1;
    total += file.size;
  }
  return { accepted, rejected };
}
