import { Archive } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** "Archived" pill for rows, sheet titles and pickers that show archived config (E5, E6). */
export function ArchivedBadge({ className }: { className?: string }) {
  const t = useTranslations('admin.kit');
  return (
    <Badge variant="secondary" data-slot="archived-badge" className={cn('shrink-0', className)}>
      <Archive aria-hidden="true" />
      {t('archived')}
    </Badge>
  );
}
