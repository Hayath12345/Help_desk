'use client';

import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { Reorder, useDragControls, type DragControls } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { transitions } from '@/lib/motion';
import { cn } from '@/lib/utils';

// Reordering without a new dependency (docs/PHASE4_CONTRACT.md E3): motion's `Reorder` for pointer
// drag (from the grip only, so the row's own controls stay clickable) plus "Move up" / "Move down"
// buttons for keyboard and screen-reader users. One `onReorder(nextIds, previousIds)` per drop or
// per button press — the API's reorder body is `{ ids: nextIds, expectedIds: previousIds }` (409
// `order_changed` when someone reordered meanwhile). The new position is announced politely.

/**
 * Called once per drop / button press. It may return the save's promise: when it rejects, the
 * rows go back to the order they had (for lists whose data is not updated optimistically).
 */
export type ReorderHandler = (nextIds: string[], previousIds: string[]) => void | Promise<unknown>;

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function moveItem(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

type Direction = 'up' | 'down';

/** State behind `ReorderList` and the reorderable `AdminTable`. */
export function useReorder({
  ids,
  onReorder,
  labelOf,
}: {
  ids: readonly string[];
  onReorder: ReorderHandler;
  labelOf: (id: string) => string;
}) {
  const t = useTranslations('admin.kit.reorder');
  const [order, setOrderState] = useState<string[]>(() => [...ids]);
  const orderRef = useRef(order);
  const setOrder = useCallback((next: string[]) => {
    orderRef.current = next;
    setOrderState(next);
  }, []);
  const dragStart = useRef<string[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // The last move announced, until the server's order confirms or refuses it.
  const lastMove = useRef<{ id: string; before: string[]; after: string[] } | null>(null);
  const pendingFocus = useRef<{ id: string; direction: Direction } | null>(null);

  // Follow the server's order (refetches, other admins' changes) unless a drag is in progress.
  const signature = ids.join('\n');
  useEffect(() => {
    if (dragStart.current) return;
    const next = signature ? signature.split('\n') : [];
    if (!sameOrder(orderRef.current, next)) setOrder(next);
    const move = lastMove.current;
    if (!move) return;
    if (sameOrder(next, move.before) && !sameOrder(move.before, move.after)) {
      // Refused (order_changed, an error): the rows snapped back. The live region said the row
      // moved — correct it.
      lastMove.current = null;
      setAnnouncement(
        t('notSaved', {
          label: labelOf(move.id),
          position: next.indexOf(move.id) + 1,
          total: next.length,
        }),
      );
    } else if (!sameOrder(next, move.after)) {
      lastMove.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the server's order changes
  }, [signature, setOrder]);

  // A refused save of a list without an optimistic cache: put the rows back and say so.
  const settle = useCallback(
    (result: void | Promise<unknown>, id: string, before: string[], after: string[]) => {
      if (!(result instanceof Promise)) return;
      result.catch(() => {
        if (!sameOrder(orderRef.current, after)) return;
        lastMove.current = null;
        setOrder(before);
        setAnnouncement(
          t('notSaved', {
            label: labelOf(id),
            position: before.indexOf(id) + 1,
            total: before.length,
          }),
        );
      });
    },
    [labelOf, setOrder, t],
  );

  const announce = useCallback(
    (id: string, list: readonly string[]) =>
      setAnnouncement(
        t('moved', { label: labelOf(id), position: list.indexOf(id) + 1, total: list.length }),
      ),
    [labelOf, t],
  );

  const move = useCallback(
    (id: string, direction: Direction) => {
      const current = orderRef.current;
      const from = current.indexOf(id);
      const to = direction === 'up' ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= current.length) return;
      const next = moveItem(current, from, to);
      setOrder(next);
      pendingFocus.current = { id, direction };
      announce(id, next);
      lastMove.current = { id, before: [...current], after: next };
      settle(onReorder(next, [...current]), id, [...current], next);
    },
    [announce, onReorder, setOrder, settle],
  );

  // Moving a row re-inserts its DOM node, which drops focus: put it back on the same button, or on
  // the other one when the row reached an end (that button is then unavailable).
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const index = order.indexOf(target.id);
    const atEdge = target.direction === 'up' ? index === 0 : index === order.length - 1;
    const direction = atEdge ? (target.direction === 'up' ? 'down' : 'up') : target.direction;
    buttons.current.get(`${target.id}:${direction}`)?.focus();
  }, [order]);

  const registerButton = useCallback(
    (id: string, direction: Direction) => (node: HTMLButtonElement | null) => {
      const key = `${id}:${direction}`;
      if (node) buttons.current.set(key, node);
      else buttons.current.delete(key);
    },
    [],
  );

  const onDragStart = useCallback(() => {
    dragStart.current ??= [...orderRef.current];
  }, []);

  const onDragEnd = useCallback(
    (id: string) => {
      const before = dragStart.current;
      dragStart.current = null;
      const after = orderRef.current;
      if (!before || sameOrder(before, after)) return;
      announce(id, after);
      lastMove.current = { id, before, after: [...after] };
      settle(onReorder([...after], before), id, before, [...after]);
    },
    [announce, onReorder, settle],
  );

  return { order, setOrder, move, registerButton, onDragStart, onDragEnd, announcement };
}

export type ReorderState = ReturnType<typeof useReorder>;

/** The polite live region that announces "X moved to position n of m". */
export function ReorderAnnouncer({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

/** Pointer-only grip (keyboard users have the Move buttons; hidden from assistive tech). */
export function DragHandle({
  controls,
  disabled,
  className,
}: {
  controls: DragControls;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('admin.kit.reorder');
  return (
    <span
      aria-hidden="true"
      title={disabled ? undefined : t('handle')}
      data-slot="drag-handle"
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        controls.start(event);
      }}
      className={cn(
        'grid size-7 shrink-0 touch-none place-items-center rounded-sm text-ink-subtle',
        disabled
          ? 'opacity-40'
          : 'cursor-grab hover:bg-surface-sunken hover:text-ink-muted active:cursor-grabbing',
        className,
      )}
    >
      <GripVertical className="size-4" />
    </span>
  );
}

/** "Move up" / "Move down" for one row. Unavailable ends stay focusable (`aria-disabled`). */
export function ReorderButtons({
  id,
  label,
  index,
  total,
  state,
  disabled,
  className,
}: {
  id: string;
  label: string;
  index: number;
  total: number;
  state: ReorderState;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('admin.kit.reorder');
  const button = (direction: Direction) => {
    const unavailable = disabled || (direction === 'up' ? index === 0 : index === total - 1);
    const Icon = direction === 'up' ? ArrowUp : ArrowDown;
    return (
      <Button
        ref={state.registerButton(id, direction)}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t(direction === 'up' ? 'moveUp' : 'moveDown', { label })}
        aria-disabled={unavailable || undefined}
        onClick={() => {
          if (!unavailable) state.move(id, direction);
        }}
        className="text-ink-muted aria-disabled:opacity-35"
      >
        <Icon aria-hidden="true" />
      </Button>
    );
  };
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {button('up')}
      {button('down')}
    </span>
  );
}

export interface ReorderListProps<T> {
  items: readonly T[];
  getId: (item: T) => string;
  /** Plain-text name, used in the Move buttons' labels and the announcement. */
  getLabel: (item: T) => string;
  onReorder: ReorderHandler;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Accessible name of the list. */
  label: string;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}

function ReorderListItem({
  id,
  disabled,
  state,
  className,
  children,
}: {
  id: string;
  disabled: boolean;
  state: ReorderState;
  className?: string;
  children: (controls: DragControls) => React.ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="li"
      value={id}
      dragListener={false}
      dragControls={controls}
      drag={disabled ? false : 'y'}
      layout="position"
      transition={transitions.layout}
      onDragStart={state.onDragStart}
      onDragEnd={() => state.onDragEnd(id)}
      className={cn(
        'relative flex items-center gap-2 border-b border-divider bg-surface py-2 ps-2 pe-3 last:border-b-0',
        className,
      )}
    >
      {children(controls)}
    </Reorder.Item>
  );
}

/**
 * A vertical list the admin can reorder by dragging the grip or with the Move buttons (sub-types
 * of a category, escalation steps, a category's fields…).
 */
export function ReorderList<T>({
  items,
  getId,
  getLabel,
  onReorder,
  renderItem,
  label,
  disabled = false,
  className,
  itemClassName,
}: ReorderListProps<T>) {
  const byId = new Map(items.map((item) => [getId(item), item]));
  const labelOf = (id: string) => {
    const item = byId.get(id);
    return item === undefined ? id : getLabel(item);
  };
  const state = useReorder({ ids: items.map(getId), onReorder, labelOf });

  return (
    <div className={cn('flex flex-col', className)}>
      <Reorder.Group
        as="ol"
        axis="y"
        values={state.order}
        onReorder={state.setOrder}
        aria-label={label}
        className="flex flex-col overflow-hidden rounded-lg border border-line"
      >
        {state.order.map((id, index) => {
          const item = byId.get(id);
          if (item === undefined) return null;
          return (
            <ReorderListItem
              key={id}
              id={id}
              disabled={disabled}
              state={state}
              className={itemClassName}
            >
              {(controls) => (
                <>
                  <DragHandle controls={controls} disabled={disabled} />
                  <div className="min-w-0 flex-1">{renderItem(item, index)}</div>
                  <ReorderButtons
                    id={id}
                    label={getLabel(item)}
                    index={index}
                    total={state.order.length}
                    state={state}
                    disabled={disabled}
                  />
                </>
              )}
            </ReorderListItem>
          );
        })}
      </Reorder.Group>
      <ReorderAnnouncer message={state.announcement} />
    </div>
  );
}
