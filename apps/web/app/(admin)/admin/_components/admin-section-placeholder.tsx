import type { AdminSection } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { ADMIN_SECTION_ICONS } from '@/components/shell/admin-sections';
import { Card } from '@/components/ui/card';

/** Section header + "arrives in Phase 4" placeholder (the section editors replace the card). */
export function AdminSectionPlaceholder({ section }: { section: AdminSection }) {
  const t = useTranslations('admin');
  const Icon = ADMIN_SECTION_ICONS[section];

  return (
    <>
      <PageHeader
        title={t(`sections.${section}.title`)}
        description={t(`sections.${section}.description`)}
        descriptionClassName="text-[15px] text-ink-secondary"
      />
      <Card className="py-0">
        <EmptyState icon={<Icon />} title={t('placeholderTitle')} description={t('placeholder')} />
      </Card>
    </>
  );
}
