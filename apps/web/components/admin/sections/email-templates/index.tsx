'use client';

import { emailTemplateListSchema, type EmailTemplateAdminDto } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { adminListFetcher, useAdminList } from '@/lib/admin';
import { formatDate } from '@/lib/format';
import { AdminSectionHeader, AdminTable, WhoCanSeeNote, type AdminTableColumn } from '../../kit';
import type { AdminSectionProps } from '../types';
import { TemplateSheet } from './template-sheet';

const fetchTemplates = adminListFetcher('email-templates', emailTemplateListSchema);

/**
 * Email templates (spec §10.9; E14): the twelve built-in emails in a plain table (no Create new —
 * the keys are fixed), each opening the template editor with its live preview. Super admins only.
 */
export default function EmailTemplatesSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-comms.emailTemplates');
  const locale = useLocale();
  const list = useAdminList({ section: 'email-templates', queryFn: fetchTemplates });
  // One sheet per opening (`session`), kept mounted after closing so it can animate out.
  const [sheet, setSheet] = useState<{ key: string; session: number; open: boolean } | null>(null);
  const rows = list.data?.items;
  const sheetTemplate = sheet ? rows?.find((row) => row.key === sheet.key) : undefined;

  const text = (key: string, part: 'title' | 'description') => {
    const id = `keys.${key}.${part}` as 'keys.PASSWORD_RESET.title';
    return t.has(id) ? t(id) : part === 'title' ? key : '';
  };

  const columns: AdminTableColumn<EmailTemplateAdminDto>[] = [
    {
      id: 'name',
      header: t('columns.name'),
      width: 'minmax(0,2.4fr)',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="block truncate">{text(row.key, 'title')}</span>
          <span className="line-clamp-2 text-[13px] font-normal text-ink-muted">
            {text(row.key, 'description')}
          </span>
        </span>
      ),
    },
    {
      id: 'audience',
      header: t('columns.audience'),
      width: 'minmax(0,1fr)',
      cell: (row) => t(`audience.${row.audience}`),
    },
    {
      id: 'status',
      header: t('columns.status'),
      width: '120px',
      cell: (row) =>
        row.isCustomized ? (
          <Badge>{t('status.customized')}</Badge>
        ) : (
          <Badge variant="secondary">{t('status.builtIn')}</Badge>
        ),
    },
    {
      id: 'updated',
      header: t('columns.updated'),
      width: 'minmax(0,1.3fr)',
      hideOnMobile: true,
      cell: (row) =>
        row.updatedAt && row.updatedBy ? (
          <span className="block truncate">
            {t('updatedBy', {
              date: formatDate(row.updatedAt, locale as 'en' | 'ar'),
              name: row.updatedBy.name,
            })}
          </span>
        ) : (
          <span className="text-ink-muted">{t('neverEdited')}</span>
        ),
    },
  ];

  return (
    <>
      <AdminSectionHeader section="email-templates" />
      <AdminTable
        label={t('tableLabel')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.key}
        getRowLabel={(row) => text(row.key, 'title')}
        onRowClick={(row) =>
          setSheet((current) => ({
            key: row.key,
            session: (current?.session ?? 0) + 1,
            open: true,
          }))
        }
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] leading-normal text-ink-muted">{t('fixedNote')}</p>
        <WhoCanSeeNote audience="superAdmins" />
      </div>
      {sheet && sheetTemplate ? (
        <TemplateSheet
          key={`${sheet.key}:${sheet.session}`}
          template={sheetTemplate}
          open={sheet.open}
          onOpenChange={(open) => setSheet((current) => (current ? { ...current, open } : current))}
        />
      ) : null}
    </>
  );
}
