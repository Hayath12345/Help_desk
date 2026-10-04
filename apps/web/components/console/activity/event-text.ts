'use client';

import {
  TICKET_TYPES,
  type Locale,
  type TicketEventDto,
  type TicketEventType,
  type TicketEventValue,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { formatDuration, formatNumber, intlLocale, isolate, isolateDirection } from '@/lib/format';
import { localizedLabel, placeName, teamName } from '@/lib/tickets/labels';

// What one timeline line says (docs/PHASE5_CONTRACT.md F14): the change, localised per event type
// and value kind, with every inserted value isolated so names, labels and numbers of one language
// never reorder the sentence of the other — words from the message catalogue (status, priority…)
// in the UI direction, names and config labels by their first strong character, step numbers
// left to right. Archived teams / categories / sub-types / sites / fields carry the panel's
// "(archived)" marker, disabled people "(disabled)", and a removed record reads "a deleted user".

/** The field a "changed from … to …" event is about. */
type FieldKey =
  'status' | 'priority' | 'impact' | 'team' | 'category' | 'subtype' | 'site' | 'assetId' | 'type';

const FIELD_OF: Partial<Record<TicketEventType, FieldKey>> = {
  STATUS_CHANGED: 'status',
  PRIORITY_CHANGED: 'priority',
  IMPACT_CHANGED: 'impact',
  TEAM_CHANGED: 'team',
  CATEGORY_CHANGED: 'category',
  SUBTYPE_CHANGED: 'subtype',
  SITE_CHANGED: 'site',
  ASSET_CHANGED: 'assetId',
  TYPE_CHANGED: 'type',
};

const isTicketType = (value: string): value is (typeof TICKET_TYPES)[number] =>
  (TICKET_TYPES as readonly string[]).includes(value);

const tagsOf = (value: TicketEventValue | null): string[] =>
  value?.kind === 'tags' ? value.value : [];

export interface ActivityText {
  /** What happened, as one sentence in the UI language. */
  describe: (event: TicketEventDto) => string;
  /** Who did it: the actor's name, or "System" (SLA worker, escalation, auto-close). */
  who: (event: TicketEventDto) => string;
}

export function useActivityText(): ActivityText {
  const t = useTranslations('console.activity');
  const tStatus = useTranslations('common.status');
  const tPriority = useTranslations('common.priority');
  const tImpact = useTranslations('tickets.impact');
  const tType = useTranslations('tickets.type');
  const locale = useLocale() as Locale;

  return useMemo<ActivityText>(() => {
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    /** Words of the UI language (catalogue labels such as "P1 حرجة"). */
    const words = (text: string) => isolateDirection(text, dir);
    const ltr = (text: string) => isolateDirection(text, 'ltr');
    const list = (items: readonly string[]) =>
      new Intl.ListFormat(intlLocale(locale), { style: 'long', type: 'conjunction' }).format(items);
    /**
     * A config label, with the "(archived)" marker when it has been archived since — worded per
     * kind of record (Arabic agrees it with the noun: a category is feminine).
     */
    const labelled = (
      label: string,
      isActive: boolean,
      entity: 'team' | 'category' | 'subtype' | 'site' | 'field',
    ) => (isActive ? isolate(label) : words(t(`archived.${entity}`, { label: isolate(label) })));
    const duration = (minutes: number) => words(formatDuration(minutes * 60_000, locale));

    const value = (v: TicketEventValue | null, type: TicketEventType): string | null => {
      if (!v) return null;
      switch (v.kind) {
        case 'status':
          return words(tStatus(v.value));
        case 'priority':
          return words(tPriority(v.value));
        case 'impact':
          return words(tImpact(v.value));
        case 'user':
          return v.isActive ? isolate(v.name) : words(t('disabled', { name: isolate(v.name) }));
        case 'team':
          return labelled(teamName(v, locale), v.isActive, 'team');
        case 'category':
        case 'subtype':
          return labelled(localizedLabel(v, locale), v.isActive, v.kind);
        case 'site':
          return labelled(placeName(v, locale), v.isActive, 'site');
        case 'step':
          return ltr(formatNumber(v.value, locale));
        case 'tags':
          return v.value.length ? list(v.value.map(isolate)) : words(t('none'));
        case 'text':
          return type === 'TYPE_CHANGED' && isTicketType(v.value)
            ? words(tType(v.value))
            : isolate(v.value);
        case 'removed':
          return words(t(`removed.${v.entity}`));
      }
    };

    const change = (field: FieldKey, event: TicketEventDto): string => {
      const name = t(`fields.${field}`);
      const from = value(event.from, event.type);
      const to = value(event.to, event.type);
      if (from && to) return t('fieldChanged', { field: name, from, to });
      if (to) return t('fieldSet', { field: name, to });
      if (from) return t('fieldCleared', { field: name, from });
      return t('fieldChangedPlain', { field: name });
    };

    const describe = (event: TicketEventDto): string => {
      const { meta } = event;
      const field = FIELD_OF[event.type];
      if (field) return change(field, event);
      switch (event.type) {
        case 'CREATED':
          return meta.priority
            ? t('created', { priority: words(tPriority(meta.priority)) })
            : t('createdPlain');
        case 'REOPENED':
          return t('reopened');
        case 'AUTO_CLOSED':
          return meta.days !== undefined
            ? t('autoClosedAfter', { count: meta.days, n: formatNumber(meta.days, locale) })
            : t('autoClosed');
        case 'ASSIGNEE_CHANGED': {
          const from = value(event.from, event.type);
          const to = value(event.to, event.type);
          if (from && to) return t('reassigned', { from, to });
          // `meta.auto`: the system picked the assignee from the category's skills (no actor).
          if (to) return t(meta.auto && !from ? 'assignedAuto' : 'assigned', { to });
          if (from) return t('unassigned', { from });
          return t('assigneeChanged');
        }
        case 'TAGS_CHANGED': {
          const before = tagsOf(event.from);
          const after = tagsOf(event.to);
          const added = meta.added ?? after.filter((tag) => !before.includes(tag));
          const removed = meta.removed ?? before.filter((tag) => !after.includes(tag));
          const tags = (items: readonly string[]) => list(items.map(isolate));
          if (added.length && removed.length) {
            return t('tagsChanged', { added: tags(added), removed: tags(removed) });
          }
          if (added.length) return t('tagsAdded', { tags: tags(added) });
          if (removed.length) return t('tagsRemoved', { tags: tags(removed) });
          return t('tagsChangedPlain');
        }
        case 'CUSTOM_FIELDS_CHANGED': {
          const fields = meta.fields ?? [];
          if (fields.length === 0) return t('customFieldsPlain');
          return t('customFields', {
            fields: list(
              fields.map((f) => labelled(localizedLabel(f, locale), f.isActive, 'field')),
            ),
          });
        }
        case 'FIRST_REPLY':
          return meta.minutesToFirstReply !== undefined
            ? t('firstReplyAfter', { duration: duration(meta.minutesToFirstReply) })
            : t('firstReply');
        case 'SLA_AT_RISK':
          return t('slaAtRisk', { target: meta.target ?? 'other' });
        case 'SLA_BREACHED':
          return t('slaBreached', { target: meta.target ?? 'other' });
        case 'ESCALATED': {
          const step = event.to?.kind === 'step' ? event.to.value : meta.step;
          return step !== undefined
            ? t('escalated', { step: ltr(formatNumber(step, locale)) })
            : t('escalatedPlain');
        }
        case 'P1_ACKNOWLEDGED':
          return typeof meta.minutesToAcknowledge === 'number'
            ? t('acknowledgedAfter', { duration: duration(meta.minutesToAcknowledge) })
            : t('acknowledged');
        default:
          return t('updated');
      }
    };

    return {
      describe,
      who: (event) => event.actor?.name ?? t('system'),
    };
  }, [t, tStatus, tPriority, tImpact, tType, locale]);
}
