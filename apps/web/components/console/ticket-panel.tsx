'use client';

import {
  IMPACTS,
  PRIORITIES,
  STAFF_SETTABLE_STATUSES,
  staffCanSetStatus,
  type Impact,
  type Priority,
  type TicketDetailDto,
  type UpdateTicketInput,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo } from 'react';
import { Kicker } from '@/components/common/kicker';
import { PriorityDot } from '@/components/common/priority';
import { Button } from '@/components/ui/button';
import { useUpdateTicket, type UpdateTicketVariables } from '@/lib/tickets/mutations';
import { useAssetPlaceholder } from '@/lib/tickets/i18n';
import { useFormContext, useTeams, useTicketFormConfig } from '@/lib/tickets/queries';
import { localizedLabel, placeName, teamName } from '@/lib/tickets/labels';
import { useViewer } from '@/lib/tickets/viewer';
import { cn } from '@/lib/utils';
import { CustomFieldValues } from './custom-field-values';
import { AssetIdEditor, PropertySelect, TagsEditor, type PropertyOption } from './property-editors';
import { RequesterCard } from './requester-card';
import { SlaCard } from './sla-card';
import { StatusControl } from './status-control';

/** Radix Select items can't use '' as a value. */
export const UNASSIGNED = 'unassigned';

type StaffStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

/**
 * Console right panel (design 814–882): SLA card, status segmented control, the property editors
 * (priority, assignee, category, sub-type, impact, site, asset ID, tags), "Assign to me", the
 * ticket's custom-field values and the requester card. Every change is optimistic
 * (useUpdateTicket: instant, rolled back with a toast if the API refuses it).
 *
 * Archived config (E6): an archived category, sub-type, site, team, field or option stays shown
 * on the ticket with an "archived" marker, and a ticket on an archived team stays workable — its
 * members are still offered as assignees (GET /teams?archived=include).
 */
export function TicketPanel({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('console.panel');
  const tStatus = useTranslations('common.status');
  const tPriority = useTranslations('common.priority');
  const tImpact = useTranslations('tickets.impact');
  const locale = useLocale();
  const viewer = useViewer();
  const statusLabelId = useId();
  const update = useUpdateTicket();
  const config = useTicketFormConfig();
  const teams = useTeams();
  const teamArchived = !ticket.team.isActive;
  const withArchived = useTeams({ includeArchived: true, enabled: teamArchived });
  const teamList = teamArchived ? withArchived.data : teams.data;
  const sites = useFormContext(ticket.requester.id);
  const localizedAssetPlaceholder = useAssetPlaceholder();

  const save = (patch: UpdateTicketInput, optimistic?: UpdateTicketVariables['optimistic']) =>
    update.mutate({ ticketId: ticket.id, patch, optimistic });

  // ── Assignee: members of the ticket's team (+ the current assignee and a super admin viewer).
  const team = teamList?.find((candidate) => candidate.id === ticket.team.id);
  const assigneeOptions = useMemo<PropertyOption[]>(() => {
    const name = teamName(ticket.team, locale);
    const suffix = ticket.team.isActive ? name : t('archived', { label: name });
    const options: PropertyOption[] = [{ value: UNASSIGNED, label: t('unassigned') }];
    const seen = new Set<string>();
    const push = (id: string, name: string, withTeam: boolean) => {
      if (seen.has(id)) return;
      seen.add(id);
      const label = withTeam ? t('memberOption', { name, team: suffix }) : name;
      options.push({ value: id, label, textValue: label });
    };
    for (const member of team?.members ?? []) push(member.id, member.name, true);
    if (ticket.assignee) push(ticket.assignee.id, ticket.assignee.name, false);
    if (viewer?.role === 'SUPER_ADMIN') push(viewer.id, viewer.name, false);
    return options;
  }, [team, ticket.assignee, ticket.team, viewer, locale, t]);

  const isMine = !!viewer && ticket.assignee?.id === viewer.id;
  // Only team members (or a super admin) may take a ticket; before the teams load, offer it.
  const canTake =
    !!viewer &&
    !isMine &&
    (viewer.role === 'SUPER_ADMIN' ||
      !teamList ||
      !!team?.members.some((member) => member.id === viewer.id));

  const assign = (id: string | null) => {
    if (id === null) {
      save({ assigneeId: null });
      return;
    }
    const person =
      team?.members.find((member) => member.id === id) ??
      (ticket.assignee?.id === id ? ticket.assignee : null) ??
      (viewer?.id === id ? viewer : null);
    // First agent touch: a NEW ticket becomes OPEN when someone takes it (spec §7).
    const status = ticket.status === 'NEW' ? { status: 'OPEN' as const } : {};
    save(
      { assigneeId: id, ...status },
      person ? { assignee: { id: person.id, name: person.name } } : undefined,
    );
  };

  // ── Category / sub-type from the live config (archived values stay listed while in use).
  const categories = config.data?.categories;
  const category = categories?.find((candidate) => candidate.id === ticket.category.id);
  const categoryOptions = useMemo<PropertyOption[]>(() => {
    const options: PropertyOption[] = (categories ?? []).map((c) => ({
      value: c.id,
      label: localizedLabel(c, locale),
    }));
    if (!options.some((option) => option.value === ticket.category.id)) {
      const label = localizedLabel(ticket.category, locale);
      options.push({
        value: ticket.category.id,
        label: ticket.category.isActive ? label : t('archived', { label }),
      });
    }
    return options;
  }, [categories, ticket.category, locale, t]);

  const subtypeOptions = useMemo<PropertyOption[]>(() => {
    const options: PropertyOption[] = (category?.subtypes ?? []).map((s) => {
      const label = t('subtypeOption', {
        label: localizedLabel(s, locale),
        priority: s.defaultPriority,
      });
      return { value: s.id, label, textValue: label };
    });
    const current = ticket.subtype;
    if (current && !options.some((option) => option.value === current.id)) {
      const label = localizedLabel(current, locale);
      options.push({
        value: current.id,
        label: current.isActive ? label : t('archived', { label }),
      });
    }
    return options;
  }, [category, ticket.subtype, locale, t]);

  const changeCategory = (categoryId: string) => {
    const next = categories?.find((candidate) => candidate.id === categoryId);
    const firstSubtype = next?.subtypes[0];
    // The API requires a sub-type of the new category (design: its first sub-type).
    if (!firstSubtype) return;
    save({ categoryId, subtypeId: firstSubtype.id });
  };

  // ── Site: the requester organisation's active sites (form context).
  const siteList = sites.data?.sites;
  const siteOptions = useMemo<PropertyOption[]>(() => {
    const options: PropertyOption[] = (siteList ?? []).map((site) => ({
      value: site.id,
      label: placeName(site, locale),
    }));
    if (ticket.site && !options.some((option) => option.value === ticket.site?.id)) {
      const label = placeName(ticket.site, locale);
      options.unshift({
        value: ticket.site.id,
        label: ticket.site.isActive ? label : t('archived', { label }),
      });
    }
    return options;
  }, [siteList, ticket.site, locale, t]);

  const changeSite = (siteId: string) => {
    const site = siteList?.find((candidate) => candidate.id === siteId);
    // A site offered here is an active one (the form context lists active sites only).
    save({ siteId }, site ? { site: { ...site, isActive: true } } : undefined);
  };

  const priorityOptions = PRIORITIES.map<PropertyOption>((priority) => ({
    value: priority,
    textValue: tPriority(priority),
    label: (
      <span className="inline-flex items-center gap-2">
        <PriorityDot priority={priority} decorative />
        {tPriority(priority)}
      </span>
    ),
  }));

  const statusOptions = STAFF_SETTABLE_STATUSES.map((status) => ({
    value: status,
    label: tStatus(status),
    disabled: status !== ticket.status && !staffCanSetStatus(ticket.status, status),
  }));
  const statusValue = (STAFF_SETTABLE_STATUSES as readonly string[]).includes(ticket.status)
    ? (ticket.status as StaffStatus)
    : '';

  // The category's example in the UI language: its Arabic example when set, else the English one
  // in Arabic words ("e.g. FW-01" → "مثال: FW-01"; review DA-11).
  const assetPlaceholder = localizedAssetPlaceholder(
    category?.assetPlaceholder,
    category?.assetPlaceholderAr,
  );

  return (
    <div className="flex flex-col gap-[22px]">
      <SlaCard ticket={ticket} />

      <div className="flex flex-col gap-2.5">
        <Kicker as="h3" id={statusLabelId}>
          {t('status')}
        </Kicker>
        <StatusControl<StaffStatus>
          aria-labelledby={statusLabelId}
          options={statusOptions}
          value={statusValue}
          onValueChange={(status) => save({ status })}
          disabled={ticket.status === 'CLOSED'}
        />
        {ticket.status === 'CLOSED' ? (
          <p className="text-[13px] text-ink-muted">{t('closedNote')}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
        <PropertySelect
          label={t('priority')}
          value={ticket.priority}
          options={priorityOptions}
          onValueChange={(priority) => save({ priority: priority as Priority })}
        />
        <PropertySelect
          label={t('assignee')}
          value={ticket.assignee?.id ?? UNASSIGNED}
          options={assigneeOptions}
          onValueChange={(value) => assign(value === UNASSIGNED ? null : value)}
        />
        <PropertySelect
          label={t('category')}
          value={ticket.category.id}
          options={categoryOptions}
          onValueChange={changeCategory}
        />
        <PropertySelect
          label={t('subtype')}
          value={ticket.subtype?.id ?? ''}
          placeholder={t('none')}
          options={subtypeOptions}
          onValueChange={(subtypeId) => save({ subtypeId })}
        />
        <PropertySelect
          label={t('impact')}
          value={ticket.impact}
          options={IMPACTS.map((impact) => ({ value: impact, label: tImpact(impact) }))}
          onValueChange={(impact) => save({ impact: impact as Impact })}
        />
        <PropertySelect
          label={t('site')}
          value={ticket.site?.id ?? ''}
          placeholder={t('none')}
          options={siteOptions}
          onValueChange={changeSite}
        />
        <AssetIdEditor
          label={t('assetId')}
          value={ticket.assetId}
          placeholder={assetPlaceholder}
          onCommit={(assetId) => save({ assetId })}
        />
        <TagsEditor label={t('tags')} tags={ticket.tags} onChange={(tags) => save({ tags })} />
      </div>

      <CustomFieldValues fields={ticket.customFields} />

      {canTake && viewer ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => assign(viewer.id)}
          className={cn('h-auto py-2')}
        >
          {t('assignToMe')}
        </Button>
      ) : null}

      <RequesterCard ticket={ticket} />
    </div>
  );
}
