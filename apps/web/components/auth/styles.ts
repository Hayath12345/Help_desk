// Class lists for the auth screens (design: login block, lines 456–550). Applied on top of the
// shared UI kit components so the screens stay pixel-faithful whatever the kit's defaults are.

/** White card: max 400px, 1px line border, 14px radius, card shadow, 28px padding, 18px gap. */
export const cardClass =
  'flex w-full max-w-[400px] flex-col gap-[18px] rounded-2xl border border-line bg-surface p-7 shadow-card';

/** Text inputs: 10px 12px padding, 8px radius, input border; focus = brand border + 3px tint ring. */
export const inputClass =
  'h-auto rounded-md border-line-input bg-surface px-3 py-2.5 text-sm font-normal text-ink shadow-none placeholder:text-ink-muted md:text-sm focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger-tint';

/** Primary action: brand fill, 11px padding, semibold (dimmed while disabled or pending). */
export const primaryButtonClass =
  'h-auto w-full gap-2 rounded-md border-0 bg-brand p-[11px] text-sm font-semibold text-primary-foreground hover:bg-brand-hover disabled:opacity-80 aria-disabled:opacity-80';

/** Secondary action: white, input border, 10px padding, medium weight. */
export const outlineButtonClass =
  'h-auto w-full gap-2.5 rounded-md border border-line-input bg-surface p-2.5 text-sm font-medium text-ink hover:bg-surface-sunken hover:text-ink disabled:opacity-80 aria-disabled:opacity-80';

/** Inline text link (13px, brand ink). */
export const textLinkClass =
  'text-[13px] font-normal whitespace-nowrap text-brand-ink hover:text-ink';
