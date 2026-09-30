'use client';

// Browser Back (and Alt+Left, the mouse's back button) is a client-side history traversal in the
// App Router: `beforeunload` does not fire, the section remounts and a sheet's unsaved edits are
// gone. While `active`, a sentinel history entry (same URL, Next's own state copied by its
// pushState patch) sits on top: Back only pops the sentinel, which is put back while `onBack`
// asks. `leave()` then completes the navigation the user asked for.

import { useEffect, useId, useRef } from 'react';

const GUARD_KEY = '__adminSheetGuard';

function currentGuard(): unknown {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>)[GUARD_KEY] : null;
}

export function useBackGuard(active: boolean, onBack: () => void): { leave: () => void } {
  const guard = useId();
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  // Set while the guard is on (a cleanup re-armed at once — StrictMode, a dirty flag that flickers
  // — keeps the sentinel), and while leaving (the sentinel goes with the navigation).
  const armed = useRef(false);
  const leaving = useRef(false);
  // Our own history.back() of the sentinel: its popstate is not a Back press.
  const popping = useRef(false);

  useEffect(() => {
    if (!active) return;
    const push = () => window.history.pushState({ [GUARD_KEY]: guard }, '');
    armed.current = true;
    leaving.current = false;
    if (currentGuard() !== guard) push();
    const onPopState = () => {
      if (popping.current || leaving.current || currentGuard() === guard) return;
      push();
      onBackRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      armed.current = false;
      setTimeout(() => {
        // Still on the sentinel and nothing needs it (closed, saved, clean again): drop it, so the
        // next Back is not a dead press. Not when another entry was pushed on top of it.
        if (armed.current || leaving.current || currentGuard() !== guard) return;
        popping.current = true;
        const settled = () =>
          setTimeout(() => {
            popping.current = false;
          });
        window.addEventListener('popstate', settled, { once: true });
        window.history.back();
      });
    };
  }, [active, guard]);

  return {
    leave: () => {
      leaving.current = true;
      // After the sheet closed (its `beforeunload` guard is gone): skip the sentinel and go back.
      setTimeout(() => window.history.go(currentGuard() === guard ? -2 : -1));
    },
  };
}
