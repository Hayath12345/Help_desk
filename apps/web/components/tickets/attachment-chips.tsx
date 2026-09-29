'use client';

import type { AttachmentDto } from '@loons/shared';
import { Download, FileArchive, FileImage, FileText, FileVideo, Paperclip } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { downloadAttachment } from '@/lib/uploads/upload';
import { cn } from '@/lib/utils';
import { useFileSizeFormatter } from './file-size';

/** Icon for a MIME type (decorative). */
export function FileTypeIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  const props = { 'aria-hidden': true, className: cn('size-4 shrink-0 text-ink-muted', className) };
  if (mimeType.startsWith('image/')) return <FileImage {...props} />;
  if (mimeType.startsWith('video/')) return <FileVideo {...props} />;
  if (mimeType.includes('zip')) return <FileArchive {...props} />;
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/'))
    return <FileText {...props} />;
  return <Paperclip {...props} />;
}

/** Shared chip look (design file chips: 1px line border, 8px radius, 13px). */
export const attachmentChipClass =
  'inline-flex max-w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface py-[5px] ps-2.5 pe-1.5 text-[13px] text-ink';

function AttachmentChip({ attachment }: { attachment: AttachmentDto }) {
  const t = useTranslations('tickets.attachments');
  const formatSize = useFileSizeFormatter();
  const [pending, setPending] = useState(false);

  const onDownload = async () => {
    if (pending) return;
    setPending(true);
    try {
      await downloadAttachment(attachment.id);
    } catch {
      toast.error(t('downloadFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="max-w-full min-w-0">
      <button
        type="button"
        onClick={onDownload}
        aria-busy={pending || undefined}
        aria-label={t('download', { name: attachment.fileName })}
        title={attachment.fileName}
        className={cn(
          attachmentChipClass,
          'cursor-pointer pe-2 transition-colors duration-150 ease-out hover:bg-surface-sunken aria-busy:opacity-70',
        )}
      >
        <FileTypeIcon mimeType={attachment.mimeType} />
        <span dir="auto" className="max-w-[220px] min-w-0 truncate">
          {attachment.fileName}
        </span>
        <span className="font-mono text-xs whitespace-nowrap text-ink-muted">
          {formatSize(attachment.sizeBytes)}
        </span>
        <Download aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
      </button>
    </li>
  );
}

/**
 * Attachments of a message or ticket as download chips. Clicking one fetches a 5-minute signed
 * URL (GET /attachments/:id/download) and starts the download.
 */
export function AttachmentChips({
  attachments,
  className,
}: {
  attachments: readonly AttachmentDto[];
  className?: string;
}) {
  const t = useTranslations('tickets.attachments');
  if (attachments.length === 0) return null;
  return (
    <ul aria-label={t('label')} className={cn('flex flex-wrap gap-2', className)}>
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.id} attachment={attachment} />
      ))}
    </ul>
  );
}
