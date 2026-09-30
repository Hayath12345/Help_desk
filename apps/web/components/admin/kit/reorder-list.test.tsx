// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderKit, stubBrowserApis } from './kit-test-utils';
import { ReorderList, type ReorderHandler } from './reorder';

beforeAll(stubBrowserApis);
afterEach(cleanup);

interface Item {
  id: string;
  name: string;
}
const ITEMS: Item[] = [
  { id: 'a', name: 'Camera offline' },
  { id: 'b', name: 'NVR failure' },
  { id: 'c', name: 'PTZ fault' },
];

function Harness({ onReorder, items = ITEMS }: { onReorder: ReorderHandler; items?: Item[] }) {
  return (
    <ReorderList
      label="Sub-types"
      items={items}
      getId={(item) => item.id}
      getLabel={(item) => item.name}
      onReorder={onReorder}
      renderItem={(item) => <span data-testid="name">{item.name}</span>}
    />
  );
}

const names = () => screen.getAllByTestId('name').map((el) => el.textContent);
const button = (name: string) => screen.getByRole('button', { name });

describe('ReorderList (E3)', () => {
  it('moves a row down with the keyboard buttons: one request, announced, focus kept', () => {
    const onReorder = vi.fn();
    renderKit(<Harness onReorder={onReorder} />);
    expect(screen.getByRole('list', { name: 'Sub-types' })).toBeTruthy();
    const down = button('Move Camera offline down');
    act(() => down.focus());
    fireEvent.click(down);

    expect(names()).toEqual(['NVR failure', 'Camera offline', 'PTZ fault']);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c'], ['a', 'b', 'c']);
    expect(screen.getByRole('status').textContent).toBe('Camera offline moved to position 2 of 3.');
    expect(document.activeElement).toBe(button('Move Camera offline down'));
  });

  it('moves up, and hands focus to the other button at the ends', () => {
    const onReorder = vi.fn();
    renderKit(<Harness onReorder={onReorder} />);
    const up = button('Move PTZ fault up');
    act(() => up.focus());
    fireEvent.click(up);
    fireEvent.click(button('Move PTZ fault up'));
    expect(names()).toEqual(['PTZ fault', 'Camera offline', 'NVR failure']);
    expect(onReorder).toHaveBeenLastCalledWith(['c', 'a', 'b'], ['a', 'c', 'b']);
    // At the top "Move up" is unavailable, so focus moved to "Move down".
    expect(document.activeElement).toBe(button('Move PTZ fault down'));
    expect(screen.getByRole('status').textContent).toBe('PTZ fault moved to position 1 of 3.');
  });

  it('keeps unavailable moves focusable but inert', () => {
    const onReorder = vi.fn();
    renderKit(<Harness onReorder={onReorder} />);
    const up = button('Move Camera offline up');
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(up.hasAttribute('disabled')).toBe(false);
    fireEvent.click(up);
    fireEvent.click(button('Move PTZ fault down'));
    expect(onReorder).not.toHaveBeenCalled();
    expect(names()).toEqual(['Camera offline', 'NVR failure', 'PTZ fault']);
  });

  it('follows a new order from the server (another admin reordered)', () => {
    function Live() {
      const [items, setItems] = useState(ITEMS);
      return (
        <>
          <button type="button" onClick={() => setItems([ITEMS[2]!, ITEMS[0]!, ITEMS[1]!])}>
            refetch
          </button>
          <Harness onReorder={vi.fn()} items={items} />
        </>
      );
    }
    renderKit(<Live />);
    fireEvent.click(button('refetch'));
    expect(names()).toEqual(['PTZ fault', 'Camera offline', 'NVR failure']);
  });

  it('a refused move snaps back and the live region says so', () => {
    function Refused() {
      const [items, setItems] = useState(ITEMS);
      const [serverOrder, setServerOrder] = useState(ITEMS);
      return (
        <>
          {/* The optimistic cache update, then its rollback when the API answers 409. */}
          <button type="button" onClick={() => setItems(serverOrder)}>
            rollback
          </button>
          <Harness
            items={items}
            onReorder={(ids) => {
              setServerOrder(items);
              setItems(ids.map((id) => ITEMS.find((i) => i.id === id)!));
            }}
          />
        </>
      );
    }
    renderKit(<Refused />);
    fireEvent.click(button('Move Camera offline down'));
    expect(screen.getByRole('status').textContent).toBe('Camera offline moved to position 2 of 3.');
    fireEvent.click(button('rollback'));
    expect(names()).toEqual(['Camera offline', 'NVR failure', 'PTZ fault']);
    expect(screen.getByRole('status').textContent).toBe(
      'The new order wasn’t saved. Camera offline is back at position 1 of 3.',
    );
  });

  it('a list without an optimistic cache goes back when the save is refused', async () => {
    renderKit(<Harness onReorder={() => Promise.reject(new Error('409 order_changed'))} />);
    fireEvent.click(button('Move Camera offline down'));
    expect(names()).toEqual(['NVR failure', 'Camera offline', 'PTZ fault']);
    await waitFor(() => expect(names()).toEqual(['Camera offline', 'NVR failure', 'PTZ fault']));
    expect(screen.getByRole('status').textContent).toBe(
      'The new order wasn’t saved. Camera offline is back at position 1 of 3.',
    );
  });

  it('hides the drag grip from assistive tech and speaks Arabic', () => {
    renderKit(<Harness onReorder={vi.fn()} />, { locale: 'ar' });
    const list = screen.getByRole('list');
    for (const grip of list.querySelectorAll('[data-slot="drag-handle"]')) {
      expect(grip.getAttribute('aria-hidden')).toBe('true');
    }
    fireEvent.click(within(list).getByRole('button', { name: 'نقل Camera offline إلى الأسفل' }));
    expect(screen.getByRole('status').textContent).toBe('نُقل Camera offline إلى الموضع 2 من 3.');
  });
});
