'use client';

import { createMessageSchema, type TicketStatus } from '@loons/shared';
import { Paperclip } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AttachmentDropzone } from '@/components/tickets/attachment-dropzone';
import { Button } from '@/components/ui/button';
import { isolate } from '@/lib/format';
import { transitions } from '@/lib/motion';
import { useTicketValidationMessage } from '@/lib/tickets/i18n';
import type { SendMessageInput } from '@/lib/tickets/types';
import { UPLOAD_LIMITS, type RejectedFile } from '@/lib/uploads/limits';
import { useAttachmentUploads } from '@/lib/uploads/use-attachment-uploads';

/** The shared rule for a reply body: trimmed, 1–10 000 characters (validation.* messages). */
const replyBodySchema = createMessageSchema.shape.body;

const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

/** The attachment area unfolds under the text (height + fade); only fades with reduced motion. */
const REVEAL = { height: 'auto', opacity: 1 } as const;
const FOLDED = { height: 0, opacity: 0 } as const;
const FADED = { opacity: 0 } as const;

/** What the footer shows instead of the hint. */
interface ComposerError {
  /** body: empty / too long · uploading / failed: attachments not ready · rejected: dropped files refused. */
  kind: 'body' | 'uploading' | 'failed' | 'rejected';
  text: string;
}

export interface ReplyComposerProps {
  ticketId: string;
  /** Decides the hint: a reply to a SOLVED ticket reopens it. */
  status: TicketStatus;
  /** `useSendMessage(ticketId).send` — adds the optimistic bubble and posts the reply. */
  onSend: (input: SendMessageInput) => void;
  /** `useTyping(ticketId).notifyTyping` (throttled "is typing" for the ticket room). */
  onTyping?: () => void;
  /** `useTyping(ticketId).stopTyping`. */
  onStopTyping?: () => void;
}

/**
 * Client reply box (design 661–667): textarea, footer with the hint ("We’ll email you when an
 * engineer responds." / "Replying will reopen this ticket.") and Send reply. Attachments open
 * below the text with the paperclip (or by dragging files onto the box) and upload while the
 * client writes. Ctrl/⌘+Enter sends. Sending is optimistic: the box clears at once and the
 * message appears in the thread as "Sending…".
 */
export function ReplyComposer({
  ticketId,
  status,
  onSend,
  onTyping,
  onStopTyping,
}: ReplyComposerProps) {
  const t = useTranslations('portal.reply');
  const tAttachments = useTranslations('tickets.attachments');
  const validationMessage = useTicketValidationMessage();
  // A client's reply is always public.
  const uploads = useAttachmentUploads({ visibility: 'public', ticketId });
  const [body, setBody] = useState('');
  const [error, setError] = useState<ComposerError | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();

  const id = useId();
  const ids = {
    body: `${id}-body`,
    hint: `${id}-hint`,
    error: `${id}-error`,
    shortcut: `${id}-shortcut`,
    zone: `${id}-attachments`,
    files: `${id}-files`,
  };
  const showAttachments = attachOpen || uploads.items.length > 0;
  // "Wait for the uploads" / "retry the failed ones" go away once that's no longer true.
  const shownError =
    (error?.kind === 'uploading' && !uploads.isUploading) ||
    (error?.kind === 'failed' && !uploads.hasFailed)
      ? null
      : error;

  const submit = () => {
    const parsed = replyBodySchema.safeParse(body);
    if (!parsed.success) {
      const text = validationMessage(parsed.error.issues[0]?.message) ?? '';
      setError({ kind: 'body', text });
      textarea.current?.focus();
      return;
    }
    if (uploads.isUploading) {
      setError({ kind: 'uploading', text: t('uploadsPending') });
      return;
    }
    if (uploads.hasFailed) {
      setError({ kind: 'failed', text: t('uploadsFailed') });
      return;
    }
    onSend({
      type: 'PUBLIC',
      body: parsed.data,
      attachmentIds: uploads.attachmentIds,
      attachments: uploads.attachments,
    });
    setBody('');
    setError(null);
    setAttachOpen(false);
    uploads.reset();
    onStopTyping?.();
    textarea.current?.focus();
  };

  const rejectionText = (item: RejectedFile) => {
    switch (item.reason) {
      case 'count':
        return tAttachments('rejected.count', { max: UPLOAD_LIMITS.maxFiles });
      case 'total':
        return tAttachments('rejected.total');
      default:
        // Isolated: a name that starts with digits would otherwise be reordered in Arabic copy.
        return tAttachments(`rejected.${item.reason}`, { name: isolate(item.file.name) });
    }
  };

  const openFilePicker = () => {
    // Render the attachment zone synchronously so its file input exists, then open the picker
    // within this click (browsers only allow it during a user gesture).
    flushSync(() => setAttachOpen(true));
    document.getElementById(ids.files)?.click();
  };

  const attachLabel = attachOpen && uploads.items.length === 0 ? t('hideAttachments') : t('attach');
  const onAttachClick = () => {
    if (attachOpen && uploads.items.length === 0) setAttachOpen(false);
    else openFilePicker();
  };

  return (
    <form
      noValidate
      aria-label={t('label')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragEnter={(event) => {
        if (hasFiles(event)) setAttachOpen(true);
      }}
      onDragOver={(event) => {
        // Without this a file dropped next to the drop zone would make the browser open it.
        if (hasFiles(event)) event.preventDefault();
      }}
      onDrop={(event) => {
        // The drop zone handles (and prevents) drops on itself; take the ones around it.
        if (event.defaultPrevented || !hasFiles(event)) return;
        event.preventDefault();
        const refused = uploads.add(event.dataTransfer.files);
        const texts = [...new Set(refused.map(rejectionText))];
        setError(texts.length ? { kind: 'rejected', text: texts.join(' ') } : null);
      }}
      className="overflow-hidden rounded-xl border border-line bg-surface transition-[border-color,box-shadow] duration-150 ease-out has-[textarea:focus-visible]:border-brand has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-brand-tint has-[textarea:focus-visible]:outline-hidden"
    >
      <label htmlFor={ids.body} className="sr-only">
        {t('label')}
      </label>
      <textarea
        ref={textarea}
        id={ids.body}
        name="body"
        rows={4}
        dir="auto"
        value={body}
        placeholder={t('placeholder')}
        aria-invalid={shownError?.kind === 'body' || undefined}
        aria-describedby={`${shownError ? ids.error : ids.hint} ${ids.shortcut}`}
        onChange={(event) => {
          const next = event.target.value;
          setBody(next);
          if (error?.kind === 'body') setError(null);
          if (next.trim()) onTyping?.();
          else onStopTyping?.();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        className="block min-h-[106px] w-full resize-y border-0 bg-transparent px-4 py-3.5 text-[15px] leading-normal text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none"
      />
      <span id={ids.shortcut} className="sr-only">
        {t('shortcut')}
      </span>

      <AnimatePresence initial={false}>
        {showAttachments ? (
          <motion.div
            key="attachments"
            id={ids.zone}
            initial={reduceMotion ? FADED : FOLDED}
            animate={REVEAL}
            exit={reduceMotion ? FADED : FOLDED}
            transition={transitions.base}
            className="overflow-hidden"
          >
            <AttachmentDropzone
              uploads={uploads}
              id={ids.files}
              compact
              onRejected={() => {
                if (error?.kind === 'rejected') setError(null);
              }}
              className="px-4 pt-1 pb-3"
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onAttachClick}
            aria-expanded={showAttachments}
            aria-controls={showAttachments ? ids.zone : undefined}
            aria-label={attachLabel}
            title={attachLabel}
            className="text-ink-muted hover:text-ink"
          >
            <Paperclip aria-hidden="true" />
          </Button>
          {shownError ? (
            <p id={ids.error} role="alert" className="min-w-0 text-xs font-medium text-danger">
              {shownError.text}
            </p>
          ) : (
            <p id={ids.hint} className="min-w-0 text-xs text-ink-muted">
              {status === 'SOLVED' ? t('reopenHint') : t('hint')}
            </p>
          )}
        </div>
        <Button type="submit" className="h-auto px-4 py-2">
          {t('send')}
        </Button>
      </div>
    </form>
  );
}
