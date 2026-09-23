// Motion presets (spec §1): 150–250 ms, ease-out. Reduced motion is handled globally by
// <MotionConfig reducedMotion="user"> in AppProviders (transforms/layout off, opacity kept).
//
// Horizontal slides take the text direction so they mirror in RTL: "inline-end" is the right
// edge in LTR and the left edge in RTL.

import type { Transition, Variants } from 'motion/react';
import { motion as tokens } from '@loons/ui';

type Dir = 'ltr' | 'rtl';

export const transitions = {
  fast: { duration: tokens.durationFast, ease: tokens.ease },
  base: { duration: tokens.duration, ease: tokens.ease },
  slow: { duration: tokens.durationSlow, ease: tokens.ease },
  /** For `layout` reorders in lists. */
  layout: { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 },
} satisfies Record<string, Transition>;

/** Modal / dialog: scale + fade in. */
export const modalVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transitions.base },
  exit: { opacity: 0, scale: 0.98, transition: transitions.fast },
};

export const overlayVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transitions.base },
  exit: { opacity: 0, transition: transitions.fast },
};

/** Side sheet that slides in from the inline-end edge. */
export function sheetVariants(dir: Dir): Variants {
  const offset = dir === 'rtl' ? '-100%' : '100%';
  return {
    hidden: { x: offset },
    visible: { x: 0, transition: transitions.slow },
    exit: { x: offset, transition: transitions.base },
  };
}

/** List rows (queue, my tickets): fade/slide in, fade out; pair with `layout` for reorders. */
export const listItemVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transitions.base },
  exit: { opacity: 0, transition: transitions.fast },
};

/** New chat message: slides in from the author's side. */
export function messageVariants(dir: Dir, fromInlineEnd = false): Variants {
  const sign = (dir === 'rtl' ? -1 : 1) * (fromInlineEnd ? 1 : -1);
  return {
    hidden: { opacity: 0, x: 12 * sign },
    visible: { opacity: 1, x: 0, transition: transitions.base },
  };
}

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transitions.base },
  exit: { opacity: 0, transition: transitions.fast },
};
