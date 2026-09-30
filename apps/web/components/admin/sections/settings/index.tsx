'use client';

import { AlertCircle } from 'lucide-react';
import { generalSettingsDtoSchema } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/common/empty-state';
import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { adminGet, adminPath, useAdminList } from '@/lib/admin';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { AdminSectionHeader, WhoCanSeeNote } from '../../kit';
import type { AdminSectionProps } from '../types';
import { SettingsForm } from './settings-form';

/**
 * General settings (E11; Super Admins): business time zone, SOC phone, auto-close delay, P4 digest
 * time and the security category — one form, like the owner's "Site settings".
 */
export default function SettingsSection(_props: AdminSectionProps) {
  const tKit = useTranslations('admin.kit');
  const errorText = useApiErrorText();
  const settings = useAdminList({
    section: 'settings',
    queryFn: (signal) => adminGet(adminPath('settings'), generalSettingsDtoSchema, { signal }),
  });

  let body: React.ReactNode;
  if (settings.data) {
    body = (
      <SettingsForm
        settings={settings.data}
        onReload={async () => (await settings.refetch()).data}
      />
    );
  } else if (settings.error) {
    body = (
      <Card className="py-0">
        <EmptyState
          headingLevel="p"
          icon={<AlertCircle />}
          title={tKit('loadError')}
          description={errorText(settings.error)}
          action={
            <Button type="button" variant="outline" onClick={() => void settings.refetch()}>
              {tKit('retry')}
            </Button>
          }
        />
      </Card>
    );
  } else {
    body = (
      <Card className="max-w-2xl py-0">
        <LoadingRegion label={tKit('loading')} className="flex flex-col gap-4 p-5">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonText key={i} className="h-8 w-full" />
          ))}
        </LoadingRegion>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader section="settings" />
      {body}
      <WhoCanSeeNote audience="superAdmins" />
    </div>
  );
}
