'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn } from '@/lib/utils';

// Small editors and lists that live inside an admin sheet (sub-types of a category, sites of an
// organisation, members of a team). Each change there is saved on its own, so the sheet's form
// state doesn't know about them; these helpers keep the sheet's rules true for them too:
// - an open inline editor with typed text counts as unsaved changes (closing the sheet asks);
// - Escape inside an inline editor cancels only that editor (the sheet stays open);
// - focus goes into the editor when it opens and back to what opened it when it closes;
// - when a row goes away (archived, removed), focus moves to the row now in its place
//   (WCAG 2.4.3), not to the page.

/**
 * Focus fell out of place: to the page, or to the dialog itself (Radix moves focus to the dialog
 * container when the focused element is removed from the DOM).
 */
function focusWasLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    !active.isConnected ||
    active.matches('[role="dialog"], [role="alertdialog"]')
  );
}

/** Registered by AdminSheet: inline editors report whether they hold unsaved text. */
export const AdminSheetInlineContext = createContext<{
  setDirty: (id: string, dirty: boolean) => void;
} | null>(null);

/** Marks an inline editor: AdminSheet leaves Escape pressed inside it to the editor. */
export const INLINE_EDITOR_ATTRIBUTE = 'data-admin-inline-editor';

export interface InlineEditorProps {
  /** Accessible name of the group (or `aria-labelledby`). */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Typed text not saved yet: closing the sheet asks before discarding it. */
  dirty: boolean;
  /** Cancel (also Escape inside the editor). */
  onCancel: () => void;
  /** Where focus goes when the editor closes (the Add / Edit button that opened it). */
  returnFocus: () => HTMLElement | null | undefined;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  className?: string;
  children: React.ReactNode;
}

/**
 * A role="group" editor inside an admin sheet: focuses its first field when it opens, cancels on
 * Escape, reports unsaved text to the sheet, and gives focus back to its opener when it closes.
 */
export function InlineEditor({
  dirty,
  onCancel,
  returnFocus,
  onKeyDown,
  className,
  children,
  ...labelling
}: InlineEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const sheet = useContext(AdminSheetInlineContext);
  const returnTo = useRef(returnFocus);
  useLayoutEffect(() => {
    returnTo.current = returnFocus;
  });

  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button')
      ?.focus();
    return () => {
      // After the editor left the DOM: focus fell to the page (or stayed on a removed field).
      if (!focusWasLost()) return;
      const target = returnTo.current();
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    sheet?.setDirty(id, dirty);
  }, [sheet, id, dirty]);
  useEffect(() => () => sheet?.setDirty(id, false), [sheet, id]);

  return (
    <div
      ref={ref}
      role="group"
      {...{ [INLINE_EDITOR_ATTRIBUTE]: '' }}
      {...labelling}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // Escape in a portalled popover (a Select's list) belongs to that popover: only keys
        // pressed on the editor's own elements count (React bubbles portal events here too).
        // AdminSheet already prevented the sheet's own Escape for these.
        if (
          event.key === 'Escape' &&
          event.target instanceof Node &&
          ref.current?.contains(event.target)
        ) {
          event.preventDefault();
          onCancel();
        }
      }}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

export interface ListFocus {
  /** Callback ref for the list's section (the element that holds the row controls). */
  attach: (node: HTMLElement | null) => void;
  /** The first control named `name` (optionally of row `rowId`: `data-row-id`) in the section. */
  control: (name: string, rowId?: string) => HTMLElement | null;
  /** Row `id` is about to go away through its `control` (e.g. 'archive', 'remove'). */
  expectRemoval: (id: string, control: string) => void;
  /** The action failed: the row stays, nothing to move. */
  cancelRemoval: () => void;
}

/**
 * Keeps focus in a list whose rows can go away. Put `attach` (ref) on the list's section, mark
 * each row's controls `data-list-control="<name>"` (and `data-row-id`), and pass `fallback` (the
 * list heading, with `tabIndex={-1}`). Call `expectRemoval(id, control)` when an action will
 * remove row `id`; once `ids` no longer contains it — and focus fell out of place — focus moves to
 * the same control of the row now at that position (or the last one), else to the heading.
 */
export function useListFocus(
  ids: readonly string[],
  options: { fallback?: () => HTMLElement | null | undefined } = {},
): ListFocus {
  const container = useRef<HTMLElement | null>(null);
  const fallback = useRef(options.fallback);
  const pending = useRef<{ id: string; index: number; control: string } | null>(null);
  const key = ids.join('\n');
  const current = useRef<readonly string[]>(ids);
  useLayoutEffect(() => {
    fallback.current = options.fallback;
    current.current = ids;
  });

  useEffect(() => {
    const expected = pending.current;
    if (!expected || (key === '' ? [] : key.split('\n')).includes(expected.id)) return;
    pending.current = null;
    if (!focusWasLost()) return;
    const controls = [
      ...(container.current?.querySelectorAll<HTMLElement>(
        `[data-list-control="${expected.control}"]`,
      ) ?? []),
    ];
    const target = controls[Math.min(expected.index, controls.length - 1)] ?? fallback.current?.();
    target?.focus();
  }, [key]);

  const attach = useCallback((node: HTMLElement | null) => {
    container.current = node;
  }, []);
  const control = useCallback(
    (name: string, rowId?: string) =>
      container.current?.querySelector<HTMLElement>(
        rowId
          ? `[data-list-control="${name}"][data-row-id="${rowId}"]`
          : `[data-list-control="${name}"]`,
      ) ?? null,
    [],
  );
  const expectRemoval = useCallback((id: string, name: string) => {
    pending.current = { id, index: Math.max(0, current.current.indexOf(id)), control: name };
  }, []);
  const cancelRemoval = useCallback(() => {
    pending.current = null;
  }, []);
  return { attach, control, expectRemoval, cancelRemoval };
}
