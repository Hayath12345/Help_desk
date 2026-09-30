import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/** Built-in audiences; pass `children` for anything else. */
export type WhoCanSeeAudience = 'superAdmins' | 'teamLeads';

export interface WhoCanSeeNoteProps {
  audience?: WhoCanSeeAudience;
  /** Custom text (already translated); replaces the audience's sentence. */
  children?: React.ReactNode;
  className?: string;
}

/** The short "Who can see this" line under a restricted section's table (E1). */
export function WhoCanSeeNote({
  audience = 'superAdmins',
  children,
  className,
}: WhoCanSeeNoteProps) {
  const t = useTranslations('admin.kit.whoCanSee');
  return (
    <p
      className={cn('flex items-start gap-2 text-[13px] leading-normal text-ink-muted', className)}
    >
      <Eye aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium text-ink-secondary">{t('label')}</span>{' '}
        {children ?? t(audience)}
      </span>
    </p>
  );
}
