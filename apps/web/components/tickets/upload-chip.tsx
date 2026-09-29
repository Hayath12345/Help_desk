'use client';

import { RotateCw, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { formatNumber } from '@/lib/format';
import { listItemVariants } from '@/lib/motion';
import type { UploadErrorReason } from '@/lib/uploads/upload';
import type { AttachmentUploads, UploadItem } from '@/lib/uploads/use-attachment-uploads';
import { cn } from '@/lib/utils';
import { FileTypeIcon, attachmentChipClass } from './attachment-chips';
import { useFileSizeFormatter } from './file-size';

/**
 * What an uploading chip shows next to the name: `beside-size` (the New ticket form and the
 * portal reply) keeps the size and adds the percentage; `instead-of-size` (the narrower console
 * composer) shows the percentage until the upload finished, then the size.
 */
export type UploadChipProgress = 'beside-size' | 'instead-of-size';

export interface UploadChipProps {
  item: UploadItem;
  /** From `useAttachmentUploads()`: Retry / Remove act on it. */
  uploads: Pick<AttachmentUploads, 'retry' | 'remove'>;
  progress?: UploadChipProgress;
}

/**
 * One upload: the chip (icon, name, size / progress, Retry / Remove) and, when the upload failed,
 * the reason on its own line under it. The reason used to sit inside the chip, which at phone
 * widths squeezed the name to nothing and pushed the buttons out of the clipped chip (UI-RR-1);
 * under the chip it wraps freely and describes the two buttons (not colour alone; DA-10). The
 * name is `dir="auto"`, so "2026-09-24 firewall.log" keeps its order in the Arabic UI (DA-7).
 * Shared by the attachment dropzone and the console composer, so a fix reaches both.
 */
export function UploadChip({ item, uploads, progress = 'beside-size' }: UploadChipProps) {
  const t = useTranslations('tickets.attachments');
  const locale = useLocale();
  const formatSize = useFileSizeFormatter();
  const failureText = useUploadFailureText();
  const reasonId = useId();
  const percent = Math.round(item.progress * 100);
  const failed = item.status === 'error';
  const uploading = item.status === 'uploading';
  const percentText = t('progress', { percent: formatNumber(percent, locale) });

  return (
    <motion.li
      layout="position"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex max-w-full min-w-0 flex-col items-start gap-1"
    >
      <span
        className={cn(
          attachmentChipClass,
          'relative overflow-hidden',
          failed && 'border-danger-strong bg-danger-tint',
        )}
      >
        <FileTypeIcon mimeType={item.mimeType} />
        {/* dir="auto": "2026-09-24 firewall.log" keeps its order inside the Arabic UI. */}
        <span dir="auto" className="max-w-[220px] min-w-0 truncate" title={item.name}>
          {item.name}
        </span>
        <span
          className={cn(
            'font-mono text-xs whitespace-nowrap',
            // ink-muted is only 4.23:1 on the failed chip's danger tint.
            failed ? 'text-ink-secondary' : 'text-ink-muted',
          )}
        >
          {uploading && progress === 'instead-of-size' ? percentText : formatSize(item.size)}
        </span>
        {uploading && progress === 'beside-size' ? (
          <span className="font-mono text-xs whitespace-nowrap text-ink-secondary">
            {percentText}
          </span>
        ) : null}
        {failed ? (
          <button
            type="button"
            onClick={() => uploads.retry(item.id)}
            aria-label={t('retry', { name: item.name })}
            aria-describedby={reasonId}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-secondary transition-colors duration-150 hover:bg-surface hover:text-ink"
          >
            <RotateCw aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => uploads.remove(item.id)}
          aria-label={t('remove', { name: item.name })}
          aria-describedby={failed ? reasonId : undefined}
          className={cn(
            'grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm transition-colors duration-150 hover:bg-surface-sunken hover:text-danger',
            failed ? 'text-ink-secondary' : 'text-ink-muted',
          )}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
        {uploading ? (
          <span
            role="progressbar"
            aria-label={t('uploading', { name: item.name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="absolute inset-x-0 bottom-0 h-0.5 bg-track"
          >
            <span
              className="block h-full bg-brand transition-[width] duration-150 ease-out"
              style={{ width: `${Math.max(4, percent)}%` }}
            />
          </span>
        ) : null}
      </span>
      {failed ? (
        // Not colour alone: the reason is written under the chip and describes its buttons.
        <span id={reasonId} className="text-xs font-medium text-danger">
          {failureText(item)}
        </span>
      ) : null}
    </motion.li>
  );
}

/** The upload chips of `uploads` (animated in and out). */
export function UploadChipList({
  uploads,
  progress,
}: {
  uploads: AttachmentUploads;
  progress?: UploadChipProgress;
}) {
  const t = useTranslations('tickets.attachments');
  return (
    <ul aria-label={t('label')} className="flex flex-wrap gap-2">
      <AnimatePresence initial={false}>
        {uploads.items.map((item) => (
          <UploadChip key={item.id} item={item} uploads={uploads} progress={progress} />
        ))}
      </AnimatePresence>
    </ul>
  );
}

/** Why an upload failed, in words (the chip shows it; the live regions announce it). */
export function useUploadFailureText(): (item: UploadItem) => string {
  const t = useTranslations('tickets.attachments');
  return (item) => t(uploadErrorKey(item.error));
}

/** `tickets.attachments.*` text for a failed upload (unknown reasons read as a storage failure). */
function uploadErrorKey(
  reason: UploadErrorReason | null,
):
  | 'failed'
  | 'error.storage'
  | 'error.rejected'
  | 'error.content'
  | 'error.network'
  | 'error.type'
  | 'error.size'
  | 'error.empty' {
  switch (reason) {
    case null:
      return 'failed';
    case 'rejected':
    case 'content':
    case 'network':
    case 'type':
    case 'size':
    case 'empty':
      return `error.${reason}`;
    default:
      return 'error.storage';
  }
}

interface FailureTracking {
  scope: string;
  /** The ids that had failed at the last render. */
  failed: readonly string[];
  /** The upload that failed last, while it is still failed. */
  newest: string | null;
  /** The failed ids each other scope had when it was last shown. */
  seen: Readonly<Record<string, readonly string[]>>;
}

/**
 * The upload that failed most recently, while it stays failed: what a polite status region
 * announces. A `role="status"` region is atomic, so listing every failure there made each new
 * failure (and each removal) read all the remaining ones again (UI-RR-1); with only the newest,
 * a second failure announces only itself and removing another failed file changes nothing.
 * Removing or retrying the newest clears it (an emptied region announces nothing).
 *
 * `scope` is the composer's Public reply / Internal note tab, whose uploads keep running while
 * the other tab is shown: switching back announces the newest upload of that tab that failed
 * while it was hidden (round-2 verify: such a failure was never announced), and nothing when none
 * did — what failed there before is on its chips. Render the announcement keyed by the item's id,
 * so a second file with the same name and reason replaces the text and is announced too.
 */
export function useNewestUploadFailure(
  items: readonly UploadItem[],
  scope = '',
): UploadItem | null {
  const failed = items.filter((item) => item.status === 'error').map((item) => item.id);
  const [tracked, setTracked] = useState<FailureTracking>(() => ({
    scope,
    failed,
    newest: null,
    seen: {},
  }));
  let current = tracked;
  const changed =
    tracked.scope !== scope ||
    tracked.failed.length !== failed.length ||
    tracked.failed.some((id, i) => id !== failed[i]);
  if (changed) {
    let newest: string | null;
    let seen = tracked.seen;
    if (tracked.scope !== scope) {
      // What this scope had failed when it was last shown (never shown: nothing can have).
      const before = seen[scope] ?? failed;
      newest = failed.filter((id) => !before.includes(id)).at(-1) ?? null;
      seen = { ...seen, [tracked.scope]: tracked.failed };
    } else {
      const added = failed.filter((id) => !tracked.failed.includes(id));
      const kept =
        tracked.newest !== null && failed.includes(tracked.newest) ? tracked.newest : null;
      newest = added.at(-1) ?? kept;
    }
    current = { scope, failed, newest, seen };
    // Adjusting state while rendering (React's pattern for state derived from changing props).
    setTracked(current);
  }
  return items.find((item) => item.id === current.newest) ?? null;
}
