import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  UPLOAD_MIME_EXTENSIONS,
  toWellFormed,
  type AllowedUploadMimeType,
} from '@loons/shared';
import type { AppConfig } from '../config.ts';

// S3-compatible object storage: MinIO locally (endpoint + path-style + static keys), S3 on AWS
// (region only → default credential chain / task role). Uploads go straight from the browser
// to the bucket with pre-signed POST policies; the API never proxies file bytes.
// Used by the attachment routes (routes/attachments.ts, services/attachments.service.ts).

/** MIME types accepted for attachments: the shared list (the web checks the same one). */
export { ALLOWED_UPLOAD_MIME_TYPES, type AllowedUploadMimeType };

/** "Image/PNG; charset=binary" → "image/png". */
export function normalizeMimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export function isAllowedMimeType(mime: string): mime is AllowedUploadMimeType {
  return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mime));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * Longest stored file name in UTF-8 bytes. The name is one segment of the object key, and MinIO
 * refuses a segment over 255 bytes (S3 only caps the whole key, at 1024): 200 leaves room to spare
 * (review RR-SEC-4 / sweep: 140 Arabic letters or 100 emoji used to be refused by MinIO).
 */
export const MAX_FILE_NAME_BYTES = 200;

const utf8Bytes = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Makes a user-supplied file name safe to store and to put in Content-Disposition:
 * makes it well-formed (lone surrogates become U+FFFD: they have no UTF-8 form, so the signed
 * key and the stored one would differ — review RR-SEC-3), strips any path, control / bidi /
 * invisible format characters and characters invalid on common file systems, composes it (NFC),
 * collapses whitespace, removes leading dots, avoids Windows device names and caps the length at
 * MAX_FILE_NAME_BYTES UTF-8 bytes, cutting whole code points and keeping the extension.
 * Unicode letters (e.g. Arabic) are preserved. Idempotent: the stored name, the object key and
 * the download name (each sanitised again) are the same.
 */
export function sanitizeFileName(input: string, fallback = 'file'): string {
  let name = toWellFormed(input);
  // Keep only the last path segment (both separators).
  name = name.split(/[/\\]/).pop() ?? '';
  // Control characters, the Arabic letter mark, the Mongolian vowel separator, zero-width
  // characters and directional marks, bidi overrides / isolates, invisible operators, BOM.
  const invisible =
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
  name = name.replace(invisible, '');
  // Composed once they are gone (round-2 verify): a stripped mark between a letter and its
  // combining accent blocked the composition, so the next pass (the object key, the download
  // name) composed it and the names differed. Before the replacement below: NFC turns U+037E
  // into ';' and U+1FEF into '`'. Cutting whole code points further down keeps it composed.
  name = name.normalize('NFC');
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
  const maxBase = MAX_FILE_NAME_BYTES - utf8Bytes(extPart);
  if (utf8Bytes(base) > maxBase) {
    let kept = '';
    let bytes = 0;
    for (const codePoint of base) {
      const size = utf8Bytes(codePoint);
      if (bytes + size > maxBase) break;
      kept += codePoint;
      bytes += size;
    }
    base = kept.trimEnd() || fallback;
  }
  return `${base}${extPart}`;
}

/** RFC 5987 `ext-value` encoding (encodeURIComponent leaves ' ( ) * ! unescaped). */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Object key for a new upload: `<scope>/<uuid>/<sanitized name>`. */
export function buildObjectKey(scope: string, fileName: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9/_-]/g, '_').replace(/^\/+|\/+$/g, '');
  return `${safeScope}/${randomUUID()}/${sanitizeFileName(fileName)}`;
}

/**
 * Prefix of browser uploads (pre-signed POST targets; the uploader can write there for 15 min).
 * Transient: `complete` copies the checked object under `files/` and deletes the upload, but the
 * POST policy outlives that, so a re-POST leaves an object nothing references (review RR-SEC-4).
 * The bucket expires this prefix after a day (docker-compose minio-init locally; a lifecycle rule
 * on the S3 bucket in production), and the e2e cleanup sweeps `attachments/<attachmentId>/`.
 */
export const UPLOAD_KEY_PREFIX = 'attachments';
/** Prefix of confirmed files: only the API writes there (server-side copies of checked uploads). */
export const STORED_KEY_PREFIX = 'files';

/**
 * Key of a browser upload: `attachments/<attachmentId>/<name>` — under the attachment's id, so
 * whatever the pre-signed POST leaves there can be found from the row (and swept with it).
 */
export function buildUploadKey(attachmentId: string, fileName: string): string {
  return `${UPLOAD_KEY_PREFIX}/${attachmentId}/${sanitizeFileName(fileName)}`;
}

/**
 * Key of the server-only copy of a confirmed upload: `files/<attachmentId>/<uuid>/<name>`. The
 * uuid makes every copy attempt a fresh object, so two concurrent confirmations never write the
 * same key.
 */
export function buildStoredKey(attachmentId: string, fileName: string): string {
  return buildObjectKey(`${STORED_KEY_PREFIX}/${attachmentId}`, fileName);
}

/**
 * The sanitised file name with an extension that belongs to `mimeType` (review SEC-ATT-2): kept
 * when it matches (case-insensitively), otherwise the type's canonical extension is appended —
 * "Invoice.pdf.exe" as application/pdf → "Invoice.pdf.exe.pdf", "notes" as text/plain →
 * "notes.txt". Downloads use this name, so a saved file always opens as the allowed type.
 */
export function fileNameForMimeType(fileName: string, mimeType: string): string {
  const name = sanitizeFileName(fileName);
  const mime = normalizeMimeType(mimeType);
  if (!isAllowedMimeType(mime)) return name;
  const extensions: readonly string[] = UPLOAD_MIME_EXTENSIONS[mime];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (extensions.includes(ext)) return name;
  return sanitizeFileName(`${name}.${extensions[0] ?? 'bin'}`);
}

/** Every extension of an allowed image type (png, jpg, jpeg, …, heic, heif, bmp, tif, tiff…). */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  ALLOWED_UPLOAD_MIME_TYPES.filter((mime) => mime.startsWith('image/')).flatMap(
    (mime) => UPLOAD_MIME_EXTENSIONS[mime] as readonly string[],
  ),
);

/**
 * The name for an image accepted as the type its bytes really are (`detectAllowedImageType`): an
 * image extension (the one that matched the declared type) is replaced by the detected type's
 * canonical one, any other name gets it appended — "photo.png" as image/jpeg → "photo.jpg",
 * "scan" → "scan.jpg". A name whose extension already belongs to the type is kept. Sanitised like
 * every stored name (idempotent, MAX_FILE_NAME_BYTES, extension kept when cut).
 */
export function fileNameForDetectedType(fileName: string, mimeType: AllowedUploadMimeType): string {
  const name = sanitizeFileName(fileName);
  const extensions: readonly string[] = UPLOAD_MIME_EXTENSIONS[mimeType];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (extensions.includes(ext)) return name;
  const base = dot > 0 && IMAGE_EXTENSIONS.has(ext) ? name.slice(0, dot) : name;
  return sanitizeFileName(`${base}.${extensions[0] ?? 'bin'}`);
}

// ───────────── Content sniffing ─────────────

/** Bytes of an upload's start that `contentMatchesMimeType` looks at. */
export const SNIFF_BYTES = 1024;

const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));
const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
/** ISO base media (MP4 / QuickTime / HEIF): a box type at offset 4. */
const isoBox = (bytes: Uint8Array, boxes: readonly string[]): boolean =>
  bytes.length >= 8 && boxes.includes(ascii(bytes, 4, 8));
const QUICKTIME_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'];

/**
 * Whether the first bytes of a file fit its declared MIME type (magic numbers). Checked before a
 * confirmed upload is marked CLEAN, so e.g. an executable declared as a PDF or an image is
 * refused. Text files have no signature and always pass (they are stored with a .txt/.log name).
 */
export function contentMatchesMimeType(mimeType: string, head: Uint8Array): boolean {
  const mime = normalizeMimeType(mimeType);
  if (!isAllowedMimeType(mime)) return false;
  switch (mime) {
    case 'application/pdf':
      // Readers accept a little junk before the header (within the first kilobyte).
      return ascii(head, 0, Math.min(head.length, SNIFF_BYTES)).includes('%PDF-');
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(ascii(head, 0, 6));
    case 'image/webp':
      return ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP';
    case 'image/bmp':
      return ascii(head, 0, 2) === 'BM';
    case 'image/tiff':
      // Little / big endian, classic TIFF (42) or BigTIFF (43).
      return (
        startsWith(head, [0x49, 0x49, 0x2a, 0x00]) ||
        startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]) ||
        startsWith(head, [0x49, 0x49, 0x2b, 0x00]) ||
        startsWith(head, [0x4d, 0x4d, 0x00, 0x2b])
      );
    case 'image/heic':
    case 'image/heif':
      // One family: either declared type accepts a HEIC or a generic HEIF image, but not just any
      // ISO file (an MP4 or QuickTime video also starts with an `ftyp` box).
      return heifImageType(head) !== null;
    case 'video/mp4':
    case 'video/quicktime':
      return isoBox(head, QUICKTIME_BOXES);
    case 'video/webm':
    case 'video/x-matroska':
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'video/x-msvideo':
      return ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'AVI ';
    case 'application/zip':
    case 'application/x-zip-compressed':
      // Local file header, empty archive, or a spanned archive's marker.
      return (
        startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWith(head, [0x50, 0x4b, 0x07, 0x08])
      );
    case 'text/plain':
    case 'text/x-log':
      return true;
  }
}

/** An allowed `image/*` type (the only declared types `detectAllowedImageType` may correct). */
export function isAllowedImageMimeType(mime: string): boolean {
  const normalized = normalizeMimeType(mime);
  return isAllowedMimeType(normalized) && normalized.startsWith('image/');
}

/** `ftyp` brands of HEIF images: HEVC-coded (image/heic) and generic HEIF (image/heif). */
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'];
const HEIF_BRANDS = ['mif1', 'msf1'];

/**
 * image/heic or image/heif when the `ftyp` box names a HEIF image brand, else null. The major brand
 * decides; a file whose major brand is something else (some cameras write their own) still counts
 * as HEIC when a HEVC image brand is among its compatible brands. `mif1` / `msf1` count only as
 * the major brand: AVIF lists `mif1` as compatible too, and AVIF is not allowed.
 */
function heifImageType(head: Uint8Array): 'image/heic' | 'image/heif' | null {
  if (!isoBox(head, ['ftyp']) || head.length < 12) return null;
  const major = ascii(head, 8, 12);
  if (HEIC_BRANDS.includes(major)) return 'image/heic';
  if (HEIF_BRANDS.includes(major)) return 'image/heif';
  // Compatible brands: 4 bytes each after the minor version, up to the end of the box.
  const boxSize = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
  const end = Math.min(boxSize, head.length);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIC_BRANDS.includes(ascii(head, at, at + 4))) return 'image/heic';
  }
  return null;
}
/** BITMAPCOREHEADER, BITMAPINFOHEADER and its later versions (the DIB header's own size). */
const BMP_DIB_HEADER_SIZES = [12, 40, 52, 56, 64, 108, 124];

/**
 * Which allowed image type the first bytes of a file really are, or null. A HEIF needs an image
 * brand (not just any ISO box, which MP4 / QuickTime have too — the declared-type check asks the
 * same), and a BMP a known DIB header size (stricter than the declared-type check, which only
 * wants "BM"). Used at `complete` for an image declared as another image type — a JPEG named .png
 * — which is then stored as what it really is.
 */
export function detectAllowedImageType(head: Uint8Array): AllowedUploadMimeType | null {
  if (contentMatchesMimeType('image/png', head)) return 'image/png';
  if (contentMatchesMimeType('image/jpeg', head)) return 'image/jpeg';
  if (contentMatchesMimeType('image/gif', head)) return 'image/gif';
  if (contentMatchesMimeType('image/webp', head)) return 'image/webp';
  if (contentMatchesMimeType('image/tiff', head)) return 'image/tiff';
  const heif = heifImageType(head);
  if (heif) return heif;
  if (
    contentMatchesMimeType('image/bmp', head) &&
    head.length >= 18 &&
    BMP_DIB_HEADER_SIZES.includes(
      new DataView(head.buffer, head.byteOffset + 14, 4).getUint32(0, true),
    )
  ) {
    return 'image/bmp';
  }
  return null;
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

/**
 * The S3 client. On AWS only the region is set: credentials come from the default provider chain
 * (task / pod role), which is why production configuration refuses static keys. MinIO locally adds
 * an endpoint, path-style addressing and static keys. `overrides` is a test seam (a fake request
 * handler); region, endpoint and credentials always come from the configuration.
 */
export function createS3Client(s3: AppConfig['s3'], overrides: S3ClientConfig = {}): S3Client {
  const config: S3ClientConfig = {
    // A hung connection must fail the call; the idle timeout leaves room for a server-side copy.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 120_000 },
    ...overrides,
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
  /**
   * Short-lived GET URL, served as an attachment download. `contentType` overrides the stored
   * object's type in the response (an image accepted as its detected type keeps the declared type
   * on the object).
   */
  getDownloadUrl(
    key: string,
    options?: { fileName?: string; contentType?: string; expiresIn?: number },
  ): Promise<string>;
  /** Size / type / ETag of an uploaded object, or null when it doesn't exist. */
  headObject(key: string): Promise<ObjectHead | null>;
  /**
   * Server-side copy within the bucket. With `ifMatch`, only when the source still has that ETag
   * (it is exactly the object that was checked). False when the source changed or is gone.
   */
  copyObject(from: string, to: string, options?: { ifMatch?: string }): Promise<boolean>;
  /** The first `bytes` bytes of an object (fewer for a smaller one), or null when it is gone. */
  readObjectStart(key: string, bytes: number): Promise<Uint8Array | null>;
  /** Deletes an object (no error when it is already gone). */
  deleteObject(key: string): Promise<void>;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | undefined;
  etag: string | undefined;
}

/** HTTP status of an S3 SDK error (undefined for anything else, e.g. a network error). */
export function s3Status(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

/** `x-amz-copy-source` value: bucket/key, URL-encoded per path segment. */
export function copySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')].map((part) => encodeURIComponent(part)).join('/');
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

    async getDownloadUrl(key, { fileName, contentType, expiresIn = 300 } = {}) {
      const disposition = fileName
        ? `attachment; filename*=UTF-8''${rfc5987(sanitizeFileName(fileName))}`
        : 'attachment';
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: disposition,
          ...(contentType ? { ResponseContentType: contentType } : {}),
        }),
        { expiresIn },
      );
    },

    async headObject(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          sizeBytes: head.ContentLength ?? 0,
          contentType: head.ContentType,
          etag: head.ETag,
        };
      } catch (err) {
        if (s3Status(err) === 404) return null;
        throw err;
      }
    },

    async copyObject(from, to, { ifMatch } = {}) {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: to,
            CopySource: copySource(bucket, from),
            ...(ifMatch ? { CopySourceIfMatch: ifMatch } : {}),
          }),
        );
        return true;
      } catch (err) {
        const status = s3Status(err);
        if (status === 412 || status === 404) return false;
        throw err;
      }
    },

    async readObjectStart(key, bytes) {
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            Range: `bytes=0-${Math.max(0, bytes - 1)}`,
          }),
        );
        return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
      } catch (err) {
        if (s3Status(err) === 404) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
