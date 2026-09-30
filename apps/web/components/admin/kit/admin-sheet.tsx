'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { focusRowNear } from './admin-table';
import { ArchivedBadge } from './archived-badge';
import { ConfirmDialog } from './confirm-dialog';
import { AdminSheetInlineContext, INLINE_EDITOR_ATTRIBUTE } from './inline-editor';
import { useBackGuard } from './use-back-guard';

export interface AdminSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `create`: the primary button says "Create" and there is no archive / restore. */
  mode: 'create' | 'edit';
  /**
   * Unsaved changes: closing (Escape, ×, outside click, Cancel, browser Back) asks before
   * discarding them. An InlineEditor inside the sheet with typed text counts too.
   */
  dirty?: boolean;
  /**
   * A sheet that only shows something (e.g. an audit entry): the footer is a single Close button,
   * with no Save / Archive / Restore and no unsaved-changes question.
   */
  readOnly?: boolean;
  /** The row is archived: badge in the title, notice, Restore instead of Archive. */
  archived?: boolean;
  /**
   * Save wiring: `formId` makes Save a submit button of `<form id={formId}>` in the body (enter
   * submits too); otherwise `onSave` is called. Neither: no Save button (read-only sheet).
   */
  formId?: string;
  onSave?: () => void;
  saving?: boolean;
  /** Archive (after a confirmation naming `itemLabel`). Shown in edit mode for active rows. */
  onArchive?: () => void;
  archiving?: boolean;
  /** Restore an archived row. */
  onRestore?: () => void;
  restoring?: boolean;
  /** Plain-text name of the row, for the archive confirmation. */
  itemLabel?: string;
  /** Replaces the archive confirmation's body (e.g. what archiving this row does to routing). */
  archiveWarning?: React.ReactNode;
  /**
   * The last save was refused because someone else changed the row (409 stale, E19): shows
   * "Someone else changed this — reload" with a Reload button, and disables Save.
   */
  conflict?: boolean;
  onReload?: () => void;
  /** A form-level error (already translated). */
  error?: React.ReactNode;
  /** `wide`: room for a live preview beside the form (E16). Default 640 px. Phones: full width. */
  size?: 'default' | 'wide';
  /** Shown beside the form on wide screens (below it on narrow ones), e.g. the live preview. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The side sheet every admin row opens in (E1): 640 px from the inline-end edge (full width on
 * phones), focus trapped inside and given back to what opened it (the row) on close, a scrolling
 * body, and a footer
 * that stays in view with Archive / Restore at inline-start and Cancel + Save at inline-end (a
 * `readOnly` sheet: Close only).
 */
export function AdminSheet({
  open,
  onOpenChange,
  title,
  description,
  mode,
  dirty: formDirty = false,
  readOnly = false,
  archived = false,
  formId,
  onSave,
  saving = false,
  onArchive,
  archiving = false,
  onRestore,
  restoring = false,
  itemLabel,
  archiveWarning,
  conflict = false,
  onReload,
  error,
  size = 'default',
  aside,
  children,
}: AdminSheetProps) {
  const t = useTranslations('admin.kit');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Inline editors (sub-types, sites…) with unsaved text: they are not part of the sheet's form.
  const [inlineDirty, setInlineDirty] = useState<ReadonlySet<string>>(() => new Set());
  const inline = useMemo(
    () => ({
      setDirty: (id: string, value: boolean) =>
        setInlineDirty((current) => {
          if (current.has(id) === value) return current;
          const next = new Set(current);
          if (value) next.add(id);
          else next.delete(id);
          return next;
        }),
    }),
    [],
  );
  const dirty = !readOnly && (formDirty || inlineDirty.size > 0);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Radix only gives focus back to its own Trigger; rows open the sheet without one, so the
  // element that had focus when the sheet opened (the row) gets it back on close.
  const returnFocus = useRef<HTMLElement | null>(null);
  // Where that row sat in its admin table: when the row is gone on close (archived while
  // "Show archived" is off), focus goes to the row now in its place instead of the page.
  const returnRow = useRef<{ table: HTMLElement; index: number } | null>(null);

  // Leaving the page (reload, another URL) with unsaved changes asks the browser's own question.
  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty]);

  // Browser Back is a client-side navigation (no `beforeunload`): it asks the same question, and
  // discarding then goes back.
  const backRequested = useRef(false);
  const backGuard = useBackGuard(open && dirty, () => {
    backRequested.current = true;
    setConfirmDiscard(true);
  });

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };

  const canSave = formId !== undefined || onSave !== undefined;
  const saveBlocked = saving || conflict;
  const busy = saving || archiving || restoring;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else requestClose();
      }}
    >
      <SheetContent
        side="end"
        aria-busy={busy || undefined}
        {...(description ? {} : { 'aria-describedby': undefined })}
        onEscapeKeyDown={(event) => {
          // Escape inside an inline editor cancels only that editor (it handles the key).
          const target = event.target;
          if (target instanceof Element && target.closest(`[${INLINE_EDITOR_ATTRIBUTE}]`)) {
            event.preventDefault();
          }
        }}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          returnFocus.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
          const table = returnFocus.current?.closest<HTMLElement>('[data-admin-table]');
          returnRow.current = table
            ? {
                table,
                index: [...table.querySelectorAll('[data-row-open]')].indexOf(returnFocus.current!),
              }
            : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          const row = returnRow.current;
          returnFocus.current = null;
          returnRow.current = null;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          } else if (row?.table.isConnected) {
            event.preventDefault();
            focusRowNear(row.table, row.index);
          }
        }}
        className={cn(
          'gap-0 data-[side=end]:w-full data-[side=end]:sm:max-w-[640px]',
          size === 'wide' && 'data-[side=end]:lg:max-w-[1040px]',
        )}
      >
        <SheetHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <SheetTitle className="min-w-0 break-words">{title}</SheetTitle>
            {archived ? <ArchivedBadge /> : null}
          </div>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>

        <AdminSheetInlineContext.Provider value={inline}>
          <div
            data-slot="admin-sheet-body"
            className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5"
          >
            {conflict ? (
              <Alert variant="warning" className="px-3.5 py-3 has-data-[slot=alert-action]:pe-3.5">
                <AlertTitle className="text-sm font-semibold text-note-ink-strong">
                  {t('conflictTitle')}
                </AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2.5">
                  <span>{t('conflictBody')}</span>
                  {onReload ? (
                    <Button type="button" variant="outline" size="sm" onClick={onReload}>
                      <RotateCw aria-hidden="true" />
                      {t('reload')}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {archived ? (
              <p
                role="note"
                className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-[13px] leading-normal text-ink-secondary"
              >
                {t('archivedNotice')}
              </p>
            ) : null}
            {error ? (
              <Alert variant="destructive" className="px-3.5 py-3">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {aside ? (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
                <div className="flex min-w-0 flex-col gap-[18px]">{children}</div>
                <div className="min-w-0">{aside}</div>
              </div>
            ) : (
              children
            )}
          </div>
        </AdminSheetInlineContext.Provider>

        <SheetFooter className="mt-0 flex-row flex-wrap items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            {!readOnly && mode === 'edit' && !archived && onArchive ? (
              <Button
                type="button"
                variant="destructive"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) setConfirmArchive(true);
                }}
              >
                {archiving ? t('archiving') : t('archive')}
              </Button>
            ) : null}
            {!readOnly && mode === 'edit' && archived && onRestore ? (
              <Button
                type="button"
                variant="outline"
                aria-disabled={busy || undefined}
                aria-busy={restoring || undefined}
                onClick={() => {
                  if (!busy) onRestore();
                }}
              >
                {restoring ? t('restoring') : t('restore')}
              </Button>
            ) : null}
          </div>
          <div className="ms-auto flex items-center gap-2.5">
            <Button type="button" variant="outline" onClick={requestClose}>
              {readOnly ? t('close') : t('cancel')}
            </Button>
            {canSave && !readOnly ? (
              <Button
                type={formId ? 'submit' : 'button'}
                form={formId}
                aria-disabled={saveBlocked || undefined}
                aria-busy={saving || undefined}
                onClick={(event) => {
                  if (saveBlocked) {
                    event.preventDefault();
                    return;
                  }
                  if (!formId) onSave?.();
                }}
              >
                {saving
                  ? t(mode === 'create' ? 'creating' : 'saving')
                  : t(mode === 'create' ? 'create' : 'save')}
              </Button>
            ) : null}
          </div>
        </SheetFooter>

        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={(next) => {
            if (!next) backRequested.current = false;
            setConfirmDiscard(next);
          }}
          title={t('discardTitle')}
          description={t('discardBody')}
          confirmLabel={t('discard')}
          cancelLabel={t('keepEditing')}
          destructive
          onConfirm={() => {
            const leave = backRequested.current;
            backRequested.current = false;
            setConfirmDiscard(false);
            onOpenChange(false);
            if (leave) backGuard.leave();
          }}
        />
        <ConfirmDialog
          open={confirmArchive}
          onOpenChange={setConfirmArchive}
          title={t('archiveConfirmTitle', { label: itemLabel ?? '' })}
          description={archiveWarning ?? t('archiveConfirmBody')}
          confirmLabel={t('archive')}
          cancelLabel={t('cancel')}
          destructive
          busy={archiving}
          onConfirm={() => {
            setConfirmArchive(false);
            onArchive?.();
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
