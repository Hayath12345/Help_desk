'use client';

import type { AttachmentDto } from '@loons/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newClientTempId } from '@/lib/tickets/ids';
import { UPLOAD_LIMITS, checkFiles, type RejectedFile } from './limits';
import { isUploadError, uploadAttachment, type UploadErrorReason } from './upload';

export interface UploadItem {
  /** Local id (not the attachment id). */
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  /** 0…1 */
  progress: number;
  status: 'uploading' | 'done' | 'error';
  /** Set once the upload is complete. */
  attachment: AttachmentDto | null;
  error: UploadErrorReason | null;
}

export interface AttachmentUploads {
  items: UploadItem[];
  /** Checks the files against the limits, starts uploading the accepted ones, returns the rest. */
  add: (files: FileList | readonly File[]) => RejectedFile[];
  /** Cancels (if still uploading) and forgets one file. */
  remove: (id: string) => void;
  retry: (id: string) => void;
  /** Cancels everything and clears the list (e.g. after sending). */
  reset: () => void;
  /** Ids of the finished uploads, for `attachmentIds`. */
  attachmentIds: string[];
  attachments: AttachmentDto[];
  isUploading: boolean;
  hasFailed: boolean;
  totalBytes: number;
}

export interface UseAttachmentUploadsOptions {
  /** Uploads for a reply on an existing ticket; omit while creating a ticket. */
  ticketId?: string;
  /** Injected in tests. */
  upload?: typeof uploadAttachment;
  limits?: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number };
}

/**
 * State for a set of attachments being added to a ticket or reply: client-side checks (types,
 * 25 MB each, 25 MB total, ≤ 10 files), parallel uploads with progress, cancel/remove, retry.
 * Pair it with `<AttachmentDropzone uploads={…} />`.
 */
export function useAttachmentUploads(options: UseAttachmentUploadsOptions = {}): AttachmentUploads {
  const { ticketId, upload = uploadAttachment, limits = UPLOAD_LIMITS } = options;
  const [items, setItems] = useState<UploadItem[]>([]);
  // Mirror of `items` for synchronous reads in callbacks (several adds in one tick).
  const itemsRef = useRef<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const commit = useCallback((update: (list: UploadItem[]) => UploadItem[]) => {
    itemsRef.current = update(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<UploadItem>) =>
      commit((list) => list.map((item) => (item.id === id ? { ...item, ...changes } : item))),
    [commit],
  );

  const start = useCallback(
    (item: UploadItem) => {
      controllers.current.get(item.id)?.abort();
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      let lastPercent = -1;
      upload(item.file, {
        ticketId,
        signal: controller.signal,
        onProgress: (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (percent === lastPercent) return;
          lastPercent = percent;
          patch(item.id, { progress: fraction });
        },
      })
        .then((attachment) => {
          if (controller.signal.aborted) return;
          patch(item.id, { status: 'done', progress: 1, attachment, error: null });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const reason = isUploadError(error) ? error.reason : 'network';
          if (reason === 'aborted') return;
          patch(item.id, { status: 'error', error: reason });
        })
        .finally(() => {
          if (controllers.current.get(item.id) === controller) controllers.current.delete(item.id);
        });
    },
    [upload, ticketId, patch],
  );

  const add = useCallback(
    (files: FileList | readonly File[]) => {
      const list = Array.from(files);
      const current = itemsRef.current;
      const { accepted, rejected } = checkFiles(
        list,
        { count: current.length, totalBytes: current.reduce((sum, i) => sum + i.size, 0) },
        limits,
      );
      const created: UploadItem[] = accepted.map(({ file, mimeType }) => ({
        id: newClientTempId(),
        file,
        name: file.name,
        size: file.size,
        mimeType,
        progress: 0,
        status: 'uploading',
        attachment: null,
        error: null,
      }));
      if (created.length) {
        commit((prev) => [...prev, ...created]);
        created.forEach(start);
      }
      return rejected;
    },
    [commit, start, limits],
  );

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      controllers.current.delete(id);
      commit((list) => list.filter((item) => item.id !== id));
    },
    [commit],
  );

  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item || item.status !== 'error') return;
      const next: UploadItem = { ...item, status: 'uploading', progress: 0, error: null };
      patch(id, next);
      start(next);
    },
    [patch, start],
  );

  const reset = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    commit(() => []);
  }, [commit]);

  // Abandoned uploads are cancelled when the form goes away.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      map.forEach((controller) => controller.abort());
      map.clear();
    };
  }, []);

  return useMemo(() => {
    const done = items.filter((i) => i.status === 'done' && i.attachment);
    return {
      items,
      add,
      remove,
      retry,
      reset,
      attachmentIds: done.map((i) => i.attachment!.id),
      attachments: done.map((i) => i.attachment!),
      isUploading: items.some((i) => i.status === 'uploading'),
      hasFailed: items.some((i) => i.status === 'error'),
      totalBytes: items.reduce((sum, i) => sum + i.size, 0),
    };
  }, [items, add, remove, retry, reset]);
}
