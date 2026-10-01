// Shared layout classes of the Team queue table (the live table and its skeleton must match, so
// nothing jumps when the data arrives).

/**
 * Design 943 / 947: checkbox · priority · ticket · requester · first-reply SLA · assignee ·
 * status, 10px gaps. From `md` the rows are this grid (the card scrolls sideways below 980 px);
 * below `md` (phones) each row is a stacked, wrapping card.
 */
export const QUEUE_GRID =
  'md:grid md:grid-cols-[52px_120px_minmax(0,1fr)_190px_190px_140px_100px] md:gap-2.5';

/** Row box: stacked on phones, the design's 12px 16px 12px 18px grid row from `md`. */
export const QUEUE_ROW =
  'relative flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-divider px-4 py-3.5 last:border-b-0 md:py-3 md:ps-[18px] md:pe-4';

/** The table card (design: white, 1px line, 12px radius, horizontal scroll inside). */
export const QUEUE_CARD = 'overflow-x-auto rounded-xl border border-line bg-surface';

/** The table's width from `md` (design `min-width: 980px`). */
export const QUEUE_TABLE_WIDTH = 'md:min-w-[980px]';

/** Agent cards grid (design 902: `repeat(auto-fit, minmax(220px, 1fr))`, 14px gap). */
export const AGENT_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5';
