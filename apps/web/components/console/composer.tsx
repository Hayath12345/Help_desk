'use client';

import type { MacroDto, TicketStatus } from '@loons/shared';
import { Paperclip, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { useId, useRef, useState } from 'react';
import {
  UploadChipList,
  useNewestUploadFailure,
  useUploadFailureText,
} from '@/components/tickets/upload-chip';
import { Button } from '@/components/ui/button';
import { firstNameOf } from '@/lib/format';
import { newClientTempId } from '@/lib/tickets/ids';
import { useUpdateTicket, type useSendMessage } from '@/lib/tickets/mutations';
import { useMacros } from '@/lib/tickets/queries';
import type { AnyTicketDto } from '@/lib/tickets/types';
import { UPLOAD_ACCEPT, UPLOAD_LIMITS, type RejectedFile } from '@/lib/uploads/limits';
import { useAttachmentUploads } from '@/lib/uploads/use-attachment-uploads';
import { cn } from '@/lib/utils';
import {
  appendToDraft,
  fillMacro,
  macroBody,
  macroContext,
  macroStatusPlan,
  macroTitle,
} from './macros';

export type ComposerMode = 'public' | 'internal';

export interface ComposerProps {
  ticket: AnyTicketDto;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** `useSendMessage(ticket.id)` of the conversation (shared with the thread's Retry / Discard). */
  sender: ReturnType<typeof useSendMessage>;
  /** Typing announcements (`useTyping().notifyTyping / stopTyping`). */
  onTyping?: () => void;
  onStopTyping?: () => void;
  /** Called right after a message was handed to the optimistic sender. */
  onSent?: () => void;
}

const MESSAGE_MAX = 10_000;

/**
 * Console reply composer (design 793–810): "Public reply" / "Internal note" tabs (the note
 * composer is yellow), the text area, attachments, macro buttons that fill
 * {{requesterFirstName}} / {{siteName}} and arm the macro's status, "Send & solve" and
 * "Send reply" / "Add note". Ctrl/⌘ + Enter sends. Each mode keeps its own draft, attachments and
 * armed macro status, so nothing added to a note is ever sent publicly by switching tabs (and vice
 * versa): only the active mode's uploads are shown and sent.
 */
export function Composer({
  ticket,
  mode,
  onModeChange,
  sender,
  onTyping,
  onStopTyping,
  onSent,
}: ComposerProps) {
  const t = useTranslations('console.composer');
  const tStatus = useTranslations('common.status');
  const tFiles = useTranslations('tickets.attachments');
  const failureText = useUploadFailureText();
  const locale = useLocale();
  const baseId = useId();
  const errorId = `${baseId}-error`;
  const textareas = useRef<Partial<Record<ComposerMode, HTMLTextAreaElement | null>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Record<ComposerMode, string>>({ public: '', internal: '' });
  const [armedByMode, setArmedByMode] = useState<Record<ComposerMode, ArmedStatus | null>>({
    public: null,
    internal: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [rejectedByMode, setRejectedByMode] = useState<Record<ComposerMode, RejectedFile[]>>({
    public: [],
    internal: [],
  });
  const [dragging, setDragging] = useState(false);
  // One upload set per mode (like the drafts): a file dropped on the Internal note tab must never
  // ride along with a Public reply — the API links any finished upload to whichever message
  // names it, and files of a public message are downloadable by the client.
  const publicUploads = useAttachmentUploads({ ticketId: ticket.id });
  const noteUploads = useAttachmentUploads({ ticketId: ticket.id });
  const update = useUpdateTicket();
  const macros = useMacros();

  const focus = (which: ComposerMode = mode) => {
    const el = textareas.current[which];
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  };

  const note = mode === 'internal';
  const uploads = note ? noteUploads : publicUploads;
  const armed = armedByMode[mode];
  const rejected = rejectedByMode[mode];
  const setArmed = (value: ArmedStatus | null) =>
    setArmedByMode((current) => ({ ...current, [mode]: value }));
  const firstName = firstNameOf(ticket.requester.name);
  const teamMacros = (macros.data ?? []).filter(
    (macro) => macro.teamId === null || macro.teamId === ticket.team.id,
  );

  const setDraft = (value: string) => {
    setDrafts((current) => ({ ...current, [mode]: value }));
    if (error) setError(null);
  };

  const applyMacro = (macro: MacroDto) => {
    const text = fillMacro(macroBody(macro, locale), macroContext(ticket, locale));
    setDrafts((current) => ({ ...current, [mode]: appendToDraft(current[mode], text) }));
    if (macro.setStatus) setArmed({ status: macro.setStatus, title: macroTitle(macro, locale) });
    setError(null);
    onTyping?.();
    // After React has rendered the new text.
    requestAnimationFrame(() => focus());
  };

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const refused = uploads.add(files);
    setRejectedByMode((current) => ({ ...current, [mode]: refused }));
  };

  const send = (andSolve: boolean) => {
    const body = drafts[mode].trim();
    if (!body) {
      setError(t('empty'));
      focus();
      return;
    }
    if (uploads.isUploading) {
      setError(t('uploading'));
      return;
    }
    if (uploads.hasFailed) {
      setError(t('uploadFailed'));
      return;
    }
    const type: 'PUBLIC' | 'INTERNAL' = note ? 'INTERNAL' : 'PUBLIC';
    const plan = macroStatusPlan({
      current: ticket.status,
      armed: armed?.status ?? null,
      type,
      andSolve,
    });
    const input = {
      type,
      body,
      attachmentIds: [...uploads.attachmentIds],
      attachments: [...uploads.attachments],
      andSolve: plan.andSolve,
      clientTempId: newClientTempId(),
    };
    const followUp = plan.followUp;
    if (followUp) {
      // The macro's status is applied once the message is stored (the reply's own status change
      // would otherwise override it). A failed send keeps its Retry and skips the status.
      sender.mutateAsync(input).then(
        () => update.mutate({ ticketId: ticket.id, patch: { status: followUp } }),
        () => undefined,
      );
    } else {
      sender.send(input);
    }
    setDrafts((current) => ({ ...current, [mode]: '' }));
    setArmed(null);
    setError(null);
    setRejectedByMode((current) => ({ ...current, [mode]: [] }));
    uploads.reset();
    onStopTyping?.();
    onSent?.();
    focus();
  };

  const placeholder = note ? t('notePlaceholder') : t('replyPlaceholder', { name: firstName });
  const pendingStatus = armed && armed.status !== ticket.status ? armed : null;
  const rejectionText = (item: RejectedFile) =>
    item.reason === 'count'
      ? tFiles('rejected.count', { max: UPLOAD_LIMITS.maxFiles })
      : item.reason === 'total'
        ? tFiles('rejected.total')
        : tFiles(`rejected.${item.reason}`, { name: isolate(item.file.name) });
  const rejections = [...new Set(rejected.map(rejectionText))];
  // Announced politely when an upload of the active mode fails (the chip also says why): only
  // the newest failure, so the atomic region never repeats earlier ones, and nothing when the
  // agent switches between the reply and the note (UI-RR-1).
  const newestFailure = useNewestUploadFailure(uploads.items, mode);

  return (
    <div
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
      data-mode={mode}
      className={cn(
        'overflow-hidden rounded-xl border border-line bg-surface shadow-composer transition-[border-color,box-shadow] duration-150 ease-out has-[textarea:focus-visible]:border-brand has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-brand-tint has-[textarea:focus-visible]:outline-hidden',
        dragging && 'border-brand ring-3 ring-brand-tint',
      )}
    >
      <TabsPrimitive.Root
        value={mode}
        onValueChange={(value) => {
          onStopTyping?.();
          onModeChange(value === 'internal' ? 'internal' : 'public');
          setError(null);
        }}
      >
        <TabsPrimitive.List
          aria-label={t('modes')}
          className="flex gap-[18px] border-b border-divider px-4"
        >
          {(['public', 'internal'] as const).map((value) => (
            <TabsPrimitive.Trigger
              key={value}
              value={value}
              className="-mb-px cursor-pointer border-b-2 border-transparent py-2.5 font-medium whitespace-nowrap text-ink-muted transition-[color,border-color] duration-150 ease-out hover:text-ink data-[state=active]:border-brand data-[state=active]:text-ink"
            >
              {value === 'public' ? t('public') : t('internal')}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {(['public', 'internal'] as const).map((value) => (
          <TabsPrimitive.Content key={value} value={value} tabIndex={-1} className="outline-none">
            <textarea
              ref={(el) => {
                textareas.current[value] = el;
              }}
              value={drafts[value]}
              onChange={(event) => {
                setDraft(event.target.value);
                if (event.target.value) onTyping?.();
                else onStopTyping?.();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  send(false);
                }
              }}
              onBlur={() => onStopTyping?.()}
              rows={4}
              maxLength={MESSAGE_MAX}
              placeholder={placeholder}
              aria-label={
                value === 'public' ? t('publicLabel', { name: firstName }) : t('internalLabel')
              }
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              className={cn(
                'block min-h-24 w-full resize-y border-0 px-4 py-3.5 text-[15px] leading-normal text-ink transition-colors duration-150 ease-out outline-none placeholder:text-ink-muted',
                value === 'internal' ? 'bg-note-composer' : 'bg-surface',
              )}
            />
          </TabsPrimitive.Content>
        ))}
      </TabsPrimitive.Root>

      <p role="status" className="sr-only">
        {newestFailure ? (
          // Keyed: another file with the same name and reason is new text, so it is announced.
          <span key={newestFailure.id}>
            {t('uploadFailedFile', {
              name: isolate(newestFailure.name),
              reason: failureText(newestFailure),
            })}
          </span>
        ) : null}
      </p>

      {uploads.items.length || rejections.length || pendingStatus || error ? (
        <div
          className={cn('flex flex-col gap-2 px-4 pb-3', note ? 'bg-note-composer' : 'bg-surface')}
        >
          {uploads.items.length ? (
            <UploadChipList uploads={uploads} progress="instead-of-size" />
          ) : null}
          {rejections.length ? (
            <ul role="alert" className="flex flex-col gap-0.5 text-[13px] font-medium text-danger">
              {rejections.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {pendingStatus ? (
            <p className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-sm bg-surface-sunken py-0.5 ps-2 pe-0.5 text-[13px] text-ink-secondary">
              <span className="min-w-0">
                {t('macroStatus', {
                  macro: pendingStatus.title,
                  status: tStatus(pendingStatus.status),
                })}
              </span>
              <button
                type="button"
                onClick={() => setArmed(null)}
                aria-label={t('keepStatus')}
                title={t('keepStatus')}
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-muted transition-colors hover:bg-surface hover:text-ink"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </p>
          ) : null}
          {error ? (
            <p id={errorId} role="alert" className="text-[13px] font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-divider px-3 py-2.5">
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            addFiles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => fileInput.current?.click()}
          aria-label={t('attach')}
          title={t('attach')}
          className="text-ink-muted"
        >
          <Paperclip aria-hidden="true" />
        </Button>
        {teamMacros.length ? (
          <div role="group" aria-label={t('macros')} className="contents">
            {teamMacros.map((macro) => (
              <button
                key={macro.id}
                type="button"
                onClick={() => applyMacro(macro)}
                className="cursor-pointer rounded-[7px] border border-line bg-surface px-2.5 py-[5px] text-[13px] whitespace-nowrap text-ink transition-colors duration-150 ease-out hover:bg-surface-sunken"
              >
                {macroTitle(macro, locale)}
              </button>
            ))}
          </div>
        ) : null}
        {/* ms-auto: the send buttons stay at the inline end of whichever line they wrap to. */}
        <div className="ms-auto flex items-center gap-2">
          {note ? null : (
            <Button
              type="button"
              variant="outline"
              onClick={() => send(true)}
              className="h-auto px-3 py-2"
            >
              {t('sendSolve')}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => send(false)}
            title={t('shortcut')}
            className="h-auto border-0 px-4 py-2"
          >
            {note ? t('addNote') : t('sendReply')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ArmedStatus {
  status: TicketStatus;
  title: string;
}

/**
 * Wraps text in Unicode first-strong isolates (FSI … PDI) so a file name keeps its own order
 * inside a translated sentence ("2026-09-24 firewall.log" in Arabic).
 */
function isolate(text: string): string {
  return `⁨${text}⁩`;
}
