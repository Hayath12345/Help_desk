'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NewTicketButtonProps {
  className?: string;
  size?: 'default' | 'sm' | 'lg';
  /** Collapse to an icon-only button below the `sm` breakpoint (top bars on phones). */
  compact?: boolean;
}

/**
 * Primary "+ New ticket" action. The New ticket modal ships in Phase 2; until then the button
 * explains that instead of doing nothing. Every entry point uses this component, so Phase 2
 * only swaps the click handler here.
 */
export function NewTicketButton({ className, size = 'default', compact = false }: NewTicketButtonProps) {
  const t = useTranslations('common');
  const label = t('newTicket');

  return (
    <Button
      type="button"
      size={size}
      onClick={() => toast(t('newTicketSoon'))}
      className={cn(compact && 'max-sm:size-9 max-sm:px-0', className)}
    >
      <Plus aria-hidden="true" strokeWidth={2.5} />
      <span className={cn(compact && 'max-sm:sr-only')}>{label}</span>
    </Button>
  );
}
