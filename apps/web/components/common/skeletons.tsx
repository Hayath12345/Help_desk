import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Skeleton helpers that mimic the real layouts, so content doesn't jump when data arrives.
// All are server-compatible (no hooks). Skeleton elements are aria-hidden; wrap a loading area
// in <LoadingRegion label=…> so assistive tech hears one "Loading…" message instead.

/** Deterministic width variety for text lines (stable between server and client renders). */
const LINE_WIDTHS = ['w-3/5', 'w-4/5', 'w-2/3', 'w-1/2', 'w-3/4', 'w-5/6', 'w-7/12'] as const;
const SHORT_WIDTHS = ['w-24', 'w-32', 'w-28', 'w-36', 'w-20', 'w-40'] as const;

export function lineWidth(index: number): string {
  return LINE_WIDTHS[index % LINE_WIDTHS.length] ?? 'w-2/3';
}

export function shortWidth(index: number): string {
  return SHORT_WIDTHS[index % SHORT_WIDTHS.length] ?? 'w-28';
}

export interface LoadingRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Announced once to screen readers, e.g. t('common.loading'). */
  label: string;
}

export function LoadingRegion({ label, children, ...props }: LoadingRegionProps) {
  return (
    <div aria-busy="true" {...props}>
      <span role="status" className="sr-only">
        {label}
      </span>
      {children}
    </div>
  );
}

export function SkeletonText({ className }: { className?: string }) {
  return <Skeleton className={cn('h-3 rounded-sm', className)} />;
}

/** Generic stacked rows (settings lists, simple tables). */
export function SkeletonRows({
  rows = 5,
  className,
  rowClassName,
}: {
  rows?: number;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cn('flex items-center gap-3 border-b border-divider px-5 py-4 last:border-b-0', rowClassName)}
        >
          <SkeletonText className={cn('h-3.5', lineWidth(i))} />
        </div>
      ))}
    </div>
  );
}

/**
 * Console inbox row (design 747–761): priority dot, requester · company, SLA timer;
 * subject; ticket id, status pill, assignee avatar.
 */
export function TicketListRowSkeleton({ index = 0, className }: { index?: number; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-b border-s-[3px] border-divider border-s-transparent py-3.5 ps-[17px] pe-[18px]',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Skeleton className="size-[7px] shrink-0 rounded-full" />
        <SkeletonText className={shortWidth(index)} />
        <span className="flex-1" />
        <SkeletonText className="w-10" />
      </div>
      <SkeletonText className={cn('h-4', lineWidth(index + 1))} />
      <div className="flex items-center gap-2">
        <SkeletonText className="w-14" />
        <Skeleton className="h-[18px] w-12 rounded-sm" />
        <span className="flex-1" />
        <Skeleton className="size-[22px] shrink-0 rounded-full" />
      </div>
    </div>
  );
}

/** Client portal "My tickets" row (design 588–596): subject + id/category/preview, status, updated. */
export function PortalTicketRowSkeleton({ index = 0, className }: { index?: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-4 border-b border-divider px-5 py-4 last:border-b-0', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <SkeletonText className={cn('h-4', lineWidth(index))} />
        <div className="flex items-center gap-2">
          <SkeletonText className="w-28" />
          <SkeletonText className={cn('max-w-72 flex-1')} />
        </div>
      </div>
      <Skeleton className="h-5 w-14 shrink-0 rounded-sm" />
      <SkeletonText className="hidden w-14 shrink-0 sm:block" />
    </div>
  );
}
