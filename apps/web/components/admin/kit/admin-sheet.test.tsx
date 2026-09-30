// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Input } from '@/components/ui/input';
import { AdminSheet, type AdminSheetProps } from './admin-sheet';
import { AdminTable } from './admin-table';
import { renderKit, stubBrowserApis } from './kit-test-utils';

beforeAll(stubBrowserApis);
afterEach(cleanup);

type HarnessProps = Partial<Omit<AdminSheetProps, 'open' | 'onOpenChange' | 'children'>> & {
  onOpenChange?: (open: boolean) => void;
  onSubmit?: () => void;
};

/** A row button that opens the sheet (focus must come back to it) and a two-field form. */
function Harness({ onOpenChange, onSubmit, ...props }: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Cybersecurity
      </button>
      <AdminSheet
        mode="edit"
        title="Cybersecurity / SOC"
        itemLabel="Cybersecurity / SOC"
        formId="category-form"
        {...props}
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
      >
        <form
          id="category-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.();
          }}
        >
          <label htmlFor="name">Name</label>
          <Input id="name" defaultValue="Cybersecurity / SOC" />
          <label htmlFor="placeholder">Asset placeholder</label>
          <Input id="placeholder" defaultValue="e.g. FW-01" />
        </form>
      </AdminSheet>
    </>
  );
}

/** Whether the current history entry is an AdminSheet's Back-guard sentinel. */
function guardEntry(): boolean {
  const state = window.history.state as Record<string, unknown> | null;
  return typeof state?.__adminSheetGuard === 'string';
}

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Open Cybersecurity' }));
  return screen.getByRole('dialog', { name: 'Cybersecurity / SOC' });
}

/** A table whose rows open the sheet; Archive removes the row (as with "Show archived" off). */
function TableHarness() {
  const [rows, setRows] = useState(['Access control', 'Building systems', 'CCTV']);
  const [openRow, setOpenRow] = useState<string | null>(null);
  return (
    <>
      <AdminTable<string>
        label="Categories"
        columns={[{ id: 'name', header: 'Name', cell: (r) => r }]}
        rows={rows}
        getRowId={(r) => r}
        getRowLabel={(r) => r}
        onRowClick={setOpenRow}
      />
      <AdminSheet
        mode="edit"
        title={openRow ?? ''}
        itemLabel={openRow ?? ''}
        open={openRow !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRow(null);
        }}
        onArchive={() => {
          setRows((current) => current.filter((r) => r !== openRow));
          setOpenRow(null);
        }}
      >
        <p>Details</p>
      </AdminSheet>
    </>
  );
}

describe('AdminSheet', () => {
  it('after archiving, focus goes to the row now in the archived row’s place', async () => {
    renderKit(<TableHarness />);
    const grid = screen.getByRole('table', { name: 'Categories' });
    const opener = within(grid).getByRole('button', { name: 'Building systems' });
    act(() => opener.focus());
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Building systems' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(within(grid).getByRole('button', { name: 'CCTV' })),
    );
  });

  it('opens as a labelled dialog, moves focus inside and traps Tab', async () => {
    renderKit(<Harness />);
    const sheet = open();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(within(sheet).getByLabelText('Name'));

    // Tab from the last control wraps to the first one (focus stays in the sheet).
    const tabbables = [...sheet.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
    const last = tabbables[tabbables.length - 1]!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });

  it('closes on Escape when nothing changed and returns focus to the row', async () => {
    const onOpenChange = vi.fn();
    renderKit(<Harness onOpenChange={onOpenChange} />);
    const opener = screen.getByRole('button', { name: 'Open Cybersecurity' });
    act(() => opener.focus());
    const sheet = open();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('asks before discarding unsaved changes (Escape, Cancel, ×)', async () => {
    const onOpenChange = vi.fn();
    renderKit(<Harness dirty onOpenChange={onOpenChange} />);
    const sheet = open();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard your changes?' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The safe choice has focus; it keeps the sheet (and the edits) open.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole('button', { name: 'Keep editing' }),
      ),
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Cybersecurity / SOC' })).toBeTruthy();
    // Back where the admin was (Escape was pressed in the Name field).
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByLabelText('Name')));

    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard changes',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    // The × button asks too.
    const again = open();
    fireEvent.click(within(again).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard your changes?' })).toBeTruthy();
  });

  it('asks before browser Back (a client-side navigation) discards unsaved changes', async () => {
    const onOpenChange = vi.fn();
    // The navigation itself is the browser's business; only check it is asked for.
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    window.history.replaceState(null, '');
    try {
      const { unmount } = renderKit(<Harness dirty onOpenChange={onOpenChange} />);
      const sheet = open();
      await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
      // A sentinel entry sits on top while the sheet is dirty.
      expect(guardEntry()).toBe(true);

      act(() => window.history.back());
      const confirm = await screen.findByRole('alertdialog', { name: 'Discard your changes?' });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(sheet.isConnected).toBe(true);
      fireEvent.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.getByRole('dialog', { name: 'Cybersecurity / SOC' })).toBeTruthy();
      expect(guardEntry()).toBe(true);

      // Back again, and this time discard: the sheet closes and the navigation goes ahead
      // (past the sentinel).
      act(() => window.history.back());
      fireEvent.click(
        within(await screen.findByRole('alertdialog', { name: 'Discard your changes?' })).getByRole(
          'button',
          { name: 'Discard changes' },
        ),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      await waitFor(() => expect(go).toHaveBeenCalledWith(-2));
      unmount();
    } finally {
      go.mockRestore();
    }
  });

  it('adds no history entry while nothing changed, and drops it once clean again', async () => {
    window.history.replaceState(null, '');
    const { rerender, unmount } = renderKit(<Harness />);
    const sheet = open();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    expect(guardEntry()).toBe(false);
    rerender(<Harness dirty />);
    await waitFor(() => expect(guardEntry()).toBe(true));
    rerender(<Harness />);
    await waitFor(() => expect(guardEntry()).toBe(false));
    // That pop was not a Back press: no question.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    unmount();
  });

  it('read-only: the footer is a single Close button, with no unsaved-changes question', async () => {
    const onOpenChange = vi.fn();
    renderKit(
      <Harness readOnly dirty onOpenChange={onOpenChange} onArchive={vi.fn()} onSubmit={vi.fn()} />,
    );
    const sheet = open();
    const footer = sheet.querySelector<HTMLElement>('[data-slot="sheet-footer"]')!;
    expect(
      within(footer)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Close']);
    fireEvent.click(within(footer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('submits its form with Save, and says Create in create mode', async () => {
    const onSubmit = vi.fn();
    const { unmount } = renderKit(<Harness onSubmit={onSubmit} />);
    const sheet = open();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount();

    renderKit(<Harness mode="create" saving />);
    const created = open();
    const button = within(created).getByRole('button', { name: 'Creating…' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    // No archive / restore while creating.
    expect(within(created).queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('shows the 409 "Someone else changed this — reload" state and blocks Save', async () => {
    const onSubmit = vi.fn();
    const onReload = vi.fn();
    renderKit(<Harness conflict onReload={onReload} onSubmit={onSubmit} />);
    const sheet = open();
    const alert = within(sheet).getByRole('alert');
    expect(alert.textContent).toContain('Someone else changed this — reload');
    const save = within(sheet).getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('archives after a confirmation that names the row', async () => {
    const onArchive = vi.fn();
    renderKit(<Harness onArchive={onArchive} />);
    const sheet = open();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Archive Cybersecurity / SOC?',
    });
    expect(confirm.textContent).toContain('old tickets keep showing it');
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('marks an archived row and offers Restore instead of Archive', () => {
    const onRestore = vi.fn();
    renderKit(<Harness archived onRestore={onRestore} onArchive={vi.fn()} />);
    const sheet = open();
    expect(within(sheet).getByText('Archived')).toBeTruthy();
    expect(within(sheet).getByRole('note').textContent).toContain('This item is archived');
    expect(within(sheet).queryByRole('button', { name: 'Archive' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('is 640 px wide from the inline-end edge (full width on phones), in Arabic too', () => {
    renderKit(<Harness />, { locale: 'ar' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Cybersecurity' }));
    const sheet = screen.getByRole('dialog');
    expect(sheet.getAttribute('data-side')).toBe('end');
    expect(sheet.className).toContain('data-[side=end]:w-full');
    expect(sheet.className).toContain('data-[side=end]:sm:max-w-[640px]');
    expect(within(sheet).getByRole('button', { name: 'حفظ' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'إلغاء' })).toBeTruthy();
  });
});
