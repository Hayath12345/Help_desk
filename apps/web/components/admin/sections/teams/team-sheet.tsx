'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  adminKeySchema,
  emailSchema,
  labelArSchema,
  labelEnSchema,
  teamResponseSchema,
  teamsWebhookUrlSchema,
  type TeamAdminDto,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Combobox } from '@/components/tickets/combobox';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { adminPath, adminWrite, useAdminMutation, withExpectedUpdatedAt } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { teamName } from '@/lib/tickets/labels';
import { AdminSheet, KeyField, RhfBilingualField } from '../../kit';
import { linesToList, listToLines, usePeopleErrorText, usePeopleValidation } from './people';
import { TeamMembers } from './team-members';

type WebhookMode = 'keep' | 'replace' | 'remove';
const NONE = 'none';

interface TeamFormValues {
  nameEn: string;
  nameAr: string;
  key: string;
  emails: string;
  webhookMode: WebhookMode;
  webhookUrl: string;
  /** A member's id, or NONE. */
  onCallUserId: string;
}

const formSchema = z
  .object({
    nameEn: labelEnSchema,
    nameAr: labelArSchema,
    key: z.union([z.literal(''), adminKeySchema]),
    emails: z.string(),
    webhookMode: z.enum(['keep', 'replace', 'remove']),
    webhookUrl: z.string(),
    onCallUserId: z.string(),
  })
  .superRefine((value, ctx) => {
    const emails = linesToList(value.emails);
    if (emails.some((e) => !emailSchema.safeParse(e).success)) {
      ctx.addIssue({ code: 'custom', path: ['emails'], message: 'validation.email' });
    }
    if (value.webhookMode === 'replace' && value.webhookUrl.trim() !== '') {
      const url = teamsWebhookUrlSchema.safeParse(value.webhookUrl);
      if (!url.success) {
        ctx.addIssue({ code: 'custom', path: ['webhookUrl'], message: 'validation.webhookUrl' });
      }
    }
  });

function valuesOf(team: TeamAdminDto | undefined): TeamFormValues {
  return {
    nameEn: team?.nameEn ?? '',
    nameAr: team?.nameAr ?? '',
    key: team?.key ?? '',
    emails: listToLines(team?.emails ?? []),
    webhookMode: team?.teamsWebhook.configured ? 'keep' : 'replace',
    webhookUrl: '',
    onCallUserId: team?.onCallUser?.id ?? NONE,
  };
}

/** API issue path → form field. */
const FIELD_OF: Record<string, keyof TeamFormValues> = {
  nameEn: 'nameEn',
  nameAr: 'nameAr',
  key: 'key',
  emails: 'emails',
  teamsWebhookUrl: 'webhookUrl',
  onCallUserId: 'onCallUserId',
};

export interface TeamSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  /** The team being edited (edit mode). */
  team?: TeamAdminDto;
  isSuperAdmin: boolean;
  /** Keys of every team, archived included (key suggestion, E4). */
  takenKeys: readonly string[];
  /** A team was created: the section switches the sheet to it (members can be added next). */
  onCreated: (team: TeamAdminDto) => void;
  /** Reload the list after a stale save (E19); resolves to the team's newest version. */
  onReload: () => Promise<TeamAdminDto | undefined>;
}

/**
 * Create / edit a team (E5, E7). Super Admins edit the names, email list and Teams webhook, and
 * archive or restore; team leads only choose the on-call user and manage members. The webhook
 * URL is never shown: only whether one is set and its host.
 */
export function TeamSheet({
  open,
  onOpenChange,
  mode,
  team,
  isSuperAdmin,
  takenKeys,
  onCreated,
  onReload,
}: TeamSheetProps) {
  const t = useTranslations('admin-people.teams');
  const tCommon = useTranslations('admin-people.common');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale();
  const validation = usePeopleValidation();
  const errorText = usePeopleErrorText();
  const id = useId();
  const formId = `${id}-form`;

  const form = useForm<TeamFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(team),
  });
  const { control, register, handleSubmit, reset, setError, formState } = form;
  const [nameEn, webhookMode, keyValue, onCallValue] = useWatch({
    control,
    name: ['nameEn', 'webhookMode', 'key', 'onCallUserId'],
  });

  // The row the edit started from: the save diffs against it and sends its `updatedAt` (E19), even
  // when a newer version arrives meanwhile (that one is only loaded while the form is untouched,
  // or on Reload), so a concurrent change answers 409 instead of being written back.
  const base = useRef<TeamAdminDto | undefined>(team);
  const load = useCallback(
    (row: TeamAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row));
    },
    [reset],
  );
  // A fresh form whenever the sheet opens on a row (or on "Create new").
  const teamId = team?.id;
  useEffect(() => {
    if (open) load(team);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the sheet opens / switches row
  }, [open, teamId, load]);

  const onCallOptions = useMemo(
    () => [
      { value: NONE, label: t('form.onCallNone') },
      ...(team?.members ?? [])
        .filter((m) => m.phoneValid && m.status === 'ACTIVE')
        .map((m) => ({ value: m.userId, label: m.name, description: m.email })),
    ],
    [team?.members, t],
  );

  const showServerIssues = (error: unknown): boolean => {
    if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return false;
    let mapped = 0;
    for (const issue of validationIssues(error)) {
      const field = FIELD_OF[String(issue.path[0] ?? '')];
      if (!field) continue;
      setError(field, { type: 'server', message: issue.message }, { shouldFocus: mapped === 0 });
      mapped += 1;
    }
    return mapped > 0;
  };

  const save = useAdminMutation({
    section: 'teams',
    scopes: ['teams'],
    errorToast: false,
    mutationFn: (body: Record<string, unknown>) =>
      mode === 'create'
        ? adminWrite('POST', adminPath('teams'), body, teamResponseSchema)
        : adminWrite('PATCH', adminPath('teams', team!.id), body, teamResponseSchema),
    success: (result) =>
      mode === 'create'
        ? tKit('toast.created', { label: teamName(result.item, locale) })
        : t('saved'),
    onSuccess: (result) => {
      if (mode === 'create') {
        onCreated(result.item);
      } else {
        load(result.item);
        onOpenChange(false);
      }
    },
    onError: (error) => {
      showServerIssues(error);
    },
  });
  const setActive = useAdminMutation({
    section: 'teams',
    scopes: ['teams'],
    errorToast: false,
    mutationFn: (action: 'archive' | 'restore') =>
      adminWrite(
        'POST',
        adminPath('teams', team!.id, action),
        withExpectedUpdatedAt({}, base.current ?? team!),
        teamResponseSchema,
      ),
    success: (result, action) =>
      tKit(action === 'archive' ? 'toast.archived' : 'toast.restored', {
        label: teamName(result.item, locale),
      }),
    onSuccess: (result) => {
      // Our own write: later saves start from it (the fields it returns are unchanged).
      base.current = result.item;
    },
  });

  // A newer version of the row (live refresh): loaded only while the form is untouched.
  const latest = team?.updatedAt;
  useEffect(() => {
    if (!open || !team || team.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict && !setActive.isConflict) load(team);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const submit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((values) => onValid(values))(event);
  const onValid = (values: TeamFormValues) => {
    save.reset();
    if (mode === 'create') {
      save.mutate({
        ...(values.key ? { key: values.key } : {}),
        nameEn: values.nameEn,
        nameAr: values.nameAr,
        emails: linesToList(values.emails),
        teamsWebhookUrl:
          values.webhookMode === 'replace' && values.webhookUrl.trim()
            ? values.webhookUrl.trim()
            : null,
      });
      return;
    }
    const started = base.current;
    if (!started) return;
    const body: Record<string, unknown> = {};
    if (isSuperAdmin) {
      if (values.nameEn !== started.nameEn) body.nameEn = values.nameEn;
      if (values.nameAr !== started.nameAr) body.nameAr = values.nameAr;
      const emails = linesToList(values.emails);
      if (listToLines(emails) !== listToLines(started.emails)) body.emails = emails;
      if (values.webhookMode === 'replace' && values.webhookUrl.trim()) {
        body.teamsWebhookUrl = values.webhookUrl.trim();
      } else if (values.webhookMode === 'replace' && started.teamsWebhook.configured) {
        // "Replace URL" with nothing to replace it with is not "keep": ask for the URL.
        setError(
          'webhookUrl',
          { type: 'required', message: 'validation.required' },
          { shouldFocus: true },
        );
        return;
      } else if (values.webhookMode === 'remove' && started.teamsWebhook.configured) {
        body.teamsWebhookUrl = null;
      }
    }
    const onCall = values.onCallUserId === NONE ? null : values.onCallUserId;
    if (onCall !== (started.onCallUser?.id ?? null)) body.onCallUserId = onCall;
    if (Object.keys(body).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate(withExpectedUpdatedAt(body, started));
  };

  const archived = mode === 'edit' && team ? !team.isActive : false;
  const settingsLocked = !isSuperAdmin;
  const errorOf = (field: keyof TeamFormValues) => validation(formState.errors[field]?.message);
  const sheetError =
    save.error &&
    !save.isConflict &&
    !(isApiRequestError(save.error) && save.error.code === 'VALIDATION_FAILED')
      ? errorText(save.error)
      : setActive.error && !setActive.isConflict
        ? errorText(setActive.error)
        : undefined;

  const onCall = team?.onCallUser;
  const onCallWarning = onCall
    ? !onCall.isActive
      ? t('form.onCallInactive', { name: onCall.name })
      : !onCall.isMember
        ? t('form.onCallNotMember', { name: onCall.name })
        : !onCall.phoneValid
          ? t('form.onCallPhoneMissing', { name: onCall.name })
          : null
    : null;

  return (
    <AdminSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          save.reset();
          setActive.reset();
        }
        onOpenChange(next);
      }}
      title={
        mode === 'create'
          ? t('createTitle')
          : t('editTitle', { name: team ? teamName(team, locale) : '' })
      }
      mode={mode}
      dirty={formState.isDirty}
      archived={archived}
      formId={formId}
      saving={save.isPending}
      onArchive={isSuperAdmin ? () => setActive.mutate('archive') : undefined}
      archiving={setActive.isPending && setActive.variables === 'archive'}
      onRestore={isSuperAdmin ? () => setActive.mutate('restore') : undefined}
      restoring={setActive.isPending && setActive.variables === 'restore'}
      itemLabel={team ? teamName(team, locale) : undefined}
      archiveWarning={t('archiveWarning')}
      conflict={save.isConflict || setActive.isConflict}
      onReload={async () => {
        load((await onReload()) ?? team);
        save.reset();
        setActive.reset();
      }}
      error={sheetError}
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-[18px]">
        {settingsLocked ? (
          <p
            role="note"
            className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-[13px] leading-normal text-ink-secondary"
          >
            {t('leadNote')}
          </p>
        ) : null}
        <RhfBilingualField
          id={`${id}-name`}
          control={control}
          nameEn="nameEn"
          nameAr="nameAr"
          label={t('form.name')}
          required
          disabled={settingsLocked}
          maxLength={120}
          errorText={validation}
        />
        <KeyField
          id={`${id}-key`}
          mode={mode}
          value={keyValue}
          onChange={(value) =>
            form.setValue('key', value, { shouldDirty: true, shouldValidate: false })
          }
          source={nameEn}
          takenKeys={takenKeys}
          error={errorOf('key')}
        />
        <FormField
          id={`${id}-emails`}
          label={t('form.emails')}
          labelNote={tCommon('optional')}
          hint={settingsLocked ? t('form.readOnly') : t('form.emailsHint')}
          error={errorOf('emails')}
        >
          <Textarea
            {...fieldA11y(`${id}-emails`, { error: errorOf('emails'), hint: true })}
            {...register('emails')}
            dir="ltr"
            rows={3}
            spellCheck={false}
            disabled={settingsLocked}
            className="font-mono text-[13px]"
          />
        </FormField>

        <FormField
          id={`${id}-webhook`}
          labelKind="group"
          label={t('form.webhook')}
          hint={settingsLocked ? t('form.readOnly') : t('form.webhookHint')}
        >
          <div
            className="flex flex-col gap-2.5"
            role="group"
            aria-labelledby={`${id}-webhook-label`}
          >
            <p className="text-[13px] text-ink-secondary">
              {team?.teamsWebhook.configured
                ? t('form.webhookConfigured', { host: team.teamsWebhook.host ?? '' })
                : t('form.webhookNotSet')}
            </p>
            {isSuperAdmin && team?.teamsWebhook.configured ? (
              <SegmentedControl
                aria-label={t('form.webhook')}
                size="sm"
                value={webhookMode}
                onValueChange={(value) =>
                  form.setValue('webhookMode', value, { shouldDirty: true })
                }
                options={[
                  { value: 'keep', label: t('form.webhookKeep') },
                  { value: 'replace', label: t('form.webhookReplace') },
                  { value: 'remove', label: t('form.webhookRemove') },
                ]}
              />
            ) : null}
            {isSuperAdmin && webhookMode === 'replace' ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-webhook-url`} className="text-[13px] text-ink-secondary">
                  {t('form.webhookNewUrl')}
                </label>
                <Input
                  {...fieldA11y(`${id}-webhook-url`, { error: errorOf('webhookUrl') })}
                  {...register('webhookUrl')}
                  type="url"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://…webhook.office.com/…"
                />
                {errorOf('webhookUrl') ? (
                  <p
                    id={`${id}-webhook-url-error`}
                    className="text-[13px] leading-normal font-medium text-danger"
                  >
                    {errorOf('webhookUrl')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </FormField>

        {mode === 'edit' && team ? (
          <FormField
            id={`${id}-oncall`}
            labelKind="group"
            label={t('form.onCall')}
            hint={t('form.onCallHint')}
            error={errorOf('onCallUserId')}
          >
            <Combobox
              id={`${id}-oncall`}
              aria-labelledby={`${id}-oncall-label`}
              aria-describedby={`${id}-oncall-hint`}
              aria-invalid={Boolean(errorOf('onCallUserId'))}
              value={onCallValue}
              onValueChange={(value) =>
                form.setValue('onCallUserId', value || NONE, { shouldDirty: true })
              }
              options={onCallOptions}
              selectedLabel={onCall?.name}
              placeholder={t('form.onCallNone')}
              searchPlaceholder={tCommon('searchStaff')}
              emptyText={tCommon('noStaff')}
            />
            {onCallWarning ? (
              <p className="text-[13px] leading-normal text-ink-secondary" role="note">
                {onCallWarning}
              </p>
            ) : null}
          </FormField>
        ) : null}
      </form>

      {mode === 'edit' && team ? (
        <TeamMembers
          team={team}
          isSuperAdmin={isSuperAdmin}
          onTeamVersion={(from, to) => {
            // Our own role change moved the team's version: the edit carries on from it (nothing
            // the form edits changed). A base older than `from` stays: someone else's change
            // came between, and the save must still answer 409.
            if (base.current?.updatedAt === from) base.current = { ...base.current, updatedAt: to };
          }}
        />
      ) : (
        <p className="text-[13px] text-ink-muted">{t('members.saveFirst')}</p>
      )}
    </AdminSheet>
  );
}
