'use client';

import { businessHoursDtoSchema } from '@loons/shared';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/common/empty-state';
import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { adminGet, adminPath, useAdminList } from '@/lib/admin';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { AdminSectionHeader, WhoCanSeeNote } from '../../kit';
import type { AdminSectionProps } from '../types';
import { Holidays } from './holidays';
import { WeekForm } from './week-form';

/**
 * Business hours & holidays (spec §10.5; E12; Super Admins): the working week (saved as a whole)
 * and the public holidays. The business time zone is a General setting.
 */
export default function BusinessHoursSection(_props: AdminSectionProps) {
  const tKit = useTranslations('admin.kit');
  const errorText = useApiErrorText();
  const week = useAdminList({
    section: 'business-hours',
    params: { view: 'week' },
    queryFn: (signal) => adminGet(adminPath('business-hours'), businessHoursDtoSchema, { signal }),
  });

  let weekPanel: React.ReactNode;
  if (week.data) {
    weekPanel = <WeekForm week={week.data} onReload={async () => (await week.refetch()).data} />;
  } else if (week.error) {
    weekPanel = (
      <Card className="py-0">
        <EmptyState
          headingLevel="p"
          icon={<AlertCircle />}
          title={tKit('loadError')}
          description={errorText(week.error)}
          action={
            <Button type="button" variant="outline" onClick={() => void week.refetch()}>
              {tKit('retry')}
            </Button>
          }
        />
      </Card>
    );
  } else {
    weekPanel = (
      <Card className="py-0">
        <LoadingRegion label={tKit('loading')} className="flex flex-col gap-3 p-5">
          {Array.from({ length: 7 }, (_, i) => (
            <SkeletonText key={i} className="h-4 w-3/4" />
          ))}
        </LoadingRegion>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader section="business-hours" />
      {weekPanel}
      <Holidays />
      <WhoCanSeeNote audience="superAdmins" />
    </div>
  );
}
