import { formatTicketNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface TicketIdProps {
  /** The sequence number, e.g. 4817 → "LG-4817". */
  number: number;
  className?: string;
}

/** Monospace ticket reference. Isolated as LTR so "LG-4817" never reorders inside Arabic text. */
export function TicketId({ number, className }: TicketIdProps) {
  return (
    <span dir="ltr" className={cn('font-mono text-xs whitespace-nowrap text-ink-muted', className)}>
      {formatTicketNumber(number)}
    </span>
  );
}
