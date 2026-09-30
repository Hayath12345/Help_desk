'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADMIN_LIMITS,
  CONTRACT_TYPES,
  adminKeySchema,
  emailDomainSchema,
  labelEnSchema,
  normalizeE164,
  organizationResponseSchema,
  type ContractType,
  type OrganizationAdminDto,
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
import { suggestKey } from '@/lib/admin/key-suggestion';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { placeName } from '@/lib/tickets/labels';
import { AdminSheet, KeyField, RhfBilingualField } from '../../kit';
import {
  linesToList,
  listToLines,
  usePeopleErrorText,
  usePeopleValidation,
  useStaffDirectory,
} from '../teams/people';
import { OrgSites } from './org-sites';

const NONE = 'none';

interface OrgFormValues {
  name: string;
  nameAr: string;
  key: string;
  contractType: ContractType;
  amcExpiry: string;
  accountManagerId: string;
  emailDomains: string;
  phone: string;
}

const formSchema = z
  .object({
    name: labelEnSchema,
    nameAr: z.string().max(ADMIN_LIMITS.labelMax, { error: 'validation.tooLong' }),
    key: z.union([z.literal(''), adminKeySchema]),
    contractType: z.enum(CONTRACT_TYPES),
    amcExpiry: z.string(),
    accountManagerId: z.string(),
    emailDomains: z.string(),
    phone: z.string(),
  })
  .superRefine((value, ctx) => {
    for (const domain of linesToList(value.emailDomains)) {
      const parsed = emailDomainSchema.safeParse(domain);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['emailDomains'],
          message: parsed.error.issues[0]?.message ?? 'validation.emailDomain',
        });
        break;
      }
    }
    if (value.phone.trim() !== '' && normalizeE164(value.phone) === null) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'validation.phone' });
    }
  });

function valuesOf(org: OrganizationAdminDto | undefined): OrgFormValues {
  return {
    name: org?.name ?? '',
    nameAr: org?.nameAr ?? '',
    key: org?.key ?? '',
    contractType: org?.contractType ?? 'AMC',
    amcExpiry: org?.amcExpiry ?? '',
    accountManagerId: org?.accountManager?.id ?? NONE,
    emailDomains: listToLines(org?.emailDomains ?? []),
    phone: org?.phone ?? '',
  };
}

const FIELD_OF: Record<string, keyof OrgFormValues> = {
  name: 'name',
  nameAr: 'nameAr',
  key: 'key',
  contractType: 'contractType',
  amcExpiry: 'amcExpiry',
  accountManagerId: 'accountManagerId',
  emailDomains: 'emailDomains',
  phone: 'phone',
};

export interface OrgSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  org?: OrganizationAdminDto;
  onCreated: (org: OrganizationAdminDto) => void;
  /** Reload the list after a stale save (E19); resolves to the organisation's newest version. */
  onReload: () => Promise<OrganizationAdminDto | undefined>;
}

/**
 * Create / edit a client organisation (E10): names, contract, AMC expiry, account manager, email
 * domains and phone; its sites once it exists; archive / restore.
 */
export function OrgSheet({ open, onOpenChange, mode, org, onCreated, onReload }: OrgSheetProps) {
  const t = useTranslations('admin-people.clients');
  const tCommon = useTranslations('admin-people.common');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale();
  const validation = usePeopleValidation();
  const errorText = usePeopleErrorText();
  const id = useId();
  const formId = `${id}-form`;
  const directory = useStaffDirectory({}, open);

  const form = useForm<OrgFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(org),
  });
  const { control, register, handleSubmit, reset, setError, setValue, formState } = form;
  const [name, key, contractType, accountManagerId] = useWatch({
    control,
    name: ['name', 'key', 'contractType', 'accountManagerId'],
  });

  // The row the edit started from: the save diffs against it and sends its `updatedAt` (E19), even
  // when a newer version arrives meanwhile (that one is only loaded while the form is untouched,
  // or on Reload), so a concurrent change answers 409 instead of being written back.
  const base = useRef<OrganizationAdminDto | undefined>(org);
  const load = useCallback(
    (row: OrganizationAdminDto | undefined) => {
      base.current = row;
      reset(valuesOf(row));
    },
    [reset],
  );
  const orgId = org?.id;
  useEffect(() => {
    if (open) load(org);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the sheet opens / switches row
  }, [open, orgId, load]);

  const managerOptions = useMemo(
    () => [
      { value: NONE, label: t('form.managerNone') },
      ...(directory.data ?? []).map((s) => ({ value: s.id, label: s.name, description: s.email })),
    ],
    [directory.data, t],
  );

  const save = useAdminMutation({
    section: 'clients',
    scopes: ['form-context'],
    errorToast: false,
    mutationFn: (body: Record<string, unknown>) =>
      mode === 'create'
        ? adminWrite('POST', adminPath('clients'), body, organizationResponseSchema)
        : adminWrite('PATCH', adminPath('clients', org!.id), body, organizationResponseSchema),
    success: (result) =>
      mode === 'create'
        ? tKit('toast.created', { label: placeName(result.item, locale) })
        : t('saved'),
    onSuccess: (result) => {
      load(result.item);
      if (mode === 'create') onCreated(result.item);
      else onOpenChange(false);
    },
    onError: (error) => {
      if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return;
      let mapped = 0;
      for (const issue of validationIssues(error)) {
        const field = FIELD_OF[String(issue.path[0] ?? '')];
        if (!field) continue;
        setError(field, { type: 'server', message: issue.message }, { shouldFocus: mapped === 0 });
        mapped += 1;
      }
    },
  });
  const setActive = useAdminMutation({
    section: 'clients',
    scopes: ['form-context'],
    errorToast: false,
    mutationFn: (action: 'archive' | 'restore') =>
      adminWrite(
        'POST',
        adminPath('clients', org!.id, action),
        withExpectedUpdatedAt({}, base.current ?? org!),
        organizationResponseSchema,
      ),
    success: (result, action) =>
      tKit(action === 'archive' ? 'toast.archived' : 'toast.restored', {
        label: placeName(result.item, locale),
      }),
    onSuccess: (result) => {
      // Our own write: later saves start from it (the fields it returns are unchanged).
      base.current = result.item;
    },
  });

  // A newer version of the row (live refresh): loaded only while the form is untouched.
  const latest = org?.updatedAt;
  useEffect(() => {
    if (!open || !org || org.updatedAt === base.current?.updatedAt) return;
    if (!formState.isDirty && !save.isConflict && !setActive.isConflict) load(org);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a newer version arrives
  }, [latest]);

  // The submit callback runs at submit time (it reads the edit's base version).
  const submit = (event: React.FormEvent<HTMLFormElement>) =>
    handleSubmit((values) => onValid(values))(event);
  const onValid = (values: OrgFormValues) => {
    save.reset();
    const next = {
      name: values.name,
      nameAr: values.nameAr.trim() || null,
      contractType: values.contractType,
      amcExpiry: values.amcExpiry || null,
      accountManagerId: values.accountManagerId === NONE ? null : values.accountManagerId,
      emailDomains: linesToList(values.emailDomains).map((d) => d.toLowerCase()),
      phone: values.phone.trim() || null,
    };
    if (mode === 'create') {
      // A key the admin typed is sent as is; one still following the name is left to the API,
      // which adds the collision suffix against every organisation (archived included, E4) —
      // this sheet does not know the taken keys.
      const typed = values.key !== '' && values.key !== suggestKey(values.name);
      save.mutate({ ...(typed ? { key: values.key } : {}), ...next });
      return;
    }
    const started = base.current;
    if (!started) return;
    const current = {
      name: started.name,
      nameAr: started.nameAr,
      contractType: started.contractType,
      amcExpiry: started.amcExpiry,
      accountManagerId: started.accountManager?.id ?? null,
      emailDomains: started.emailDomains,
      phone: started.phone,
    };
    const body: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(next)) {
      const before = current[field as keyof typeof current];
      if (JSON.stringify(value) !== JSON.stringify(before)) body[field] = value;
    }
    if (Object.keys(body).length === 0) {
      onOpenChange(false);
      return;
    }
    save.mutate(withExpectedUpdatedAt(body, started));
  };

  const errorOf = (field: keyof OrgFormValues) => validation(formState.errors[field]?.message);
  const validationFailed = isApiRequestError(save.error) && save.error.code === 'VALIDATION_FAILED';
  const sheetError =
    save.error && !save.isConflict && !validationFailed
      ? errorText(save.error)
      : setActive.error && !setActive.isConflict
        ? errorText(setActive.error)
        : undefined;
  const label = org ? placeName(org, locale) : '';

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
      title={mode === 'create' ? t('createTitle') : t('editTitle', { name: label })}
      mode={mode}
      dirty={formState.isDirty}
      archived={mode === 'edit' && org ? !org.isActive : false}
      formId={formId}
      saving={save.isPending}
      onArchive={() => setActive.mutate('archive')}
      archiving={setActive.isPending && setActive.variables === 'archive'}
      onRestore={() => setActive.mutate('restore')}
      restoring={setActive.isPending && setActive.variables === 'restore'}
      itemLabel={label}
      archiveWarning={t('archiveWarning')}
      conflict={save.isConflict || setActive.isConflict}
      onReload={async () => {
        load((await onReload()) ?? org);
        save.reset();
        setActive.reset();
      }}
      error={sheetError}
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-[18px]">
        <RhfBilingualField
          id={`${id}-name`}
          control={control}
          nameEn="name"
          nameAr="nameAr"
          label={t('form.name')}
          required
          maxLength={ADMIN_LIMITS.labelMax}
          errorText={validation}
        />
        <KeyField
          id={`${id}-key`}
          mode={mode}
          value={key}
          onChange={(value) => setValue('key', value, { shouldDirty: true })}
          source={name}
          error={errorOf('key')}
        />
        <FormField id={`${id}-contract`} labelKind="group" label={t('form.contractType')}>
          <SegmentedControl
            aria-labelledby={`${id}-contract-label`}
            value={contractType}
            onValueChange={(value) => setValue('contractType', value, { shouldDirty: true })}
            options={CONTRACT_TYPES.map((c) => ({ value: c, label: t(`contract.${c}`) }))}
          />
        </FormField>
        <FormField
          id={`${id}-amc`}
          label={t('form.amcExpiry')}
          labelNote={tCommon('optional')}
          error={errorOf('amcExpiry')}
        >
          <Input
            {...fieldA11y(`${id}-amc`, { error: errorOf('amcExpiry') })}
            {...register('amcExpiry')}
            type="date"
            dir="ltr"
            className="w-48 max-w-full"
          />
        </FormField>
        <FormField
          id={`${id}-manager`}
          labelKind="group"
          label={t('form.manager')}
          labelNote={tCommon('optional')}
          error={errorOf('accountManagerId')}
        >
          <Combobox
            id={`${id}-manager`}
            aria-labelledby={`${id}-manager-label`}
            aria-invalid={Boolean(errorOf('accountManagerId'))}
            value={accountManagerId}
            onValueChange={(value) =>
              setValue('accountManagerId', value || NONE, { shouldDirty: true })
            }
            options={managerOptions}
            selectedLabel={org?.accountManager?.name}
            placeholder={t('form.managerNone')}
            searchPlaceholder={tCommon('searchStaff')}
            emptyText={tCommon('noStaff')}
            loading={directory.isPending}
            loadingText={tCommon('loadingStaff')}
          />
        </FormField>
        <FormField
          id={`${id}-domains`}
          label={t('form.domains')}
          labelNote={tCommon('optional')}
          hint={t('form.domainsHint')}
          error={errorOf('emailDomains')}
        >
          <Textarea
            {...fieldA11y(`${id}-domains`, { error: errorOf('emailDomains'), hint: true })}
            {...register('emailDomains')}
            dir="ltr"
            rows={2}
            spellCheck={false}
            className="font-mono text-[13px]"
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
            className="text-start"
          />
        </FormField>
      </form>
      {mode === 'edit' && org ? (
        <OrgSites org={org} />
      ) : (
        <p className="text-[13px] text-ink-muted">{t('sites.saveFirst')}</p>
      )}
    </AdminSheet>
  );
}
