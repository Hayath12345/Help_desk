// Browser attachment uploads: presign (API) → multipart POST straight to storage (S3 / MinIO,
// XHR for progress) → complete (API verifies size/type and runs the scan hook). The API never
// proxies file bytes.

import {
  attachmentDownloadSchema,
  completeAttachmentResponseSchema,
  presignAttachmentResponseSchema,
  uploadQuotaDetailsSchema,
  uploadRejectionDetailsSchema,
  type AttachmentDto,
  type AttachmentVisibility,
} from '@loons/shared';
import { z } from 'zod';
import { apiClient } from '@/lib/api/browser';
import { isApiRequestError } from '@/lib/api/errors';
import { UPLOAD_LIMITS, resolveUploadMimeType } from './limits';

type PresignResponse = z.infer<typeof presignAttachmentResponseSchema>;

const STRICT = process.env.NODE_ENV !== 'production';
const parse = <S extends z.ZodType>(schema: S, data: unknown): z.output<S> =>
  STRICT ? schema.parse(data) : (data as z.output<S>);

/** Why an upload failed (maps to `tickets.attachments.error.*`). */
export type UploadErrorReason =
  | 'type'
  | 'size'
  | 'empty'
  /** Storage refused the POST (expired policy, CORS, size/type mismatch…). */
  | 'storage'
  /** The API refused the file (presign rules, virus scan: INFECTED). */
  | 'rejected'
  /** The file's bytes are not a file of its type (API `details.reason: 'content'`, REJECTED). */
  | 'content'
  /**
   * The user's rolling 24-hour upload budget is used up (presign 429 with `details.reason:
   * 'daily-quota'`); `UploadError.retryAfterSeconds` says when this file would fit.
   */
  | 'quota'
  /** Any other 429 (e.g. the presign request limit): too many uploads in a short time. */
  | 'busy'
  /**
   * The file is larger than the whole daily upload budget (presign 400, issue code
   * `file_too_large`, when the budget is set below 25 MB): it can never be uploaded.
   */
  | 'allowance'
  /** Network failure or the API/storage being unreachable. */
  | 'network'
  | 'aborted';

export class UploadError extends Error {
  /** Set for `quota`: seconds until enough of the daily budget frees up for this file. */
  readonly retryAfterSeconds: number | null;

  constructor(
    readonly reason: UploadErrorReason,
    message: string,
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.name = 'UploadError';
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
  }
}

export function isUploadError(error: unknown): error is UploadError {
  return error instanceof UploadError;
}

// ───────────── API calls ─────────────

export async function presignAttachment(input: {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  ticketId?: string;
  /** Required here (the API defaults to `public`): every call site says who the file is for. */
  visibility: AttachmentVisibility;
}): Promise<PresignResponse> {
  const data = await apiClient.post<unknown>('/attachments/presign', input);
  return parse(presignAttachmentResponseSchema, data);
}

export async function completeAttachment(attachmentId: string): Promise<AttachmentDto> {
  const data = await apiClient.post<unknown>(
    `/attachments/${encodeURIComponent(attachmentId)}/complete`,
  );
  return parse(completeAttachmentResponseSchema, data).attachment;
}

/** A 5-minute signed download URL (Content-Disposition: attachment). */
export async function getAttachmentDownloadUrl(attachmentId: string): Promise<string> {
  const data = await apiClient.get<unknown>(
    `/attachments/${encodeURIComponent(attachmentId)}/download`,
  );
  return parse(attachmentDownloadSchema, data).url;
}

/** Starts the browser download of an attachment (the signed URL answers with a file). */
export async function downloadAttachment(attachmentId: string): Promise<void> {
  const url = await getAttachmentDownloadUrl(attachmentId);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unexpected download URL');
  }
  const link = document.createElement('a');
  link.href = parsed.toString();
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ───────────── Storage POST ─────────────

/**
 * POSTs the file to the pre-signed URL: every policy field first, the file last (S3 ignores
 * fields after the file). Resolves on any 2xx (S3 answers 204 by default).
 */
export function postToStorage(
  upload: PresignResponse['upload'],
  file: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadError('aborted', 'Upload aborted'));
      return;
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', onAbort);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });
    xhr.addEventListener('load', () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1);
        resolve();
      } else {
        reject(new UploadError('storage', `Storage answered ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new UploadError('network', 'Storage is unreachable'));
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new UploadError('aborted', 'Upload aborted'));
    });
    xhr.open('POST', upload.url);
    xhr.send(form);
  });
}

// ───────────── The whole flow ─────────────

export interface UploadAttachmentOptions {
  /**
   * Who the file is for, fixed at presign: `public` for a public reply or a new ticket, `internal`
   * for a staff member's note. The API links a file only to a message of the same kind.
   */
  visibility: AttachmentVisibility;
  /** Set when adding to an existing ticket (reply); omit while creating one. */
  ticketId?: string;
  /** 0…1; the storage POST is ~all of the time, presign/complete are reported as 0 and 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** A presign 400 whose issues say the file is larger than the caller may upload at all. */
const fileTooLargeIssuesSchema = z
  .array(z.object({ code: z.string() }))
  .refine((issues) => issues.some((issue) => issue.code === 'file_too_large'));
const isFileTooLargeForBudget = (details: unknown): boolean =>
  fileTooLargeIssuesSchema.safeParse(details).success;

function fromApiError(error: unknown, fallback: UploadErrorReason): UploadError {
  if (isUploadError(error)) return error;
  if (isApiRequestError(error)) {
    if (error.status === 0 || error.status >= 500) {
      return new UploadError('network', error.message, { cause: error });
    }
    // presign refuses a file beyond the rolling 24-hour budget and says when it would fit.
    const quota = error.status === 429 ? uploadQuotaDetailsSchema.safeParse(error.details) : null;
    if (quota?.success) {
      return new UploadError('quota', error.message, {
        cause: error,
        retryAfterSeconds: quota.data.retryAfterSeconds,
      });
    }
    // Any other 429 is a request limit, not something wrong with the file.
    if (error.status === 429) return new UploadError('busy', error.message, { cause: error });
    if (isFileTooLargeForBudget(error.details)) {
      return new UploadError('allowance', error.message, { cause: error });
    }
    // complete says why it refused a file: a type mismatch reads differently from the scan.
    const refusal = uploadRejectionDetailsSchema.safeParse(error.details);
    const reason: UploadErrorReason = !refusal.success
      ? 'rejected'
      : refusal.data.reason === 'content'
        ? 'content'
        : refusal.data.reason === 'mismatch'
          ? 'storage'
          : 'rejected';
    return new UploadError(reason, error.message, { cause: error });
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new UploadError('aborted', 'Upload aborted', { cause: error });
  }
  return new UploadError(fallback, error instanceof Error ? error.message : 'Upload failed', {
    cause: error,
  });
}

/**
 * Uploads one file and returns the stored attachment (status CLEAN). Throws `UploadError`.
 * Pass the resulting `attachment.id` in `attachmentIds` when creating the ticket / message.
 * The returned `fileName` / `mimeType` can differ from the picked file's: an image whose bytes
 * are another allowed image type (a JPEG named .png) is stored as what it really is.
 */
export async function uploadAttachment(
  file: File,
  options: UploadAttachmentOptions,
): Promise<AttachmentDto> {
  const mimeType = resolveUploadMimeType(file);
  if (!mimeType) throw new UploadError('type', 'File type not allowed');
  if (file.size <= 0) throw new UploadError('empty', 'File is empty');
  if (file.size > UPLOAD_LIMITS.maxFileBytes) throw new UploadError('size', 'File is too large');

  const abortIfNeeded = () => {
    if (options.signal?.aborted) throw new UploadError('aborted', 'Upload aborted');
  };

  let presign: PresignResponse;
  try {
    options.onProgress?.(0);
    presign = await presignAttachment({
      fileName: file.name,
      mimeType,
      sizeBytes: file.size,
      ...(options.ticketId ? { ticketId: options.ticketId } : {}),
      visibility: options.visibility,
    });
  } catch (error) {
    throw fromApiError(error, 'rejected');
  }
  abortIfNeeded();

  await postToStorage(presign.upload, file, {
    // Keep a sliver for "complete" so 100% means done.
    onProgress: (fraction) => options.onProgress?.(fraction * 0.98),
    signal: options.signal,
  });
  abortIfNeeded();

  try {
    const attachment = await completeAttachment(presign.attachmentId);
    options.onProgress?.(1);
    return attachment;
  } catch (error) {
    throw fromApiError(error, 'rejected');
  }
}
