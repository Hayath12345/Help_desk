import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary call to action, e.g. the "+ New ticket" button. */
  action?: React.ReactNode;
  /** Optional lucide icon shown in a neutral circle above the title. */
  icon?: React.ReactNode;
  /** Heading level for the title (default h2). */
  headingLevel?: 'h2' | 'h3' | 'p';
  className?: string;
}

/** Centered empty state (design: 48px 20px padding, 16px semibold title, muted description). */
export function EmptyState({
  title,
  description,
  action,
  icon,
  headingLevel: Heading = 'h2',
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2.5 px-5 py-12 text-center', className)}>
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-1 grid size-10 place-items-center rounded-full bg-surface-sunken text-ink-muted [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <Heading className="text-base font-semibold text-ink">{title}</Heading>
      {description ? <p className="max-w-md text-balance text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
