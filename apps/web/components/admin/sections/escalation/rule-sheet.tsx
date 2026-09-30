'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ESCALATION_LIMITS,
  ESCALATION_TARGET_ROLES,
  ESCALATION_TARGET_TYPES,
  escalationRuleResponseSchema,
  escalationTeamWarnings,
  staffDirectorySchema,
  type EscalationChannel,
  type EscalationRuleAdminDto,
  type EscalationTargetType,
  type EscalationTeamFacts,
  type EscalationWarning,
} from '@loons/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/tickets/form-field';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminGet, adminKeys, adminPath, adminWrite, useAdminMutation } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { AdminSheet } from '../../kit';
import {
  DurationInput,
  joinMinutes,
  splitMinutes,
  useSlaErrorText,
  useSlaValidation,
} from '../sla/sla-shared';
import { ESCALATION_CHANNEL_ORDER, WarningList, useDelayLabel } from './escalation-shared';

type TargetRole = (typeof ESCALATION_TARGET_ROLES)[number];

interface RuleFormValues {
  targetType: EscalationTargetType;
  targetRole: TargetRole;
  targetUserId: string;
  afterHours: string;
  afterMinutes: string;
  channels: EscalationChannel[];
}

const formSchema = z
  .object({
    targetType: z.enum(ESCALATION_TARGET_TYPES),
    targetRole: z.enum(ESCALATION_TARGET_ROLES),
    targetUserId: z.string(),
    afterHours: z.string(),
    afterMinutes: z.string(),
    channels: z.array(z.enum(['EMAIL', 'TEAMS', 'SMS'])),
  })
  .superRefine((v, ctx) => {
    if (v.targetType === 'USER' && !v.targetUserId) {
      ctx.addIssue({ code: 'custom', path: ['targetUserId'], message: 'validation.chooseUser' });
    }
    const total = joinMinutes(v.afterHours, v.afterMinutes);
    if (!Number.isFinite(total)) {
      ctx.addIssue({ code: 'custom', path: ['afterHours'], message: 'validation.wholeNumber' });
    } else if (total > ESCALATION_LIMITS.afterMinsMax) {
      ctx.addIssue({ code: 'custom', path: ['afterHours'], message: 'validation.delayTooLong' });
    }
    if (v.channels.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'validation.chooseChannel' });
    }
  });

function valuesOf(rule: EscalationRuleAdminDto | undefined, nextDelay: number): RuleFormValues {
  const after = splitMinutes(rule?.afterMins ?? nextDelay);
  return {
    targetType: rule?.targetType ?? 'ON_CALL',
    targetRole: rule?.targetRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'TEAM_LEAD',
    targetUserId: rule?.targetUser?.id ?? '',
    afterHours: String(after.hours),
    afterMinutes: String(after.minutes),
    channels: rule ? [...rule.channels] : ['EMAIL', 'SMS'],
  };
}

const SERVER_FIELDS: Record<string, FieldPath<RuleFormValues>> = {
  targetType: 'targetType',
  targetRole: 'targetRole',
  targetUserId: 'targetUserId',
  afterMins: 'afterHours',
  channels: 'channels',
};

/** A 400 whose issues name a field of the form (shown there); any other error is the sheet's. */
function hasFieldIssue(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    error.code === 'VALIDATION_FAILED' &&
    validationIssues(error).some((issue) => SERVER_FIELDS[String(issue.path[0])] !== undefined)
  );
}

export interface RuleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  rule: EscalationRuleAdminDto | undefined;
  /** The chain a new step joins (null = global). */
  teamId: string | null;
  chainName: string;
  /** The team follows the global chain today: this step starts its own chain. */
  firstOwnStep: boolean;
  nextStep: number;
  nextDelay: number;
  /**
   * The teams' webhooks and on-call users (by team id): the warnings then follow the draft as it is
   * edited. Until known, an edit shows the saved rule's warnings.
   */
  teamFacts?: ReadonlyMap<string, EscalationTeamFacts> | undefined;
  /** Refetches the list; resolves to the rule as it is now. */
  onReload: () => Promise<EscalationRuleAdminDto | undefined>;
}

/**
 * Add / edit / archive / restore an escalation step (E13): who is paged (the team's on-call user,
 * a role, or a person), how long after the ticket became P1 (counted from the start, not from the
 * previous step), and on which channels. Warnings (a missing webhook or phone…) show under it.
 */
export function RuleSheet({
  open,
  onOpenChange,
  mode,
  rule,
  teamId,
  chainName,
  firstOwnStep,
  nextStep,
  nextDelay,
  teamFacts,
  onReload,
}: RuleSheetProps) {
  const t = useTranslations('admin-sla.escalation');
  const validation = useSlaValidation();
  const errorText = useSlaErrorText();
  const delayLabel = useDelayLabel();
  const id = useId();
  const formId = `${id}-form`;

  const form = useForm<RuleFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(rule, nextDelay),
  });
  const { control, handleSubmit, reset, setError, setValue, formState } = form;
  const values = useWatch({ control });
  const targetType = values.targetType ?? 'ON_CALL';

  const staff = useQuery({
    queryKey: adminKeys.staffDirectory(),
    queryFn: ({ signal }) => adminGet('/admin/staff-directory', staffDirectorySchema, { signal }),
    enabled: open && targetType === 'USER',
    staleTime: 60_000,
  });
  const chosen = staff.data?.items.find((s) => s.id === values.targetUserId);

  const save = useAdminMutation({
    section: 'escalation',
    scopes: ['escalation'],
    errorToast: false,
    mutationFn: (v: RuleFormValues) => {
      const target = {
        targetType: v.targetType,
        targetRole: v.targetType === 'ROLE' ? v.targetRole : null,
        targetUserId: v.targetType === 'USER' ? v.targetUserId : null,
        afterMins: joinMinutes(v.afterHours, v.afterMinutes),
        channels: v.channels,
      };
      return mode === 'create'
        ? adminWrite(
            'POST',
            adminPath('escalation'),
            { teamId, step: nextStep, ...target },
            escalationRuleResponseSchema,
          )
        : adminWrite(
            'PATCH',
            adminPath('escalation', base.current!.id),
            { expectedUpdatedAt: base.current!.updatedAt, ...target },
            escalationRuleResponseSchema,
          );
    },
    success: (result) =>
      mode === 'create'
        ? t('created', { n: result.item.step })
        : t('saved', { n: result.item.step }),
    onSuccess: (result) => {
      reset(valuesOf(result.item, nextDelay));
      onOpenChange(false);
    },
    onError: (error) => {
      if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return;
      for (const issue of validationIssues(error)) {
        const field = SERVER_FIELDS[String(issue.path[0])];
        if (field) setError(field, { type: 'server', message: issue.message });
      }
    },
  });
  const setActive = useAdminMutation({
    section: 'escalation',
    scopes: ['escalation'],
    errorToast: false,
    mutationFn: (active: boolean) =>
      adminWrite(
        'POST',
        adminPath('escalation', base.current!.id, active ? 'restore' : 'archive'),
        { expectedUpdatedAt: base.current!.updatedAt },
        escalationRuleResponseSchema,
      ),
    success: (result, active) =>
      active ? t('restored', { n: result.item.step }) : t('archived', { n: result.item.step }),
    onSuccess: (_result, active) => {
      if (!active) onOpenChange(false);
    },
  });
  const { reset: resetSave } = save;
  const { reset: resetActive } = setActive;

  // The version the edit started from (E19): saves send its `updatedAt`; a newer version is only
  // loaded while the form is untouched, or on Reload.
  const base = useRef<EscalationRuleAdminDto | undefined>(rule);
  const load = useCallback(
    (row: EscalationRuleAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row, nextDelay));
    },
    [reset, nextDelay],
  );
  const ruleId = rule?.id;
  useEffect(() => {
    if (!open) return;
    load(rule);
    resetSave();
    resetActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when the sheet opens or switches row
  }, [open, ruleId]);
  const latest = rule?.updatedAt;
  useEffect(() => {
    if (!open || !rule || rule.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict && !setActive.isConflict) load(rule);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  const onSubmit = handleSubmit((v) => save.mutate(v));

  const conflict = save.isConflict || setActive.isConflict;
  const lastError = setActive.error ?? save.error;
  // A save's field issues show on the fields; anything else (another field such as the team, a
  // restore refused because its delay no longer fits the chain) is said at the top of the sheet.
  const formError =
    lastError && !conflict && !(lastError === save.error && hasFieldIssue(lastError))
      ? errorText(lastError)
      : undefined;
  const errors = formState.errors;
  const userError = validation(errors.targetUserId?.message);
  const delayError = validation(errors.afterHours?.message);
  const channelError = validation(errors.channels?.message);
  const delayTotal = joinMinutes(values.afterHours ?? '', values.afterMinutes ?? '');
  const delayHint = Number.isFinite(delayTotal)
    ? `${delayLabel(delayTotal)} · ${t('fields.delayHint')}`
    : t('fields.delayHint');
  const noPhoneForSms =
    targetType === 'USER' && chosen && !chosen.phoneValid && values.channels?.includes('SMS');

  // The warnings of the draft (E13), as the API would give them once saved: they follow the target
  // and channels while they are chosen. A USER target's missing phone is the person field's hint.
  const chainTeamId = mode === 'edit' && rule ? rule.teamId : teamId;
  const draftChannels = values.channels;
  const draftUserId = values.targetUserId;
  const warnings = useMemo((): EscalationWarning[] => {
    if (!teamFacts) return mode === 'edit' && rule ? rule.warnings : [];
    const out = escalationTeamWarnings(
      {
        teamId: chainTeamId,
        targetType,
        channels: (draftChannels ?? []).filter((c): c is EscalationChannel => c !== undefined),
      },
      teamFacts,
    );
    const saved = rule?.targetUser;
    if (targetType === 'USER' && saved && !saved.isActive && draftUserId === saved.id) {
      out.push('target_user_inactive');
    }
    return out;
  }, [teamFacts, mode, rule, chainTeamId, targetType, draftChannels, draftUserId]);

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      title={
        mode === 'create'
          ? t('createTitle', { n: nextStep })
          : t('editTitle', { n: rule?.step ?? 0 })
      }
      description={t('sheetDescription', { chain: chainName })}
      dirty={formState.isDirty}
      archived={mode === 'edit' && rule?.isActive === false}
      formId={formId}
      saving={save.isPending}
      onArchive={rule ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={rule ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={t('stepN', { n: rule?.step ?? 0 })}
      archiveWarning={t('archiveWarning')}
      conflict={conflict}
      onReload={async () => {
        load((await onReload()) ?? rule);
        resetSave();
        resetActive();
      }}
      error={formError}
    >
      <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-[18px]">
        {mode === 'create' && firstOwnStep ? (
          <p
            role="note"
            className="rounded-lg border border-note-border bg-note-bg px-3.5 py-3 text-[13px] leading-normal text-note-ink-strong"
          >
            {t('firstOwnStepNote', { team: chainName })}
          </p>
        ) : null}
        {/* Always rendered (never display:none), so screen readers announce the first warning
            that appears; while empty it takes back the form's gap after it. */}
        <div aria-live="polite" data-slot="draft-warnings" className="empty:-mb-[18px]">
          <WarningList rule={{ warnings, teamId: chainTeamId }} />
        </div>

        <FormField id={`${id}-target`} label={t('fields.target')} labelKind="group" required>
          <Controller
            control={control}
            name="targetType"
            render={({ field }) => (
              <SegmentedControl
                id={`${id}-target`}
                aria-labelledby={`${id}-target-label`}
                value={field.value}
                onValueChange={field.onChange}
                options={ESCALATION_TARGET_TYPES.map((type) => ({
                  value: type,
                  label: t(`targets.${type}`),
                }))}
              />
            )}
          />
        </FormField>
        {targetType === 'ON_CALL' ? (
          <p className="-mt-2 text-[13px] text-ink-secondary">{t('fields.onCallHint')}</p>
        ) : null}
        {targetType === 'ROLE' ? (
          <FormField id={`${id}-role`} label={t('fields.role')} labelKind="group" required>
            <Controller
              control={control}
              name="targetRole"
              render={({ field }) => (
                <SegmentedControl
                  id={`${id}-role`}
                  aria-labelledby={`${id}-role-label`}
                  size="sm"
                  value={field.value}
                  onValueChange={field.onChange}
                  options={ESCALATION_TARGET_ROLES.map((role) => ({
                    value: role,
                    label: t(`roles.${role}`),
                  }))}
                />
              )}
            />
          </FormField>
        ) : null}
        {targetType === 'USER' ? (
          <FormField
            id={`${id}-user`}
            label={t('fields.user')}
            required
            error={userError}
            hint={noPhoneForSms ? t('fields.userNoPhone') : undefined}
          >
            <Controller
              control={control}
              name="targetUserId"
              render={({ field }) => (
                <Select value={field.value || undefined} onValueChange={field.onChange}>
                  <SelectTrigger
                    id={`${id}-user`}
                    ref={field.ref}
                    aria-invalid={userError ? true : undefined}
                    aria-describedby={
                      [
                        userError ? `${id}-user-error` : null,
                        noPhoneForSms ? `${id}-user-hint` : null,
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    className="w-full"
                  >
                    <SelectValue
                      placeholder={
                        staff.isPending ? t('fields.loadingStaff') : t('fields.choosePerson')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {rule?.targetUser &&
                    !staff.data?.items.some((s) => s.id === rule.targetUser?.id) ? (
                      <SelectItem value={rule.targetUser.id}>
                        {rule.targetUser.isActive
                          ? rule.targetUser.name
                          : t('targets.userInactive', { name: rule.targetUser.name })}
                      </SelectItem>
                    ) : null}
                    {(staff.data?.items ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.jobTitle ? `${s.name} · ${s.jobTitle}` : s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        ) : null}

        <FormField
          id={`${id}-delay`}
          label={t('fields.delay')}
          labelKind="group"
          required
          hint={delayHint}
          error={delayError}
        >
          <DurationInput
            id={`${id}-delay`}
            labelledBy={`${id}-delay-label`}
            hours={values.afterHours ?? ''}
            minutes={values.afterMinutes ?? ''}
            onHoursChange={(v) => setValue('afterHours', v, { shouldDirty: true })}
            onMinutesChange={(v) => setValue('afterMinutes', v, { shouldDirty: true })}
            describedBy={[delayError ? `${id}-delay-error` : null, `${id}-delay-hint`]
              .filter(Boolean)
              .join(' ')}
            invalid={Boolean(delayError)}
          />
        </FormField>

        <FormField
          id={`${id}-channels`}
          label={t('fields.channels')}
          labelKind="group"
          required
          error={channelError}
        >
          <Controller
            control={control}
            name="channels"
            render={({ field }) => (
              <div
                role="group"
                aria-labelledby={`${id}-channels-label`}
                aria-describedby={channelError ? `${id}-channels-error` : undefined}
                className="flex flex-wrap gap-x-5 gap-y-2"
              >
                {ESCALATION_CHANNEL_ORDER.map((channel) => {
                  const checkboxId = `${id}-channel-${channel}`;
                  const checked = field.value.includes(channel);
                  return (
                    <div key={channel} className="flex items-center gap-2">
                      <Checkbox
                        id={checkboxId}
                        checked={checked}
                        aria-invalid={channelError ? true : undefined}
                        onCheckedChange={(next) =>
                          field.onChange(
                            next === true
                              ? ESCALATION_CHANNEL_ORDER.filter(
                                  (c) => c === channel || field.value.includes(c),
                                )
                              : field.value.filter((c) => c !== channel),
                          )
                        }
                      />
                      <label htmlFor={checkboxId} className="cursor-pointer text-ink">
                        {t(`channels.${channel}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          />
        </FormField>
        {values.channels?.includes('TEAMS') ? (
          <p className="-mt-2 text-[13px] text-ink-secondary">{t('fields.teamsHint')}</p>
        ) : null}
      </form>
    </AdminSheet>
  );
}
