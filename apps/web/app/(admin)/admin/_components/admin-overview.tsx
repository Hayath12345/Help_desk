import type { Role } from '@loons/shared';
import { ArrowRight } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { PageHeader } from '@/components/common/page-header';
import { ADMIN_SECTION_ICONS, allowedAdminGroups } from '@/components/shell/admin-sections';

/**
 * Admin overview body: the sections this role may open, under the navigation's group headings
 * (E8). Team leads see Teams & members and Macros only.
 */
export function AdminOverview({ role }: { role: Role }) {
  const t = useTranslations('admin');
  const groups = allowedAdminGroups(role);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={role === 'TEAM_LEAD' ? t('teamLeadSubtitle') : t('subtitle')}
        descriptionClassName="text-[15px] text-ink-secondary"
      />
      {groups.map((group) => {
        const headingId = `admin-overview-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={headingId} className="flex flex-col gap-3">
            <Kicker as="h2" id={headingId}>
              {t(`groups.${group.id}`)}
            </Kicker>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
              {group.sections.map((section) => {
                const Icon = ADMIN_SECTION_ICONS[section];
                return (
                  <li key={section}>
                    <Link
                      href={`/admin/${section}` as Route}
                      className="group flex h-full flex-col gap-3 rounded-xl border border-line bg-surface p-[18px] text-ink no-underline transition-colors duration-150 ease-out hover:border-brand-border hover:text-ink"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="grid size-9 place-items-center rounded-lg bg-brand-tint text-brand-ink">
                          <Icon aria-hidden="true" className="size-[18px]" />
                        </span>
                        <ArrowRight
                          aria-hidden="true"
                          className="size-4 text-ink-subtle transition-[translate,color] duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-brand rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                        />
                      </span>
                      <span className="flex flex-col gap-1">
                        <span className="text-[15px] font-semibold">
                          {t(`sections.${section}.title`)}
                        </span>
                        <span className="text-[13px] leading-snug text-ink-muted">
                          {t(`sections.${section}.description`)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}
