'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { isolate } from '@/lib/format';
import { UPLOAD_ACCEPT, UPLOAD_LIMITS, type RejectedFile } from '@/lib/uploads/limits';
import type { AttachmentUploads } from '@/lib/uploads/use-attachment-uploads';
import { cn } from '@/lib/utils';
import { UploadChipList, useNewestUploadFailure, useUploadFailureText } from './upload-chip';

export interface AttachmentDropzoneProps {
  /** From `useAttachmentUploads()`. */
  uploads: AttachmentUploads;
  id?: string;
  disabled?: boolean;
  /** Smaller zone for reply composers. */
  compact?: boolean;
  /** Also told about files refused before uploading (shown inline either way). */
  onRejected?: (rejected: RejectedFile[]) => void;
  className?: string;
}

/**
 * Drag-and-drop / browse zone (design New ticket modal) plus the upload chips (progress, remove,
 * retry). Client-side limits: allowed types, 25 MB each, 25 MB total, 10 files. The hidden file
 * input is keyboard-focusable; the zone shows the focus ring.
 */
export function AttachmentDropzone({
  uploads,
  id,
  disabled = false,
  compact = false,
  onRejected,
  className,
}: AttachmentDropzoneProps) {
  const t = useTranslations('tickets.attachments');
  const failureText = useUploadFailureText();
  const autoId = useId();
  const inputId = id ?? `${autoId}-files`;
  const hintId = `${inputId}-hint`;
  const [dragOver, setDragOver] = useState(false);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const depth = useRef(0);

  const addFiles = (files: FileList | null) => {
    if (!files || files.length === 0 || disabled) return;
    const refused = uploads.add(files);
    setRejected(refused);
    if (refused.length) onRejected?.(refused);
  };

  const rejectionText = (item: RejectedFile) => {
    switch (item.reason) {
      case 'count':
        return t('rejected.count', { max: UPLOAD_LIMITS.maxFiles });
      case 'total':
        return t('rejected.total');
      default:
        // Isolated: a name that starts with digits would otherwise be reordered in Arabic copy.
        return t(`rejected.${item.reason}`, { name: isolate(item.file.name) });
    }
  };
  // One line per distinct message (e.g. a single "up to 10 files" for several extra files).
  const messages = [...new Set(rejected.map(rejectionText))];
  const newestFailure = useNewestUploadFailure(uploads.items);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          if (disabled || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          depth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          depth.current = 0;
          setDragOver(false);
          addFiles(event.dataTransfer.files);
        }}
        data-dragging={dragOver || undefined}
        className={cn(
          'relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border-[1.5px] border-dashed border-line-dashed bg-surface-muted text-center transition-colors duration-150 ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand hover:border-brand-border',
          compact ? 'px-3 py-2.5' : 'p-4',
          dragOver && 'border-brand bg-brand-wash',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <input
          id={inputId}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => {
            addFiles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
          className="sr-only"
        />
        <span className={cn('font-semibold text-ink', compact && 'text-[13px]')}>
          {dragOver ? (
            t('dropActive')
          ) : (
            <>
              {t('drop')} <span className="text-brand-ink">{t('browse')}</span>
            </>
          )}
        </span>
        <span id={hintId} className={cn('text-ink-secondary', compact ? 'text-xs' : 'text-[13px]')}>
          {t('hint')}
        </span>
      </label>

      {messages.length ? (
        <ul role="alert" className="flex flex-col gap-0.5 text-[13px] font-medium text-danger">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {uploads.items.length ? <UploadChipList uploads={uploads} progress="beside-size" /> : null}

      {/* Screen readers hear about a failed upload when it fails (the chip shows it in text):
          only the newest failure, so the atomic region never repeats earlier ones (UI-RR-1). */}
      <p role="status" className="sr-only">
        {newestFailure ? (
          // Keyed: another file with the same name and reason is new text, so it is announced.
          <span key={newestFailure.id}>
            {t('failedAnnouncement', {
              name: isolate(newestFailure.name),
              reason: failureText(newestFailure),
            })}
          </span>
        ) : null}
      </p>
    </div>
  );
}
