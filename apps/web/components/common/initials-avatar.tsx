import { cn } from '@/lib/utils';

const VARIANTS = {
  /** Staff avatars and the account menu button. */
  'brand-soft': 'bg-brand-soft text-brand-ink',
  /** Neutral: requesters, customers, assignee chips. */
  track: 'bg-track text-ink-secondary',
  /** Internal-note author. */
  note: 'bg-note-tag text-note-ink',
} as const;

const SIZES = {
  xs: 'size-[22px] text-[9px]', // assignee chip in list rows
  sm: 'size-[30px] text-[11px]', // customers table
  md: 'size-8 text-[11px]', // thread messages, agent cards
  lg: 'size-[34px] text-xs', // top-bar account button
  xl: 'size-[38px] text-xs', // requester card
} as const;

export interface InitialsAvatarProps {
  initials: string;
  /** Full name: becomes the accessible label. Omit when the name is shown next to the avatar. */
  name?: string;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  className?: string;
}

export function InitialsAvatar({
  initials,
  name,
  variant = 'brand-soft',
  size = 'md',
  className,
}: InitialsAvatarProps) {
  return (
    <span
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      title={name}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full leading-none font-semibold select-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      <span aria-hidden="true">{initials}</span>
    </span>
  );
}
