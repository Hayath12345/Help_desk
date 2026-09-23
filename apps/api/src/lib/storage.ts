import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config.ts';

// S3-compatible object storage: MinIO locally (endpoint + path-style + static keys), S3 on AWS
// (region only → default credential chain / task role). Uploads go straight from the browser
// to the bucket with pre-signed POST policies; the API never proxies file bytes.
// Routes arrive in Phase 2; this module holds the building blocks.

/** MIME types accepted for attachments (spec §12: images, video, PDF, text/log, zip). */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'application/pdf',
  'text/plain',
  'text/x-log',
  'application/zip',
  'application/x-zip-compressed',
] as const;
export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

/** "Image/PNG; charset=binary" → "image/png". */
export function normalizeMimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export function isAllowedMimeType(mime: string): mime is AllowedUploadMimeType {
  return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mime));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_FILE_NAME_LENGTH = 150;

/**
 * Makes a user-supplied file name safe to store and to put in Content-Disposition:
 * strips any path, control / bidi-override characters and characters invalid on common file
 * systems, collapses whitespace, removes leading dots, avoids Windows device names and caps
 * the length (keeping the extension). Unicode letters (e.g. Arabic) are preserved.
 */
export function sanitizeFileName(input: string, fallback = 'file'): string {
  let name = input.normalize('NFC');
  // Keep only the last path segment (both separators).
  name = name.split(/[/\\]/).pop() ?? '';
  // Control characters, bidi overrides / isolates, zero-width chars, BOM.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  // Characters that are invalid or dangerous in file names and headers.
  name = name.replace(/[<>:"|?*;`$%{}\\]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot + 1) : '';
  if (!/^[\p{L}\p{N}]{1,10}$/u.test(ext)) {
    base = name;
    ext = '';
  }
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (base === '') base = fallback;

  const extPart = ext ? `.${ext.toLowerCase()}` : '';
  const maxBase = MAX_FILE_NAME_LENGTH - extPart.length;
  if ([...base].length > maxBase) base = [...base].slice(0, maxBase).join('').trimEnd();
  return `${base}${extPart}`;
}

/** Object key for a new upload: `<scope>/<uuid>/<sanitized name>`. */
export function buildObjectKey(scope: string, fileName: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/^\/+|\/+$/g, '');
  return `${safeScope}/${randomUUID()}/${sanitizeFileName(fileName)}`;
}

// ───────────── Virus scanning hook (placeholder) ─────────────

export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'ERROR' | 'NOT_SCANNED';

export interface ScanTarget {
  bucket: string;
  key: string;
  contentType: string;
  sizeBytes: number;
}

/** Plug a scanner (ClamAV, GuardDuty Malware Protection for S3, …) in here. */
export interface ScanHook {
  scan(target: ScanTarget): Promise<{ verdict: ScanVerdict; detail?: string }>;
}

/** Default hook: performs no scan and says so. Callers decide how to treat NOT_SCANNED. */
export const noopScanHook: ScanHook = {
  async scan() {
    return { verdict: 'NOT_SCANNED' };
  },
};

// ───────────── Client + presigning ─────────────

export function createS3Client(s3: AppConfig['s3']): S3Client {
  const config: S3ClientConfig = {
    region: s3.region,
    // Presigned URLs must not carry SDK-computed checksums of an empty body.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (s3.endpoint) {
    config.endpoint = s3.endpoint;
    config.forcePathStyle = s3.forcePathStyle;
  }
  if (s3.accessKeyId && s3.secretAccessKey) {
    config.credentials = { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey };
  }
  return new S3Client(config);
}

export interface UploadPostInput {
  key: string;
  contentType: string;
  maxBytes: number;
  /** Seconds the policy stays valid (default 300). */
  expiresIn?: number;
}

export interface Storage {
  readonly bucket: string;
  readonly client: S3Client;
  readonly scanHook: ScanHook;
  /** Pre-signed POST: S3 enforces the size range and exact Content-Type. */
  createUploadPost(input: UploadPostInput): Promise<PresignedPost>;
  /** Short-lived GET URL, served as an attachment download. */
  getDownloadUrl(key: string, options?: { fileName?: string; expiresIn?: number }): Promise<string>;
  /** Size / type of an uploaded object, or null when it doesn't exist. */
  headObject(key: string): Promise<{ sizeBytes: number; contentType: string | undefined } | null>;
}

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}

export function createStorage(
  s3: AppConfig['s3'],
  options: { client?: S3Client; scanHook?: ScanHook } = {},
): Storage {
  const client = options.client ?? createS3Client(s3);
  const bucket = s3.bucket;

  return {
    bucket,
    client,
    scanHook: options.scanHook ?? noopScanHook,

    async createUploadPost({ key, contentType, maxBytes, expiresIn = 300 }) {
      const mime = normalizeMimeType(contentType);
      if (!isAllowedMimeType(mime)) throw new StorageValidationError('File type not allowed');
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > s3.uploadMaxBytes) {
        throw new StorageValidationError(`maxBytes must be between 1 and ${s3.uploadMaxBytes}`);
      }
      return createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, maxBytes],
          ['eq', '$Content-Type', mime],
        ],
        Fields: { 'Content-Type': mime },
        Expires: expiresIn,
      });
    },

    async getDownloadUrl(key, { fileName, expiresIn = 300 } = {}) {
      const disposition = fileName
        ? `attachment; filename*=UTF-8''${encodeURIComponent(sanitizeFileName(fileName))}`
        : 'attachment';
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition }),
        { expiresIn },
      );
    },

    async headObject(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw err;
      }
    },
  };
}
