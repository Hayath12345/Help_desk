// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/uploads — attachment uploads (spec §12, docs/PHASE2_CONTRACT.md → Web → Uploads)
//
// Flow: client-side checks → POST /attachments/presign → multipart POST straight to storage
// (XHR, progress) → POST /attachments/:id/complete. Pass the resulting attachment ids as
// `attachmentIds` when creating a ticket or a message.
//
// Exports
//   useAttachmentUploads({ ticketId? })  State for a composer / form: items with progress, add(files)
//                                        → rejected files, remove, retry, reset, attachmentIds,
//                                        attachments, isUploading, hasFailed, totalBytes.
//                                        Render it with <AttachmentDropzone uploads={…} />.
//   uploadAttachment(file, { ticketId?, onProgress?, signal? })  One upload → AttachmentDto; throws UploadError.
//   UploadError / isUploadError          `reason`: type | size | empty | storage | rejected | network | aborted.
//   downloadAttachment(id)               Starts a download through the 5-minute signed URL.
//   getAttachmentDownloadUrl(id), presignAttachment, completeAttachment, postToStorage
//                                        The individual steps.
//   checkFiles(files, current)           Accept/reject against the limits (reasons: type | size | empty | count | total).
//   resolveUploadMimeType(file)          Allowed MIME type (by reported type, then extension) or null.
//   UPLOAD_MIME_TYPES, UPLOAD_ACCEPT, UPLOAD_LIMITS
//                                        Allow-list (mirrors the API), <input accept>, 25 MB / 25 MB / 10 files.
//   uploadOrigin, addConnectSrc, withUploadConnectSrc
//                                        CSP helpers used by next.config.ts (connect-src for NEXT_PUBLIC_UPLOAD_ORIGIN).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { addConnectSrc, uploadOrigin, withUploadConnectSrc } from './csp';
export {
  UPLOAD_ACCEPT,
  UPLOAD_LIMITS,
  UPLOAD_MIME_TYPES,
  checkFiles,
  normalizeMimeType,
  resolveUploadMimeType,
  type AcceptedFile,
  type FileRejectionReason,
  type RejectedFile,
} from './limits';
export {
  UploadError,
  completeAttachment,
  downloadAttachment,
  getAttachmentDownloadUrl,
  isUploadError,
  postToStorage,
  presignAttachment,
  uploadAttachment,
  type UploadAttachmentOptions,
  type UploadErrorReason,
} from './upload';
export {
  useAttachmentUploads,
  type AttachmentUploads,
  type UploadItem,
  type UseAttachmentUploadsOptions,
} from './use-attachment-uploads';
