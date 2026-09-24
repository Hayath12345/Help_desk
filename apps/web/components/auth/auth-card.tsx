import { cn } from '@/lib/utils';
import { cardClass } from './styles';

export function AuthCard({ className, ...props }: React.ComponentProps<'section'>) {
  return <section className={cn(cardClass, className)} {...props} />;
}

export function AuthCardHeader({
  title,
  subtitle,
  titleId,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  titleId?: string;
}) {
  return (
    <header className="flex flex-col gap-1">
      {/* No leading-* override: the design's `line-height: normal` (globals.css) gives the 28px title. */}
      <h1 id={titleId} className="text-[22px] font-semibold text-ink">
        {title}
      </h1>
      {subtitle ? <p className="leading-normal text-ink-muted">{subtitle}</p> : null}
    </header>
  );
}
