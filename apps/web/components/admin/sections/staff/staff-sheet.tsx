'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  STAFF_LIMITS,
  STAFF_ROLES,
  emailSchema,
  normalizeE164,
  staffNameSchema,
  staffResponseSchema,
  type StaffAccountStatus,
  type StaffAdminDto,
  type StaffRole,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { adminPath, adminWrite, useAdminMutation, withExpectedUpdatedAt } from '@/lib/admin';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';
import { teamName } from '@/lib/tickets/labels';
import { AdminSheet } from '../../kit';
import { usePeopleErrorText, usePeopleValidation } from '../teams/people';

interface StaffFormValues {
  email: string;
  name: string;
  role: StaffRole;
  status: StaffAccountStatus;
  jobTitle: string;
  phone: string;
}

const formSchema = z.object({
  email: z.string(),
  name: staffNameSchema,
  role: z.enum(STAFF_ROLES),
  status: z.enum(['ACTIVE', 'DISABLED']),
  jobTitle: z.string().max(STAFF_LIMITS.jobTitleMax, { error: 'validation.tooLong' }),
  phone: z.string().refine((phone) => phone.trim() === '' || normalizeE164(phone) !== null, {
    error: 'validation.phone',
  }),
});
const createSchema = formSchema.extend({ email: emailSchema });

function valuesOf(staff: StaffAdminDto | undefined): StaffFormValues {
  return {
    email: staff?.email ?? '',
    name: staff?.name ?? '',
    role: staff?.role ?? 'AGENT',
    status: staff?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    jobTitle: staff?.jobTitle ?? '',
    phone: staff?.phone ?? '',
  };
}

const FIELDS = new Set<keyof StaffFormValues>([
  'email',
  'name',
  'role',
  'status',
  'jobTitle',
  'phone',
]);

export interface StaffSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  staff?: StaffAdminDto;
  /** The signed-in Super Admin (their own role and status are locked, E9). */
  viewerId: string;
  /** Reload the list after a stale save (E19); resolves to the account's newest version. */
  onReload: () => Promise<StaffAdminDto | undefined>;
}

/**
 * Create / edit a staff account (E9). The email is fixed once created (the Microsoft sign-in links
 * to it). A role or status change signs the person out everywhere; nobody changes their own role
 * or disables themselves, and the API keeps the last active Super Admin.
 */
export function StaffSheet({
  open,
  onOpenChange,
  mode,
  staff,
  viewerId,
  onReload,
}: StaffSheetProps) {
  const t = useTranslations('admin-people.staff');
  const tCommon = useTranslations('admin-people.common');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale();
  const validation = usePeopleValidation();
  const errorText = usePeopleErrorText();
  const id = useId();
  const formId = `${id}-form`;
  const self = mode === 'edit' && staff?.id === viewerId;

  const form = useForm<StaffFormValues>({
    resolver: zodResolver(mode === 'create' ? createSchema : formSchema),
    defaultValues: valuesOf(staff),
  });
  const { control, register, handleSubmit, reset, setError, setValue, formState } = form;
  const [role, status] = useWatch({ control, name: ['role', 'status'] });

  // The row the edit started from: the save diffs against it and sends its `updatedAt` (E19), even
  // when a newer version arrives meanwhile (that one is only loaded while the form is untouched,
  // or on Reload), so a concurrent role or status change answers 409 instead of being reverted.
  const base = useRef<StaffAdminDto | undefined>(staff);
  const load = useCallback(
    (row: StaffAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row));
    },
    [reset],
  );
  const staffId = staff?.id;
  useEffect(() => {
    if (open) load(staff);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the sheet opens / switches row
  }, [open, staffId, load]);

  const save = useAdminMutation({
    section: 'staff',
    scopes: ['staff'],
    errorToast: false,
    mutationFn: (body: Record<string, unknown>) =>
      mode === 'create'
        ? adminWrite('POST', adminPath('staff'), body, staffResponseSchema)
        : adminWrite('PATCH', adminPath('staff', staff!.id), body, staffResponseSchema),
    success: (result) =>
      mode === 'create' ? t('created', { name: result.item.name }) : t('saved'),
    onSuccess: (result) => {
      load(result.item);
      onOpenChange(false);
    },
    onError: (error) => {
      if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return;
      let mapped = 0;
      for (const issue of validationIssues(error)) {
        const field = String(issue.path[0] ?? '') as keyof StaffFormValues;
        if (!FIELDS.has(field)) continue;
        setError(field, { type: 'server', message: issue.message }, { shouldFocus: mapped === 0 });
        mapped += 1;
      }
    },
  });

  // A newer version of the row (live refresh): loaded only while the form is untouched.
  const latest = staff?.updatedAt;
  useEffect(() => {
    if (!open || !staff || staff.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict) load(staff);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const submit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((values) => onValid(values))(event);
  const onValid = (values: StaffFormValues) => {
    save.reset();
    const jobTitle = values.jobTitle.trim() || null;
    const phone = values.phone.trim() || null;
    if (mode === 'create') {
      save.mutate({ email: values.email, name: values.name, role: values.role, jobTitle, phone });
      return;
    }
    const started = base.current;
    if (!started) return;
    const body: Record<string, unknown> = {};
    if (values.name.trim() !== started.name) body.name = values.name;
    if (values.role !== started.role) body.role = values.role;
    if (values.status !== started.status) body.status = values.status;
    if (jobTitle !== started.jobTitle) body.jobTitle = jobTitle;
    if (phone !== started.phone) body.phone = phone;
    if (Object.keys(body).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate(withExpectedUpdatedAt(body, started));
  };

  const errorOf = (field: keyof StaffFormValues) => validation(formState.errors[field]?.message);
  const validationFailed = isApiRequestError(save.error) && save.error.code === 'VALIDATION_FAILED';
  // Against the version the edit started from (the form's default values), not a newer one.
  const initial = formState.defaultValues;
  const accessChanged =
    mode === 'edit' &&
    staff !== undefined &&
    (role !== initial?.role || status !== initial?.status);

  return (
    <AdminSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) save.reset();
        onOpenChange(next);
      }}
      title={mode === 'create' ? t('createTitle') : t('editTitle', { name: staff?.name ?? '' })}
      mode={mode}
      dirty={formState.isDirty}
      formId={formId}
      saving={save.isPending}
      conflict={save.isConflict}
      onReload={async () => {
        load((await onReload()) ?? staff);
        save.reset();
      }}
      error={
        save.error && !save.isConflict && !validationFailed ? errorText(save.error) : undefined
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-[18px]">
        <FormField
          id={`${id}-email`}
          label={t('form.email')}
          required={mode === 'create'}
          hint={mode === 'create' ? t('form.emailHint') : t('form.emailLocked')}
          error={errorOf('email')}
        >
          <Input
            {...fieldA11y(`${id}-email`, { error: errorOf('email'), hint: true })}
            {...register('email')}
            type="email"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            readOnly={mode === 'edit'}
            aria-readonly={mode === 'edit' || undefined}
            className={mode === 'edit' ? 'bg-surface-sunken text-ink-secondary' : undefined}
          />
        </FormField>
        <FormField id={`${id}-name`} label={t('form.name')} required error={errorOf('name')}>
          <Input
            {...fieldA11y(`${id}-name`, { error: errorOf('name') })}
            {...register('name')}
            dir="auto"
            autoComplete="off"
            maxLength={STAFF_LIMITS.nameMax}
          />
        </FormField>
        <FormField
          id={`${id}-role`}
          labelKind="group"
          label={t('form.role')}
          hint={self ? t('form.selfNote') : t('form.roleHint')}
        >
          <SegmentedControl
            aria-labelledby={`${id}-role-label`}
            aria-describedby={`${id}-role-hint`}
            value={role}
            disabled={self}
            onValueChange={(value) => setValue('role', value, { shouldDirty: true })}
            options={STAFF_ROLES.map((r) => ({ value: r, label: tCommon(`roles.${r}`) }))}
          />
        </FormField>
        {mode === 'edit' ? (
          <FormField id={`${id}-status`} labelKind="group" label={t('form.status')}>
            <SegmentedControl
              aria-labelledby={`${id}-status-label`}
              value={status}
              disabled={self}
              onValueChange={(value) => setValue('status', value, { shouldDirty: true })}
              options={[
                { value: 'ACTIVE', label: tCommon('active') },
                { value: 'DISABLED', label: tCommon('disabled') },
              ]}
            />
          </FormField>
        ) : null}
        {accessChanged ? (
          <Alert variant="warning" className="px-3.5 py-3">
            <AlertDescription>{t('form.revokeNote')}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          id={`${id}-job`}
          label={t('form.jobTitle')}
          labelNote={tCommon('optional')}
          error={errorOf('jobTitle')}
        >
          <Input
            {...fieldA11y(`${id}-job`, { error: errorOf('jobTitle') })}
            {...register('jobTitle')}
            dir="auto"
            autoComplete="off"
            maxLength={STAFF_LIMITS.jobTitleMax}
          />
        </FormField>
        <FormField
          id={`${id}-phone`}
          label={t('form.phone')}
          labelNote={tCommon('optional')}
          hint={t('form.phoneHint')}
          error={errorOf('phone')}
        >
          <Input
            {...fieldA11y(`${id}-phone`, { error: errorOf('phone'), hint: true })}
            {...register('phone')}
            type="tel"
            dir="ltr"
            autoComplete="off"
            maxLength={STAFF_LIMITS.phoneMax}
            className="text-start"
          />
        </FormField>
      </form>

      {mode === 'edit' && staff ? (
        <section className="flex flex-col gap-2" aria-labelledby={`${id}-teams`}>
          <h3 id={`${id}-teams`} className="font-medium text-ink">
            {t('form.teams')}
          </h3>
          {staff.teams.length === 0 ? (
            <p className="text-[13px] text-ink-muted">{t('form.noTeams')}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {staff.teams.map((team) => (
                <li key={team.id}>
                  <Badge variant={team.isActive ? 'secondary' : 'outline'}>
                    {teamName(team, locale)} · {tCommon(`memberRoles.${team.memberRole}`)}
                    {team.isActive ? null : ` · ${tKit('archived')}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[13px] text-ink-muted">
            {staff.microsoftLinked ? t('linked') : t('notLinked')}
            {staff.lastLoginAt
              ? ` · ${t('lastSignIn', { date: formatDateTime(staff.lastLoginAt, locale) })}`
              : null}
          </p>
        </section>
      ) : null}
    </AdminSheet>
  );
}
