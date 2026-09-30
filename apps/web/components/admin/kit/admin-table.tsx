'use client';

import { AlertCircle, Inbox } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useId, useLayoutEffect, useRef } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { Kicker } from '@/components/common/kicker';
import { LoadingRegion, SkeletonText, lineWidth, shortWidth } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { transitions } from '@/lib/motion';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';
import { ArchivedBadge } from './archived-badge';
import {
  DragHandle,
  ReorderAnnouncer,
  ReorderButtons,
  useReorder,
  type ReorderHandler,
  type ReorderState,
} from './reorder';

export interface AdminTableColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /**
   * CSS grid track of the column (default `minmax(0,1fr)`), e.g. `'120px'`, `'minmax(0,2fr)'`.
   * Every row is its own grid: use fixed or `fr` tracks, not `auto` (rows would not line up).
   */
  width?: string;
  /** The cell holds its own controls (a switch, a link): it sits above the row's click target. */
  interactive?: boolean;
  /** Not shown on phones (the row stacks there). */
  hideOnMobile?: boolean;
  className?: string;
}

export interface AdminTableProps<T> {
  /** Accessible name of the table, e.g. the section title. */
  label: string;
  /** The first column is the row's name: it becomes the button that opens the row. */
  columns: readonly AdminTableColumn<T>[];
  /** `undefined` while the first load is pending. */
  rows: readonly T[] | undefined;
  getRowId: (row: T) => string;
  /** Plain-text name of a row (reorder buttons and announcements). */
  getRowLabel: (row: T) => string;
  isArchived?: (row: T) => boolean;
  /** Opens the row (its edit sheet). Rows are not clickable without it. */
  onRowClick?: (row: T) => void;
  loading?: boolean;
  /** A load error: shown with a Retry button (`onRetry`). */
  error?: unknown;
  onRetry?: () => void;
  /**
   * "Show archived" switch above the table. Without `onShowArchivedChange` every row passed in is
   * shown. With it, archived rows are hidden while it is off (their count is mentioned below the
   * table) — or pass only the rows the API returned for `status=active|all`.
   */
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  empty?: { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode };
  /**
   * Drag (grip) + Move up / Move down on the active rows (E3). Archived rows keep their place
   * after them and are not reordered.
   */
  reorder?: { onReorder: ReorderHandler; disabled?: boolean };
  /** Extra controls in the toolbar (filters, search), at inline-start. */
  toolbar?: React.ReactNode;
  className?: string;
}

/**
 * Moves focus to the row button now at `index` in `table` (the row after a removed one), else the
 * last row, else the table itself — so keyboard and screen-reader users keep their place when the
 * row they were on disappears (archived while "Show archived" is off, E1).
 */
export function focusRowNear(table: HTMLElement | null, index: number): void {
  if (!table?.isConnected) return;
  const rows = [...table.querySelectorAll<HTMLElement>('[data-row-open]')];
  (rows[Math.min(Math.max(index, 0), rows.length - 1)] ?? table).focus();
}

const ROW_BASE =
  'relative flex flex-col gap-1.5 border-b border-divider px-4 py-3 last:border-b-0 md:grid md:grid-cols-(--admin-cols) md:items-center md:gap-3 md:px-[18px]';

/**
 * The plain admin table (E1; the console's GridTableHeader language): mono uppercase headers,
 * white rounded card, divider rows. Clicking a row (or Enter on its name) opens it. Archived rows
 * are muted with an "Archived" pill. Loading, error and empty states are built in. Below `md` each
 * row stacks, with the column names inline.
 */
export function AdminTable<T>({
  label,
  columns,
  rows,
  getRowId,
  getRowLabel,
  isArchived = () => false,
  onRowClick,
  loading = false,
  error,
  onRetry,
  showArchived = false,
  onShowArchivedChange,
  empty,
  reorder,
  toolbar,
  className,
}: AdminTableProps<T>) {
  const t = useTranslations('admin.kit');
  const errorText = useApiErrorText();
  const switchId = useId();
  const tableRef = useRef<HTMLDivElement>(null);
  // The row button that last had focus: when its row goes away while focus was on it (it is
  // archived and hidden, or deleted), focus moves to the row now in its place.
  const lastRowFocus = useRef<{ button: HTMLElement; index: number } | null>(null);
  useLayoutEffect(() => {
    const last = lastRowFocus.current;
    if (!last || last.button.isConnected) return;
    lastRowFocus.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) focusRowNear(tableRef.current, last.index);
  });

  const all = rows ?? [];
  const active = all.filter((row) => !isArchived(row));
  const archived = all.filter((row) => isArchived(row));
  const filtering = onShowArchivedChange !== undefined;
  const visibleArchived = !filtering || showArchived ? archived : [];
  const hiddenArchived = filtering && !showArchived ? archived.length : 0;
  const tracks = [
    // Every row is its own grid, so every track must have the same size in every row: the grip
    // and the two Move buttons get fixed tracks.
    reorder ? '28px' : null,
    ...columns.map((c) => c.width ?? 'minmax(0,1fr)'),
    reorder ? '72px' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const byId = new Map(active.map((row) => [getRowId(row), row]));
  const reorderState = useReorder({
    ids: active.map(getRowId),
    onReorder: reorder?.onReorder ?? (() => undefined),
    labelOf: (id) => {
      const row = byId.get(id);
      return row === undefined ? id : getRowLabel(row);
    },
  });

  const toolbarRow =
    toolbar || filtering ? (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
        {filtering ? (
          <div className="ms-auto flex items-center gap-2">
            <Switch
              id={switchId}
              checked={showArchived}
              onCheckedChange={(checked) => onShowArchivedChange?.(checked)}
            />
            <label htmlFor={switchId} className="cursor-pointer text-[13px] text-ink-secondary">
              {t('showArchived')}
            </label>
          </div>
        ) : null}
      </div>
    ) : null;

  const header = (
    <div
      role="row"
      className="grid-cols-(--admin-cols) items-center gap-3 border-b border-divider px-[18px] py-3 max-md:sr-only md:grid"
    >
      {reorder ? (
        <span role="columnheader">
          <span className="sr-only">{t('order')}</span>
        </span>
      ) : null}
      {columns.map((column) => (
        <Kicker as="span" key={column.id} role="columnheader" className="truncate">
          {column.header}
        </Kicker>
      ))}
      {reorder ? (
        <span role="columnheader">
          <span className="sr-only">{t('order')}</span>
        </span>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (loading && rows === undefined) {
    body = (
      <LoadingRegion label={t('loading')} role="rowgroup">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} role="row" className={ROW_BASE}>
            {columns.map((column, c) => (
              <span key={column.id} role="cell">
                <SkeletonText className={cn('h-3.5', c === 0 ? lineWidth(i) : shortWidth(i + c))} />
              </span>
            ))}
          </div>
        ))}
      </LoadingRegion>
    );
  } else if (error && rows === undefined) {
    body = (
      <div role="rowgroup">
        <div role="row">
          <div role="cell">
            <EmptyState
              headingLevel="p"
              icon={<AlertCircle />}
              title={t('loadError')}
              description={errorText(error)}
              action={
                onRetry ? (
                  <Button type="button" variant="outline" onClick={onRetry}>
                    {t('retry')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        </div>
      </div>
    );
  } else if (active.length + visibleArchived.length === 0) {
    body = (
      <div role="rowgroup">
        <div role="row">
          <div role="cell">
            <EmptyState
              headingLevel="p"
              icon={<Inbox />}
              title={empty?.title ?? t('emptyTitle')}
              description={empty?.description ?? t('emptyDescription')}
              action={empty?.action}
            />
          </div>
        </div>
      </div>
    );
  } else {
    const renderCells = (row: T, archivedRow: boolean) =>
      columns.map((column, c) => (
        <div
          key={column.id}
          role="cell"
          className={cn(
            'flex min-w-0 items-center gap-2',
            c > 0 && 'text-ink-secondary',
            column.interactive && 'relative z-10',
            column.hideOnMobile && 'max-md:hidden',
            column.className,
          )}
        >
          {c > 0 ? (
            <Kicker as="span" aria-hidden="true" className="w-28 shrink-0 md:hidden">
              {column.header}
            </Kicker>
          ) : null}
          {c === 0 && onRowClick ? (
            <button
              type="button"
              data-row-open=""
              onClick={() => onRowClick(row)}
              className={cn(
                'min-w-0 cursor-pointer text-start font-medium text-ink outline-none after:absolute after:inset-0 focus-visible:outline-hidden',
                archivedRow && 'text-ink-muted',
              )}
            >
              {column.cell(row)}
            </button>
          ) : (
            <div
              className={cn(
                'min-w-0',
                c === 0 && 'font-medium text-ink',
                archivedRow && 'text-ink-muted',
              )}
            >
              {column.cell(row)}
            </div>
          )}
          {c === 0 && archivedRow ? <ArchivedBadge /> : null}
        </div>
      ));

    const rowClass = (archivedRow: boolean) =>
      cn(
        ROW_BASE,
        'bg-surface transition-colors duration-150 ease-out',
        onRowClick && 'hover:bg-surface-muted',
        'has-[[data-row-open]:focus-visible]:bg-surface-muted has-[[data-row-open]:focus-visible]:outline-hidden has-[[data-row-open]:focus-visible]:ring-2 has-[[data-row-open]:focus-visible]:ring-brand has-[[data-row-open]:focus-visible]:ring-inset forced-colors:has-[[data-row-open]:focus-visible]:-outline-offset-2',
        archivedRow && 'bg-surface-muted',
      );

    body = (
      <>
        {reorder ? (
          <Reorder.Group
            as="div"
            axis="y"
            role="rowgroup"
            values={reorderState.order}
            onReorder={reorderState.setOrder}
          >
            {reorderState.order.map((id, index) => {
              const row = byId.get(id);
              if (row === undefined) return null;
              return (
                <ReorderableRow
                  key={id}
                  id={id}
                  index={index}
                  label={getRowLabel(row)}
                  state={reorderState}
                  disabled={reorder.disabled ?? false}
                  className={rowClass(false)}
                >
                  {renderCells(row, false)}
                </ReorderableRow>
              );
            })}
          </Reorder.Group>
        ) : (
          <div role="rowgroup">
            {active.map((row) => (
              <div key={getRowId(row)} role="row" className={rowClass(false)}>
                {renderCells(row, false)}
              </div>
            ))}
          </div>
        )}
        {visibleArchived.length ? (
          <div role="rowgroup">
            {visibleArchived.map((row) => (
              <div key={getRowId(row)} role="row" data-archived="" className={rowClass(true)}>
                {reorder ? <span role="cell" aria-hidden="true" className="max-md:hidden" /> : null}
                {renderCells(row, true)}
                {reorder ? <span role="cell" className="max-md:hidden" /> : null}
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {toolbarRow}
      <div
        ref={tableRef}
        role="table"
        aria-label={label}
        aria-busy={loading || undefined}
        tabIndex={-1}
        data-admin-table=""
        onFocusCapture={(event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement) || !target.matches('[data-row-open]')) return;
          const rows = [...event.currentTarget.querySelectorAll('[data-row-open]')];
          lastRowFocus.current = { button: target, index: rows.indexOf(target) };
        }}
        style={{ '--admin-cols': tracks } as React.CSSProperties}
        className="relative overflow-hidden rounded-xl border border-line bg-surface outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand forced-colors:focus-visible:-outline-offset-2"
      >
        <div role="rowgroup">{header}</div>
        {body}
      </div>
      {hiddenArchived > 0 ? (
        <p className="text-[13px] text-ink-muted">
          {t('archivedHidden', { count: hiddenArchived })}
        </p>
      ) : null}
      {reorder ? <ReorderAnnouncer message={reorderState.announcement} /> : null}
    </div>
  );
}

function ReorderableRow({
  id,
  index,
  label,
  state,
  disabled,
  className,
  children,
}: {
  id: string;
  index: number;
  label: string;
  state: ReorderState;
  disabled: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      role="row"
      value={id}
      dragListener={false}
      dragControls={controls}
      drag={disabled ? false : 'y'}
      layout="position"
      transition={transitions.layout}
      onDragStart={state.onDragStart}
      onDragEnd={() => state.onDragEnd(id)}
      className={className}
    >
      <span role="cell" className="relative z-10 max-md:hidden">
        <DragHandle controls={controls} disabled={disabled} />
      </span>
      {children}
      <span role="cell" className="relative z-10 flex md:justify-end">
        <ReorderButtons
          id={id}
          label={label}
          index={index}
          total={state.order.length}
          state={state}
          disabled={disabled}
        />
      </span>
    </Reorder.Item>
  );
}
