'use client';

import { slaPolicyListSchema, type SlaPolicyAdminDto } from '@loons/shared';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PriorityPill } from '@/components/common/priority';
import { adminListFetcher, useAdminList } from '@/lib/admin';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { AdminSectionHeader, AdminTable, WhoCanSeeNote, type AdminTableColumn } from '../../kit';
import type { AdminSectionProps } from '../types';
import { SlaSheet } from './sla-sheet';

const fetchPolicies = adminListFetcher('sla', slaPolicyListSchema);

/**
 * SLA policies (spec §10.4; E12; Super Admins): the four fixed policies, one per priority — edit
 * only. Targets are shown like the New Ticket form shows them ("N business days" in the
 * configured day length). Changes apply to new tickets and later priority changes.
 */
export default function SlaSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-sla.sla');
  const tSections = useTranslations('admin.sections');
  const list = useAdminList({ section: 'sla', queryFn: fetchPolicies });
  const businessDayMinutes = list.data?.businessDayMinutes;
  const formatWindow = useSlaWindowFormatter(businessDayMinutes);
  const [openId, setOpenId] = useState<string | null>(null);
  const current = list.data?.items.find((p) => p.id === openId);

  const columns: AdminTableColumn<SlaPolicyAdminDto>[] = [
    {
      id: 'priority',
      header: t('table.priority'),
      width: 'minmax(0,1.3fr)',
      cell: (p) => <PriorityPill priority={p.priority} withDot />,
    },
    {
      id: 'firstReply',
      header: t('table.firstReply'),
      cell: (p) => formatWindow(p.firstReplyMins, p.businessHoursOnly),
    },
    {
      id: 'resolution',
      header: t('table.resolution'),
      cell: (p) => formatWindow(p.resolveMins, p.businessHoursOnly),
    },
    {
      id: 'clock',
      header: t('table.clock'),
      cell: (p) => (p.businessHoursOnly ? t('clock.business') : t('clock.always')),
    },
    {
      id: 'atRisk',
      header: t('table.atRisk'),
      width: '120px',
      cell: (p) => (
        <span dir="ltr" className="tabular-nums">
          {`${p.atRiskPercent}%`}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader section="sla" />
      <AdminTable
        label={tSections('sla.title')}
        columns={columns}
        rows={list.data?.items}
        getRowId={(p) => p.id}
        getRowLabel={(p) => p.priority}
        onRowClick={(p) => setOpenId(p.id)}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
      />
      <p
        role="note"
        className="flex items-start gap-2 text-[13px] leading-normal text-ink-secondary"
      >
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('appliesNote')}</span>
      </p>
      <WhoCanSeeNote audience="superAdmins" />
      <SlaSheet
        open={current !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        policy={current}
        businessDayMinutes={businessDayMinutes}
        onReload={async () => (await list.refetch()).data?.items.find((p) => p.id === openId)}
      />
    </div>
  );
}
