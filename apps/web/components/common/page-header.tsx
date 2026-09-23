import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: React.ReactNode;
  /** Muted line under the title. */
  description?: React.ReactNode;
  /** Right-aligned (inline-end) actions or controls, e.g. tabs or a primary button. */
  actions?: React.ReactNode;
  className?: string;
  descriptionClassName?: string;
}

/** 26px semibold page title with a muted subtitle (design: My tickets, Team queue, Reports…). */
export function PageHeader({ title, description, actions, className, descriptionClassName }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-[26px] leading-tight font-semibold text-ink">{title}</h1>
        {description ? <div className={cn('text-ink-muted', descriptionClassName)}>{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
