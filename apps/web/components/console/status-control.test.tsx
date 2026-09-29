// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import { StatusControl, type StatusControlOption } from './status-control';

afterEach(cleanup);

type Status = 'NEW' | 'OPEN' | 'PENDING' | 'SOLVED';
const OPTIONS: StatusControlOption<Status>[] = [
  { value: 'NEW', label: 'جديدة' },
  { value: 'OPEN', label: 'مفتوحة' },
  { value: 'PENDING', label: 'قيد الانتظار' },
  { value: 'SOLVED', label: 'تم الحل' },
];

function renderControl(
  props: Partial<React.ComponentProps<typeof StatusControl<Status>>> = {},
  dir: 'ltr' | 'rtl' = 'ltr',
) {
  const onValueChange = vi.fn();
  render(
    <DirectionProvider dir={dir}>
      <span id="status-label">Status</span>
      <StatusControl<Status>
        aria-labelledby="status-label"
        options={OPTIONS}
        value="OPEN"
        onValueChange={onValueChange}
        {...props}
      />
    </DirectionProvider>,
  );
  return { onValueChange, group: screen.getByRole('radiogroup', { name: 'Status' }) };
}

async function press(key: string, expected: string) {
  fireEvent.keyDown(document.activeElement!, { key });
  await waitFor(() => expect(document.activeElement?.textContent).toBe(expected));
  fireEvent.keyUp(document.activeElement!, { key });
}

describe('StatusControl', () => {
  it('is a labelled radiogroup with the current status checked and one tab stop', () => {
    const { group } = renderControl();
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    // Roving focus: the group is the single tab stop and hands focus to the checked status.
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, -1, -1]);
    expect(group.tabIndex).toBe(0);
    act(() => group.focus());
    expect(document.activeElement).toBe(radios[1]);
  });

  it('mirrors the arrow keys in RTL and only moves focus', async () => {
    const { onValueChange, group } = renderControl({}, 'rtl');
    act(() => within(group).getByRole('radio', { name: 'مفتوحة' }).focus());
    await press('ArrowLeft', 'قيد الانتظار');
    await press('ArrowLeft', 'تم الحل');
    await press('ArrowRight', 'قيد الانتظار');
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.click(document.activeElement!);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('PENDING');
  });

  it('skips statuses that can’t be set and never "un-checks" the current one', async () => {
    const { onValueChange, group } = renderControl({
      options: OPTIONS.map((option) => ({ ...option, disabled: option.value === 'NEW' })),
    });
    const open = within(group).getByRole('radio', { name: 'مفتوحة' });
    act(() => open.focus());
    await press('End', 'تم الحل');
    await press('Home', 'مفتوحة');
    fireEvent.click(open);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(open.getAttribute('aria-checked')).toBe('true');
  });

  it('is fully disabled for a closed ticket', () => {
    const { group } = renderControl({ value: '', disabled: true });
    for (const radio of within(group).getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
      expect(radio.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('sizes the segments to their labels so Arabic labels are never clipped', () => {
    // A fixed 4-column minmax(0, 1fr) grid with nowrap labels clipped "قيد الانتظار" in the
    // ~236 px panel. Content-sized flex segments share the spare width, and a multi-word label may
    // wrap inside its segment as a last resort.
    const { group } = renderControl();
    expect(group.className).toContain('flex');
    expect(group.className).not.toMatch(/grid-cols-/);
    for (const radio of within(group).getAllByRole('radio')) {
      expect(radio.className).toContain('flex-auto');
      expect(radio.className).not.toContain('whitespace-nowrap');
      expect(radio.className).not.toContain('min-w-0');
    }
  });
});
