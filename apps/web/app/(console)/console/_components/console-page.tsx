import { Kicker } from '@/components/common/kicker';
import { cn } from '@/lib/utils';

/** Body of the non-inbox console pages (design: #fafafa background, 32px 36px padding, 22px gap). */
export function ConsolePage({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-1 flex-col gap-[22px] bg-surface-muted px-4 py-8 sm:px-9',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Header row of a grid "table" (design: mono 11px uppercase column labels, 12px vertical padding,
 * divider underneath). `columns` is a Tailwind grid-template class shared with the body rows.
 */
export function GridTableHeader({
  columns,
  labels,
  className,
}: {
  columns: string;
  labels: readonly React.ReactNode[];
  className?: string;
}) {
  return (
    <div
      className={cn('grid items-center gap-2.5 border-b border-divider py-3', columns, className)}
    >
      {labels.map((label, i) => (
        <Kicker as="span" key={i} className="truncate">
          {label}
        </Kicker>
      ))}
    </div>
  );
}
