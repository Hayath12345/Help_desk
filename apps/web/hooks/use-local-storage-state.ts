'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Per-key subscribers so every component reading the same key re-renders on writes in this tab;
// the `storage` event covers writes from other tabs. `memory` keeps the latest in-tab value so the
// UI still works when localStorage is unavailable (privacy mode, quota, disabled storage).
const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, string | null>();

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * String-valued state persisted in localStorage.
 *
 * Hydration-safe: the server snapshot (and the hydrating client render) uses `fallback`; the
 * stored value is applied right after hydration by useSyncExternalStore.
 *
 * @param isValid narrows stored strings; anything else falls back to `fallback`.
 */
export function useLocalStorageState<T extends string>(
  key: string,
  fallback: T,
  isValid: (value: string) => value is T,
): [T, (next: T) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key) return;
        memory.set(key, event.newValue);
        onChange();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        set.delete(onChange);
        window.removeEventListener('storage', onStorage);
      };
    },
    [key],
  );

  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );

  const value = raw !== null && isValid(raw) ? raw : fallback;

  const setValue = useCallback(
    (next: T) => {
      memory.set(key, next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Not persisted; the in-memory value still drives the UI for this tab.
      }
      notify(key);
    },
    [key],
  );

  return [value, setValue];
}
