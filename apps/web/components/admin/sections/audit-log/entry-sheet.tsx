'use client';

import type { AuditLogEntryDto } from '@loons/shared';
import { Filter } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { Button } from '@/components/ui/button';
import { formatDate, formatTime, isolate } from '@/lib/format';
import { AdminSheet } from '../../kit';
import { fieldChanges } from './audit-format';

type Untyped = { (key: string): string; has: (key: string) => boolean };

/** The translated name of an entity (`Team` → "Team"), or the raw name when unknown. */
export function useEntityName(): (entity: string) => string {
  const t = useTranslations('admin-comms.auditLog.entities') as unknown as Untyped;
  return (entity) => (t.has(entity) ? t(entity) : entity);
}

export function useActionName(): (action: string) => string {
  const t = useTranslations('admin-comms.auditLog.actions') as unknown as Untyped;
  return (action) => (t.has(action) ? t(action) : action);
}

/** Date and time of an entry in `timeZone` (the configured business time zone, E11). */
export function useWhen(timeZone?: string): (iso: string) => string {
  const locale = useLocale() as 'en' | 'ar';
  return (iso) => `${formatDate(iso, locale, timeZone)}, ${formatTime(iso, locale, timeZone)}`;
}

/** One stored value, readable: empty, yes / no, text, a list, or JSON for anything nested. */
export function AuditValue({ value, present }: { value: unknown; present: boolean }) {
  const t = useTranslations('admin-comms.auditLog.detail');
  if (!present || value === null || value === undefined || value === '') {
    return <span className="text-ink-muted">{t('empty')}</span>;
  }
  if (typeof value === 'boolean') return <span>{value ? t('yes') : t('no')}</span>;
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <span dir="auto" className="break-words whitespace-pre-wrap">
        {String(value)}
      </span>
    );
  }
  if (
    Array.isArray(value) &&
    value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
  ) {
    if (value.length === 0) return <span className="text-ink-muted">{t('empty')}</span>;
    return (
      <ol className="flex list-decimal flex-col gap-0.5 ps-5">
        {value.map((item, index) => (
          <li key={index} dir="auto" className="break-words">
            {String(item)}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <pre
      dir="ltr"
      className="overflow-x-auto rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-ink-secondary"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export interface EntrySheetProps {
  entry: AuditLogEntryDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shows this record's history (filters the log by the entry's entity and id). */
  onShowRecord?: (entry: AuditLogEntryDto) => void;
  /** IANA zone the time is shown in (default: the app's display zone). */
  timeZone?: string;
}

/** One audit entry, read-only (E17): who, when, the record, and each changed field before / after. */
export function EntrySheet({ entry, open, onOpenChange, onShowRecord, timeZone }: EntrySheetProps) {
  const t = useTranslations('admin-comms.auditLog');
  const entityName = useEntityName();
  const actionName = useActionName();
  const when = useWhen(timeZone);
  const changes = fieldChanges(entry);
  const who = entry.actor?.name ?? t('unknownActor');

  const facts: Array<[string, React.ReactNode]> = [
    [t('detail.who'), who],
    [t('detail.when'), when(entry.createdAt)],
    [
      t('detail.record'),
      <span key="record">
        {entityName(entry.entity)}
        {entry.entityLabel ? (
          <>
            {' · '}
            <span dir="auto">{entry.entityLabel}</span>
          </>
        ) : null}
      </span>,
    ],
    [
      t('detail.recordId'),
      <span key="id" dir="ltr" className="font-mono text-[13px] break-all">
        {entry.entityId}
      </span>,
    ],
  ];
  if (entry.requestId) {
    facts.push([
      t('detail.requestId'),
      <span key="req" dir="ltr" className="font-mono text-[13px] break-all">
        {entry.requestId}
      </span>,
    ]);
  }

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode="edit"
      readOnly
      title={`${actionName(entry.action)} · ${entityName(entry.entity)}`}
      description={t('detail.description', {
        // Isolated: an English label inside an Arabic sentence would otherwise take the digits
        // of the date after it into its own run ("… site · 30" read out of order).
        entity: isolate(entry.entityLabel ?? entityName(entry.entity)),
        when: when(entry.createdAt),
      })}
    >
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-5 gap-y-2.5">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="min-w-0 text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {onShowRecord ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => onShowRecord(entry)}
        >
          <Filter aria-hidden="true" />
          {t('detail.onlyThis')}
        </Button>
      ) : null}
      <section aria-labelledby="audit-changes-title" className="flex flex-col gap-2.5">
        <Kicker as="h3" id="audit-changes-title">
          {t('detail.changes')}
        </Kicker>
        {changes.length === 0 ? (
          <p className="text-ink-muted">{t('detail.noFields')}</p>
        ) : (
          <table className="w-full table-fixed border-collapse text-start text-sm">
            <thead>
              <tr className="border-b border-divider">
                <th scope="col" className="w-[28%] py-2 pe-3 text-start">
                  <Kicker as="span">{t('detail.field')}</Kicker>
                </th>
                <th scope="col" className="py-2 pe-3 text-start">
                  <Kicker as="span">{t('detail.before')}</Kicker>
                </th>
                <th scope="col" className="py-2 text-start">
                  <Kicker as="span">{t('detail.after')}</Kicker>
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr
                  key={change.field}
                  className="border-b border-divider align-top last:border-b-0"
                >
                  <th
                    scope="row"
                    className="py-2 pe-3 text-start font-mono text-[13px] font-normal break-all text-ink-secondary"
                  >
                    <span dir="ltr">{change.field}</span>
                  </th>
                  <td className="min-w-0 py-2 pe-3 text-ink-secondary">
                    <AuditValue value={change.before} present={change.hasBefore} />
                  </td>
                  <td className="min-w-0 py-2 text-ink">
                    <AuditValue value={change.after} present={change.hasAfter} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminSheet>
  );
}
