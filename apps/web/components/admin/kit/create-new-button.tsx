'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CreateNewButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  'children' | 'variant' | 'size'
> {
  /** Default "Create new". */
  label?: React.ReactNode;
}

/** The section's primary action, top-right of the page header (E1, the owner's reference). */
export function CreateNewButton({ label, className, ...props }: CreateNewButtonProps) {
  const t = useTranslations('admin.kit');
  return (
    <Button type="button" size="lg" className={cn('text-[15px]', className)} {...props}>
      <Plus aria-hidden="true" />
      {label ?? t('createNew')}
    </Button>
  );
}
