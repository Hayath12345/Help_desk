'use client';

import {
  ESCALATION_LIMITS,
  escalationListSchema,
  teamAdminListSchema,
  type EscalationRuleAdminDto,
  type EscalationTeamFacts,
  type Locale,
} from '@loons/shared';
import { Info } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  adminListFetcher,
  adminPath,
  adminWrite,
  useAdminList,
  useAdminMutation,
} from '@/lib/admin';
import { teamName } from '@/lib/tickets/labels';
import { useTeams } from '@/lib/tickets/queries';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '../../kit';
import type { AdminSectionProps } from '../types';
import {
  ESCALATION_CHANNEL_ORDER,
  WarningList,
  useDelayLabel,
  useTargetLabel,
} from './escalation-shared';
import { RuleSheet } from './rule-sheet';

const LIST_PARAMS = { status: 'all' } as const;
const fetchRules = adminListFetcher('escalation', escalationListSchema, { params: LIST_PARAMS });
// The Teams & members list (same query as that section): webhooks and on-call users, for the
// warnings of the step being edited.
const fetchTeams = adminListFetcher('teams', teamAdminListSchema, { params: LIST_PARAMS });
const GLOBAL = 'global';

type SheetState = { mode: 'create' } | { mode: 'edit'; id: string };
type Cached = { items: EscalationRuleAdminDto[] };

/** Rules of one chain (team id, or null = global), by step. */
function chainOf(items: readonly EscalationRuleAdminDto[], teamId: string | null) {
  return items.filter((r) => r.teamId === teamId).sort((a, b) => a.step - b.step);
}

/**
 * Escalation rules (spec §10.6; D3, E13; Super Admins): the P1 chain — global, and per team (a
 * team's own chain replaces the global one for that team). Steps are reordered by drag or the
 * Move buttons; archived steps keep their place after the active ones. Edits re-time the pending
 * steps of open P1 tickets.
 */
export default function EscalationSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-sla.escalation');
  const tChannels = useTranslations('admin-sla.escalation.channels');
  const locale = useLocale() as Locale;
  const id = useId();
  const [chain, setChain] = useState<string>(GLOBAL);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const targetLabel = useTargetLabel();
  const delayLabel = useDelayLabel();

  const list = useAdminList({ section: 'escalation', params: LIST_PARAMS, queryFn: fetchRules });
  const teams = useTeams();
  const adminTeams = useAdminList({ section: 'teams', params: LIST_PARAMS, queryFn: fetchTeams });
  const all = useMemo(() => list.data?.items ?? [], [list.data]);
  const teamId = chain === GLOBAL ? null : chain;
  const rows = list.data ? chainOf(all, teamId) : undefined;
  const active = (rows ?? []).filter((r) => r.isActive);
  const current = sheet?.mode === 'edit' ? all.find((r) => r.id === sheet.id) : undefined;

  // Active teams, plus archived teams that still have rules (their chains stay reachable, marked
  // archived: nothing can be added there).
  const chains = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; own: boolean; archived: boolean }>();
    for (const team of teams.data ?? []) {
      byId.set(team.id, { id: team.id, name: teamName(team, locale), own: false, archived: false });
    }
    for (const rule of all) {
      if (!rule.team) continue;
      const entry = byId.get(rule.team.id) ?? {
        id: rule.team.id,
        name: teamName(rule.team, locale),
        own: false,
        archived: !rule.team.isActive,
      };
      if (rule.isActive) entry.own = true;
      byId.set(rule.team.id, entry);
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [teams.data, all, locale]);
  const selected = chains.find((c) => c.id === teamId);
  const archivedTeam = selected?.archived === true;
  const usesGlobal = teamId !== null && active.length === 0 && !archivedTeam;

  // What the warnings of a draft step need about each team (undefined until both lists load).
  const teamFacts = useMemo(() => {
    if (!adminTeams.data || !list.data) return undefined;
    const withOwnChain = new Set(all.filter((r) => r.isActive && r.teamId).map((r) => r.teamId));
    return new Map<string, EscalationTeamFacts>(
      adminTeams.data.items.map((team) => [
        team.id,
        {
          hasWebhook: team.teamsWebhook.configured,
          onCall:
            team.onCallUser && team.onCallUser.isActive
              ? { phoneValid: team.onCallUser.phoneValid }
              : null,
          usesGlobalChain: team.isActive && !withOwnChain.has(team.id),
        },
      ]),
    );
  }, [adminTeams.data, list.data, all]);

  // New steps go at the end of the chain (archived steps keep their numbers).
  const nextStep = Math.max(0, ...(rows ?? []).map((r) => r.step)) + 1;
  const chainFull = nextStep > ESCALATION_LIMITS.stepsMax;
  const nextDelay = active.length ? Math.max(...active.map((r) => r.afterMins)) + 5 : 0;

  const reorder = useAdminMutation<{ expectedIds: string[]; ids: string[] }, undefined, Cached>({
    section: 'escalation',
    scopes: ['escalation'],
    mutationFn: (body) =>
      adminWrite('POST', adminPath('escalation', 'reorder'), { teamId, ...body }),
    optimistic: (cached, { ids }) => {
      const order = new Map(ids.map((ruleId, i) => [ruleId, i + 1]));
      const archived = chainOf(cached.items, teamId).filter((r) => !r.isActive);
      const archivedStep = new Map(archived.map((r, i) => [r.id, ids.length + i + 1]));
      // Each step keeps its time slot (as the API does): the delays, in order, go to the new order.
      const slots = chainOf(cached.items, teamId)
        .filter((r) => r.isActive)
        .map((r) => r.afterMins)
        .sort((a, b) => a - b);
      return {
        items: cached.items.map((r) => {
          if (r.teamId !== teamId) return r;
          const step = order.get(r.id);
          return step === undefined
            ? { ...r, step: archivedStep.get(r.id) ?? r.step }
            : { ...r, step, afterMins: slots[step - 1] ?? r.afterMins };
        }),
      };
    },
    success: t('reordered'),
  });

  const columns: AdminTableColumn<EscalationRuleAdminDto>[] = [
    {
      id: 'step',
      header: t('table.step'),
      width: 'minmax(0,1.6fr)',
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{t('stepN', { n: r.step })}</span>
          <span className="sr-only">, </span>
          <span className="truncate text-[13px] font-normal text-ink-secondary">
            {targetLabel(r)}
          </span>
        </span>
      ),
    },
    {
      id: 'after',
      header: t('table.after'),
      cell: (r) => delayLabel(r.afterMins),
    },
    {
      id: 'channels',
      header: t('table.channels'),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {ESCALATION_CHANNEL_ORDER.filter((c) => r.channels.includes(c)).map((c) => (
            <Badge key={c} variant="secondary">
              {tChannels(c)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'warnings',
      header: t('table.warnings'),
      width: 'minmax(0,1.6fr)',
      cell: (r) =>
        r.warnings.length ? (
          <WarningList rule={r} />
        ) : (
          <span className="text-ink-muted">{t('noWarnings')}</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader
        section="escalation"
        actions={
          <CreateNewButton
            label={t('add')}
            disabled={!list.data || chainFull || archivedTeam}
            onClick={() => setSheet({ mode: 'create' })}
          />
        }
      />
      <AdminTable
        label={t('tableLabel', {
          chain: selected ? selected.name : t('globalChain'),
        })}
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowLabel={(r) => t('stepLabel', { n: r.step, target: targetLabel(r) })}
        isArchived={(r) => !r.isActive}
        onRowClick={(r) => setSheet({ mode: 'edit', id: r.id })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        reorder={{
          onReorder: (ids, expectedIds) => reorder.mutate({ ids, expectedIds }),
          disabled: reorder.isPending,
        }}
        empty={{
          title: usesGlobal ? t('usesGlobalTitle') : t('empty'),
          description: archivedTeam
            ? t('archivedTeamNote')
            : usesGlobal
              ? t('usesGlobalBody')
              : t('emptyBody'),
        }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-chain`} className="text-[13px] text-ink-secondary">
              {t('chain')}
            </label>
            <Select value={chain} onValueChange={setChain}>
              <SelectTrigger id={`${id}-chain`} className="w-64 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL}>{t('globalChain')}</SelectItem>
                {chains.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.archived
                      ? t('teamChainArchived', { team: c.name })
                      : c.own
                        ? t('teamChainOwn', { team: c.name })
                        : t('teamChainGlobal', { team: c.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <p
        role="note"
        className="flex items-start gap-2 text-[13px] leading-normal text-ink-secondary"
      >
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {teamId === null
            ? t('globalNote')
            : archivedTeam
              ? t('archivedTeamNote')
              : usesGlobal
                ? t('usesGlobalNote')
                : t('teamNote')}{' '}
          {chainFull ? t('chainFull', { max: ESCALATION_LIMITS.stepsMax }) : null}
        </span>
      </p>
      <WhoCanSeeNote audience="superAdmins" />
      <RuleSheet
        open={sheet !== null && (sheet.mode === 'create' || current !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        mode={sheet?.mode ?? 'create'}
        rule={current}
        teamId={teamId}
        chainName={selected ? selected.name : t('globalChain')}
        firstOwnStep={usesGlobal}
        nextStep={nextStep}
        nextDelay={nextDelay}
        teamFacts={teamFacts}
        onReload={async () =>
          sheet?.mode === 'edit'
            ? (await list.refetch()).data?.items.find((r) => r.id === sheet.id)
            : undefined
        }
      />
    </div>
  );
}
