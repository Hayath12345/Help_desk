// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { AdminTable, type AdminTableColumn, type AdminTableProps } from './admin-table';
import { renderKit, stubBrowserApis } from './kit-test-utils';

beforeAll(stubBrowserApis);
afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  team: string;
  isActive: boolean;
}
const ROWS: Row[] = [
  { id: 'c1', name: 'Cybersecurity / SOC', team: 'SOC', isActive: true },
  { id: 'c2', name: 'Network', team: 'NOC', isActive: true },
  { id: 'c3', name: 'Legacy PBX', team: 'NOC', isActive: false },
];
const COLUMNS: AdminTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, width: 'minmax(0,2fr)' },
  { id: 'team', header: 'Routed to', cell: (r) => r.team, width: '160px' },
];

function table(props: Partial<AdminTableProps<Row>> = {}) {
  return (
    <AdminTable<Row>
      label="Categories"
      columns={COLUMNS}
      rows={ROWS}
      getRowId={(r) => r.id}
      getRowLabel={(r) => r.name}
      isArchived={(r) => !r.isActive}
      {...props}
    />
  );
}

const names = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

describe('AdminTable (E1)', () => {
  it('renders a labelled table with column headers and opens a row on click', () => {
    const onRowClick = vi.fn();
    renderKit(table({ onRowClick }));
    const grid = screen.getByRole('table', { name: 'Categories' });
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Routed to']);
    expect(grid.getAttribute('style')).toContain('--admin-cols: minmax(0,2fr) 160px');
    fireEvent.click(within(grid).getByRole('button', { name: 'Network' }));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('hides archived rows behind "Show archived", then shows them muted with a pill', () => {
    const onShowArchivedChange = vi.fn();
    const { rerender } = renderKit(table({ onShowArchivedChange }));
    expect(names()).toEqual(['Cybersecurity / SOC', 'Network']);
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(onShowArchivedChange).toHaveBeenCalledWith(true);

    rerender(table({ onShowArchivedChange, showArchived: true }));
    expect(names()).toEqual(['Cybersecurity / SOC', 'Network', 'Legacy PBXArchived']);
    const archivedRow = screen.getAllByRole('row').find((r) => r.hasAttribute('data-archived'));
    expect(archivedRow?.className).toContain('bg-surface-muted');
    expect(within(archivedRow!).getByText('Archived')).toBeTruthy();
    expect(screen.queryByText(/archived item is hidden/)).toBeNull();
  });

  it('shows every row it is given when the section filters on the server', () => {
    renderKit(table());
    expect(names()).toHaveLength(3);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('has loading, error (with Retry) and empty states', () => {
    const onRetry = vi.fn();
    const { rerender } = renderKit(table({ rows: undefined, loading: true }));
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true');

    rerender(
      table({ rows: undefined, error: new ApiRequestError(403, 'FORBIDDEN', 'no'), onRetry }),
    );
    expect(screen.getByText('This list couldn’t be loaded.')).toBeTruthy();
    expect(screen.getByText(/You don't have access to this/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();

    rerender(table({ rows: [] }));
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    rerender(
      table({ rows: [ROWS[2]!], onShowArchivedChange: vi.fn(), empty: { title: 'No categories' } }),
    );
    expect(screen.getByText('No categories')).toBeTruthy();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
  });

  it('reorders active rows with Move up / Move down and reports one new order', () => {
    const onReorder = vi.fn();
    renderKit(table({ reorder: { onReorder }, showArchived: true, onShowArchivedChange: vi.fn() }));
    const up = screen.getByRole('button', { name: 'Move Network up' });
    act(() => up.focus());
    fireEvent.click(up);
    expect(onReorder).toHaveBeenCalledWith(['c2', 'c1'], ['c1', 'c2']);
    // (the first cell of a reorderable row is the grip)
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')[1]?.textContent).toBe(
      'Network',
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Network down' }));
    expect(screen.getByRole('status').textContent).toBe('Network moved to position 1 of 2.');
    // Archived rows are listed after the active ones and can't be moved.
    expect(screen.queryByRole('button', { name: /Move Legacy PBX/ })).toBeNull();
  });

  it('keeps the row click target keyboard-focusable with a forced-colours-safe ring', () => {
    renderKit(table({ onRowClick: vi.fn() }));
    const open = screen.getByRole('button', { name: 'Cybersecurity / SOC' });
    expect(open.className).toContain('focus-visible:outline-hidden');
    const row = open.closest('[role="row"]')!;
    expect(row.className).toContain('has-[[data-row-open]:focus-visible]:ring-2');
    expect(row.className).toContain('has-[[data-row-open]:focus-visible]:outline-hidden');
  });

  it('moves focus to the row in its place when the focused row disappears', () => {
    const rows: Row[] = [
      { id: 'a', name: 'Access control', team: 'ELV', isActive: true },
      { id: 'b', name: 'Building systems', team: 'BMS', isActive: true },
      { id: 'c', name: 'CCTV', team: 'ELV', isActive: true },
    ];
    const { rerender } = renderKit(table({ rows, onRowClick: vi.fn() }));
    const grid = screen.getByRole('table', { name: 'Categories' });
    act(() => within(grid).getByRole('button', { name: 'Building systems' }).focus());
    // The row is archived and hidden (or removed): focus goes to the next row, not the page.
    rerender(table({ rows: [rows[0]!, rows[2]!], onRowClick: vi.fn() }));
    expect(document.activeElement).toBe(within(grid).getByRole('button', { name: 'CCTV' }));
    // The last row goes: the row before it.
    rerender(table({ rows: [rows[0]!], onRowClick: vi.fn() }));
    expect(document.activeElement).toBe(
      within(grid).getByRole('button', { name: 'Access control' }),
    );
    // No rows left: the table itself (named, so screen readers say where focus is).
    rerender(table({ rows: [], onRowClick: vi.fn() }));
    expect(document.activeElement).toBe(grid);
    // Rows that stay leave focus alone.
    rerender(table({ rows, onRowClick: vi.fn() }));
    const other = within(grid).getByRole('button', { name: 'Access control' });
    act(() => other.focus());
    rerender(table({ rows: [...rows].reverse(), onRowClick: vi.fn() }));
    expect(document.activeElement).toBe(other);
  });
});
