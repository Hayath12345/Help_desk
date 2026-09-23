import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface LogoProps {
  className?: string;
  /** Muted text after the wordmark, e.g. the portal's "Support". */
  suffix?: React.ReactNode;
  /** `md`: 22px mark + 16px text (top bars). `lg`: 24px mark + 18px text (auth screens). */
  size?: 'md' | 'lg';
  /** Top bars on small screens: suffix hidden below `md`, wordmark visually hidden below `sm`. */
  compact?: boolean;
}

/** Black rounded square + "Loons Help Desk" wordmark (the wordmark stays in Latin script, as in the design). */
export function Logo({ className, suffix, size = 'md', compact = false }: LogoProps) {
  const t = useTranslations('common');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2.5 font-semibold whitespace-nowrap text-ink',
        size === 'lg' ? 'text-lg' : 'text-base',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('inline-block shrink-0 rounded-sm bg-ink', size === 'lg' ? 'size-6' : 'size-[22px]')}
      />
      <span dir="ltr" className={cn(compact && 'max-sm:sr-only')}>
        {t('brand')}
      </span>
      {suffix ? (
        <span className={cn('font-normal text-ink-subtle', compact && 'max-md:hidden')}>{suffix}</span>
      ) : null}
    </span>
  );
}
