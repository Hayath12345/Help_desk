import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/common/page-header';
import type { AdminSlug } from '@/lib/admin/sections';

export interface AdminSectionHeaderProps {
  section: AdminSlug;
  /** Top-right actions, usually `<CreateNewButton onClick=… />`. */
  actions?: React.ReactNode;
  /** Replaces the section's description from admin.json. */
  description?: React.ReactNode;
}

/** Section title + description from `admin.sections.<slug>`, with the actions at inline-end. */
export function AdminSectionHeader({ section, actions, description }: AdminSectionHeaderProps) {
  const t = useTranslations('admin.sections');
  return (
    <PageHeader
      title={t(`${section}.title`)}
      description={description ?? t(`${section}.description`)}
      descriptionClassName="text-[15px] text-ink-secondary"
      actions={actions}
    />
  );
}
