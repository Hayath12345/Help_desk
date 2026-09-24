import { cn } from '@/lib/utils';

export interface KickerProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'div' | 'span' | 'p' | 'h2' | 'h3';
}

/**
 * Mono uppercase section label ("VIEWS", "STATUS", "REQUESTER"). Arabic has no case and Geist Mono
 * has no Arabic glyphs, so in RTL it switches to the sans stack at 12px without letter-spacing.
 */
export function Kicker({ as: Comp = 'div', className, ...props }: KickerProps) {
  return (
    <Comp
      className={cn('kicker rtl:font-sans rtl:text-xs rtl:tracking-normal', className)}
      {...props}
    />
  );
}
