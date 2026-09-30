'use client';

import {
  teamMemberResponseSchema,
  teamMemberRoleResponseSchema,
  type TeamAdminDto,
  type TeamMemberAdminDto,
  type TeamMemberRole,
} from '@loons/shared';
import { UserMinus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useRef, useState } from 'react';
import { Combobox } from '@/components/tickets/combobox';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { adminPath, adminWrite, useAdminMutation, withExpectedUpdatedAt } from '@/lib/admin';
import { teamName } from '@/lib/tickets/labels';
import { ConfirmDialog, useListFocus } from '../../kit';
import { PhoneStatus, usePeopleErrorText, useStaffDirectory } from './people';

export interface TeamMembersProps {
  team: TeamAdminDto;
  /** Super admins manage LEAD rows and roles; team leads MEMBER rows only (E7). */
  isSuperAdmin: boolean;
  /**
   * A role change moved the team's `updatedAt` from `from` to `to` (E19): our own write, so the
   * sheet's edit base can follow it instead of answering the next save with a false 409.
   */
  onTeamVersion?: (from: string, to: string) => void;
}

/**
 * The members of a team inside its sheet: each change is saved right away (one request), the
 * member's access is refreshed by the API. Team leads add and remove members; Super Admins also
 * add or remove leads and switch a member between member and lead.
 */
export function TeamMembers({ team, isSuperAdmin, onTeamVersion }: TeamMembersProps) {
  const t = useTranslations('admin-people.teams.members');
  const tCommon = useTranslations('admin-people.common');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale();
  const errorText = usePeopleErrorText();
  const id = useId();
  const [pick, setPick] = useState('');
  const [addAs, setAddAs] = useState<TeamMemberRole>('MEMBER');
  const [removing, setRemoving] = useState<TeamMemberAdminDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const directory = useStaffDirectory({}, team.isActive);
  const name = teamName(team, locale);
  // Removing a member moves focus to the next member's Remove button (or the heading).
  const { attach: attachList, ...listFocus } = useListFocus(
    team.members.map((m) => m.userId),
    { fallback: () => document.getElementById(`${id}-title`) },
  );

  const options = useMemo(() => {
    const members = new Set(team.members.map((m) => m.userId));
    return (directory.data ?? [])
      .filter((s) => !members.has(s.id))
      .map((s) => ({ value: s.id, label: s.name, description: s.email }));
  }, [directory.data, team.members]);

  const add = useAdminMutation({
    section: 'teams',
    scopes: ['teams'],
    errorToast: false,
    mutationFn: (vars: { userId: string; memberRole: TeamMemberRole }) =>
      adminWrite('POST', adminPath('teams', team.id, 'members'), vars, teamMemberResponseSchema),
    success: (result) => t('added', { name: result.item.name }),
    onSuccess: () => {
      setPick('');
      setAddAs('MEMBER');
      setError(null);
    },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useAdminMutation({
    section: 'teams',
    scopes: ['teams'],
    errorToast: false,
    mutationFn: (member: TeamMemberAdminDto) =>
      adminWrite(
        'DELETE',
        adminPath('teams', team.id, 'members', member.userId),
        undefined,
        teamMemberResponseSchema,
      ),
    success: (result) => t('removed', { name: result.item.name }),
    onSuccess: () => setError(null),
    onError: (e) => {
      listFocus.cancelRemoval();
      setError(errorText(e));
    },
  });
  // Our own role changes: the team's version before the first of them (as the list still shows
  // it until it refetches) and after the last. The next change is sent against the latter, so two
  // changes in a row never take the first for someone else's (E19).
  const ownVersion = useRef<{ from: string; to: string } | null>(null);
  const changeRole = useAdminMutation({
    section: 'teams',
    scopes: ['teams'],
    errorToast: false,
    mutationFn: async (vars: { member: TeamMemberAdminDto; memberRole: TeamMemberRole }) => {
      const own = ownVersion.current;
      const sent = own && own.from === team.updatedAt ? own.to : team.updatedAt;
      const result = await adminWrite(
        'PATCH',
        adminPath('teams', team.id, 'members', vars.member.userId),
        // The team's version: a role change is checked against it and moves it (E19).
        withExpectedUpdatedAt({ memberRole: vars.memberRole }, { updatedAt: sent }),
        teamMemberRoleResponseSchema,
      );
      return { ...result, sent };
    },
    success: (result) =>
      t('roleChanged', {
        name: result.item.name,
        role: tCommon(`memberRoles.${result.item.memberRole}`),
      }),
    onSuccess: (result) => {
      setError(null);
      const own = ownVersion.current;
      ownVersion.current = {
        from: own && own.to === result.sent ? own.from : result.sent,
        to: result.teamUpdatedAt,
      };
      onTeamVersion?.(result.sent, result.teamUpdatedAt);
    },
    onError: (e) => setError(errorText(e)),
  });
  const busy = add.isPending || remove.isPending || changeRole.isPending;

  return (
    <section ref={attachList} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h3
        id={`${id}-title`}
        tabIndex={-1}
        className="font-medium text-ink outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand"
      >
        {t('title')}
      </h3>
      {error ? (
        <p role="alert" className="text-[13px] leading-normal font-medium text-danger">
          {error}
        </p>
      ) : null}
      {team.members.length === 0 ? (
        <p className="text-[13px] text-ink-muted">{t('empty')}</p>
      ) : (
        <ul
          aria-label={t('list', { team: name })}
          className="flex flex-col overflow-hidden rounded-lg border border-line"
        >
          {team.members.map((member) => {
            const canRemove = isSuperAdmin || member.memberRole === 'MEMBER';
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-divider px-3.5 py-2.5 last:border-b-0"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-ink">{member.name}</span>
                  <span dir="ltr" className="truncate text-start text-[13px] text-ink-muted">
                    {member.email}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={member.memberRole === 'LEAD' ? 'default' : 'secondary'}>
                    {tCommon(`memberRoles.${member.memberRole}`)}
                  </Badge>
                  <PhoneStatus hasPhone={member.hasPhone} phoneValid={member.phoneValid} />
                  {member.status !== 'ACTIVE' ? (
                    <Badge variant="destructive">{tCommon('disabled')}</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {isSuperAdmin ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={
                        member.memberRole === 'LEAD'
                          ? t('makeMember', { name: member.name })
                          : t('makeLead', { name: member.name })
                      }
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (busy) return;
                        changeRole.mutate({
                          member,
                          memberRole: member.memberRole === 'LEAD' ? 'MEMBER' : 'LEAD',
                        });
                      }}
                    >
                      {member.memberRole === 'LEAD' ? t('makeMemberShort') : t('makeLeadShort')}
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('remove', { name: member.name })}
                      title={t('remove', { name: member.name })}
                      data-list-control="remove"
                      aria-disabled={busy || undefined}
                      onClick={() => {
                        if (!busy) setRemoving(member);
                      }}
                    >
                      <UserMinus aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {isSuperAdmin ? <p className="text-[13px] text-ink-muted">{t('leadAccountNote')}</p> : null}

      {team.isActive ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-muted p-3.5">
          <span id={`${id}-person`} className="text-[13px] font-medium text-ink">
            {t('person')}
          </span>
          <Combobox
            id={`${id}-pick`}
            aria-labelledby={`${id}-person`}
            value={pick}
            onValueChange={setPick}
            options={options}
            placeholder={tCommon('pickStaff')}
            searchPlaceholder={tCommon('searchStaff')}
            emptyText={tCommon('noStaff')}
            loading={directory.isPending}
            loadingText={tCommon('loadingStaff')}
          />
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {isSuperAdmin ? (
              <SegmentedControl
                aria-label={t('addAs')}
                size="sm"
                value={addAs}
                onValueChange={setAddAs}
                options={[
                  { value: 'MEMBER', label: tCommon('memberRoles.MEMBER') },
                  { value: 'LEAD', label: tCommon('memberRoles.LEAD') },
                ]}
              />
            ) : (
              <span />
            )}
            <Button
              type="button"
              aria-disabled={!pick || busy || undefined}
              aria-busy={add.isPending || undefined}
              onClick={() => {
                if (!pick || busy) return;
                add.mutate({ userId: pick, memberRole: isSuperAdmin ? addAs : 'MEMBER' });
              }}
            >
              {add.isPending ? t('adding') : t('add')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-ink-muted">{t('archivedNote')}</p>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? t('removeTitle', { name: removing.name, team: name }) : ''}
        description={t('removeBody')}
        confirmLabel={removing ? t('remove', { name: removing.name }) : ''}
        cancelLabel={tKit('cancel')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (removing) {
            listFocus.expectRemoval(removing.userId, 'remove');
            remove.mutate(removing);
          }
          setRemoving(null);
        }}
      />
    </section>
  );
}
