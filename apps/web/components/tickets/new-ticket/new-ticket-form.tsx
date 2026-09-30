'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  IMPACTS,
  TICKET_TYPES,
  type FormContext,
  type Impact,
  type Priority,
  type TicketDetailDto,
  type TicketFormConfig,
  type TicketType,
} from '@loons/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  useForm,
  useWatch,
  type FieldPath,
  type Resolver,
  type UseFormRegisterReturn,
} from 'react-hook-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { fadeVariants } from '@/lib/motion';
import {
  useApiErrorText,
  useAssetPlaceholder,
  useSlaWindowFormatter,
  useTicketValidationMessage,
} from '@/lib/tickets/i18n';
import { localizedLabel, placeName, teamName } from '@/lib/tickets/labels';
import { useCreateTicket } from '@/lib/tickets/mutations';
import {
  buildNewTicketSchema,
  countFieldErrors,
  dropUnavailableOptions,
  effectivePriority,
  emptyCustomFieldValue,
  emptyNewTicketValues,
  findCategory,
  securityCategory,
  toCreateTicketInput,
  type NewTicketFormValues,
} from '@/lib/tickets/new-ticket-form';
import { ticketKeys } from '@/lib/tickets/keys';
import { useFormContext } from '@/lib/tickets/queries';
import { useAttachmentUploads } from '@/lib/uploads/use-attachment-uploads';
import { cn } from '@/lib/utils';
import { AttachmentDropzone } from '../attachment-dropzone';
import { Combobox } from '../combobox';
import { FormField, fieldA11y } from '../form-field';
import { OrgChip } from '../org-chip';
import { SegmentedControl, type FocusHandle } from '../segmented-control';
import { CustomFieldInput } from './custom-field-input';
import { PriorityCards } from './priority-cards';
import { RequesterField } from './requester-field';

export interface NewTicketDefaults {
  /** Staff: open the form for this client contact. */
  requesterId?: string;
  type?: TicketType;
}

export interface NewTicketFormProps {
  config: TicketFormConfig;
  /** Staff raise tickets for a client (requester picker, PHONE channel, lands in the console). */
  isStaff: boolean;
  defaults?: NewTicketDefaults;
  /** Not called while the ticket is being created (Cancel is disabled then). */
  onCancel: () => void;
  onCreated: (ticket: TicketDetailDto) => void;
}

/** What the category / sub-type were before Security Incident forced the security category. */
interface ForcedCategory {
  categoryId: string;
  subtypeId: string;
}

/** Top-level form paths the API may report issues for. */
const FIELD_PATHS = new Set<string>([
  'requesterId',
  'type',
  'subject',
  'categoryId',
  'subtypeId',
  'priority',
  'impact',
  'siteId',
  'assetId',
  'description',
]);

/**
 * The API's business-rule codes (400 VALIDATION_FAILED `details[].code`, sent with the generic
 * "validation.invalid") → the form's own, more specific messages.
 */
const RULE_MESSAGES: Record<string, string> = {
  requester: 'tickets.newTicket.errors.requesterRequired',
  category: 'tickets.newTicket.errors.categoryRequired',
  subtype: 'tickets.newTicket.errors.subtypeRequired',
  site: 'tickets.newTicket.errors.siteRequired',
  security_category: 'tickets.newTicket.errors.securityCategory',
};

const TEL = /[^\d+]/g;

/** Just the ref of a registration (react-hook-form focuses it on a validation error). */
const refOf = ({ ref }: UseFormRegisterReturn) => ({ ref });

/**
 * The New ticket form (design modal 1013–1141): header with the client organisation, every
 * field, and the footer with routing / SLA summary, error count and actions. Rendered inside
 * `NewTicketModal`'s dialog; validated with the contract schema + live config.
 */
export function NewTicketForm({
  config,
  isStaff,
  defaults,
  onCancel,
  onCreated,
}: NewTicketFormProps) {
  const t = useTranslations('tickets.newTicket');
  const tTickets = useTranslations('tickets');
  const locale = useLocale();
  const message = useTicketValidationMessage();
  const errorText = useApiErrorText();
  const formatWindow = useSlaWindowFormatter();
  const assetPlaceholder = useAssetPlaceholder();
  const createTicket = useCreateTicket();
  // Files of the ticket's description are public (the requester can download them).
  const uploads = useAttachmentUploads({ visibility: 'public' });
  const idPrefix = useId();
  const fid = (name: string) => `${idPrefix}-${name}`;
  const [formError, setFormError] = useState<string | null>(null);
  /** Polite announcement of what a ticket type change did to the category (DA-2). */
  const [typeNotice, setTypeNotice] = useState('');
  const forcedFrom = useRef<ForcedCategory | null>(null);

  const secCategory = securityCategory(config);
  const initialType = defaults?.type ?? 'INCIDENT';

  // Validation reads the requester's sites from the form-context cache (loaded below).
  const queryClient = useQueryClient();
  const resolver = useCallback<Resolver<NewTicketFormValues>>(
    (values, context, options) => {
      const requesterContext =
        isStaff && !values.requesterId
          ? undefined
          : queryClient.getQueryData<FormContext>(
              ticketKeys.formContext(isStaff ? values.requesterId : null),
            );
      return zodResolver(
        buildNewTicketSchema(config, {
          requireRequester: isStaff,
          categoryId: values.categoryId,
          type: values.type,
          siteIds: requesterContext?.sites.map((site) => site.id),
        }),
      )(values, context, options);
    },
    [config, isStaff, queryClient],
  );

  const form = useForm<NewTicketFormValues>({
    resolver,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    defaultValues: emptyNewTicketValues({
      requesterId: defaults?.requesterId ?? '',
      type: initialType,
      categoryId: initialType === 'SECURITY_INCIDENT' && secCategory ? secCategory.id : '',
    }),
  });
  const { control, register, setValue, getValues, trigger, handleSubmit, setError } = form;
  const { errors, isSubmitted, submitCount } = form.formState;

  const [type, categoryId, subtypeId, priority, requesterId, siteId, impact] = useWatch({
    control,
    name: ['type', 'categoryId', 'subtypeId', 'priority', 'requesterId', 'siteId', 'impact'],
  });

  const contextQuery = useFormContext(isStaff ? requesterId || null : null, {
    enabled: isStaff ? !!requesterId : true,
  });
  // Staff see nothing until they pick the requester (never the "self" context).
  const formContext = isStaff && !requesterId ? undefined : contextQuery.data;
  const sites = formContext?.sites;

  // A single site is the obvious choice.
  useEffect(() => {
    if (sites?.length === 1 && sites[0] && !getValues('siteId')) {
      setValue('siteId', sites[0].id, { shouldDirty: true });
    }
  }, [sites, getValues, setValue]);

  // ── Derived display state
  const category = findCategory(config, categoryId);
  const subtype = category?.subtypes.find((s) => s.id === subtypeId);

  // ── Live config (Phase 4, E18): an admin may archive the chosen category / sub-type / an option
  // of a field, add fields, or change the security category while this form is open. The
  // refetched config re-renders the same form (the input is kept); a choice that disappeared is
  // cleared with a polite notice (its label is remembered from the configs this form has seen),
  // new fields get their empty value, and a Security Incident follows the security category.
  const seenLabels = useRef(new Map<string, string>());
  useEffect(() => {
    for (const c of config.categories) {
      seenLabels.current.set(c.id, localizedLabel(c, locale));
      for (const s of c.subtypes) seenLabels.current.set(s.id, localizedLabel(s, locale));
    }
  }, [config, locale]);
  const [configNotice, setConfigNotice] = useState('');
  useEffect(() => {
    if (type === 'SECURITY_INCIDENT' && secCategory && categoryId !== secCategory.id) {
      // The locked category must be the security one: move there (the sub-type was the old one's).
      setConfigNotice(
        t('securityCategoryMovedNotice', {
          category: seenLabels.current.get(secCategory.id) ?? '',
        }),
      );
      setValue('categoryId', secCategory.id, { shouldDirty: true });
      setValue('subtypeId', '', { shouldDirty: true });
      return;
    }
    if (categoryId && !findCategory(config, categoryId)) {
      setValue('categoryId', '', { shouldDirty: true });
      setValue('subtypeId', '', { shouldDirty: true });
      setConfigNotice(
        t('categoryGoneNotice', { category: seenLabels.current.get(categoryId) ?? '' }),
      );
      return;
    }
    const current = findCategory(config, categoryId);
    if (!current) return;
    if (subtypeId && !current.subtypes.some((s) => s.id === subtypeId)) {
      setValue('subtypeId', '', { shouldDirty: true });
      setConfigNotice(t('subtypeGoneNotice', { subtype: seenLabels.current.get(subtypeId) ?? '' }));
    }
    const values = getValues('customFields');
    const added = current.fields.filter((field) => !(field.key in values));
    let fields = values;
    if (added.length) {
      fields = { ...values };
      for (const field of added) fields[field.key] = emptyCustomFieldValue(field.type);
    }
    // A chosen option that was archived can't be seen or unticked: drop it and say so.
    const pruned = dropUnavailableOptions(current.fields, fields);
    if (pruned.changed.length) {
      setValue('customFields', pruned.values, { shouldDirty: true, shouldValidate: isSubmitted });
      const names = pruned.changed.map((field) => localizedLabel(field, locale));
      setConfigNotice(
        t('optionGoneNotice', {
          field: new Intl.ListFormat(locale, { type: 'conjunction' }).format(names),
        }),
      );
    } else if (added.length) {
      setValue('customFields', fields);
    }
  }, [
    config,
    type,
    secCategory,
    categoryId,
    subtypeId,
    isSubmitted,
    locale,
    getValues,
    setValue,
    t,
  ]);
  const effective = effectivePriority({ priority, categoryId, subtypeId }, config);
  const policy = effective ? config.slaPolicies.find((p) => p.priority === effective) : undefined;
  const isSecurity = type === 'SECURITY_INCIDENT';
  const categoryLocked = isSecurity && !!secCategory;
  const socHref = config.socPhone ? `tel:${config.socPhone.replace(TEL, '')}` : null;

  const validateAfterSubmit = { shouldDirty: true, shouldValidate: isSubmitted } as const;

  // ── Focus the first field when the form appears (dialog focus stays trapped inside).
  const requesterRef = useRef<HTMLButtonElement>(null);
  const typeRef = useRef<FocusHandle>(null);
  useEffect(() => {
    if (isStaff) requesterRef.current?.focus();
    else typeRef.current?.focus();
  }, [isStaff]);

  // ── Change handlers with the design's dependent-field rules
  const changeCategory = (next: string) => {
    // Radix's form selects echo programmatic value changes back through onValueChange (their
    // hidden native <select> fires "change", with '' while its options are being replaced): an
    // echo must not clear the sub-type set with the category.
    if (!next || next === getValues('categoryId')) return;
    setConfigNotice('');
    setValue('categoryId', next, validateAfterSubmit);
    setValue('subtypeId', '', { shouldDirty: true });
    const nextCategory = findCategory(config, next);
    const fields = { ...getValues('customFields') };
    for (const field of nextCategory?.fields ?? []) {
      if (!(field.key in fields)) fields[field.key] = emptyCustomFieldValue(field.type);
    }
    setValue('customFields', fields);
    if (isSubmitted) void trigger();
  };

  /** Puts back the category + sub-type Security Incident replaced (custom field values were kept). */
  const restoreCategory = ({
    categoryId: savedCategory,
    subtypeId: savedSubtype,
  }: ForcedCategory) => {
    setValue('categoryId', savedCategory, { shouldDirty: true });
    setValue('subtypeId', savedSubtype, { shouldDirty: true });
    const fields = { ...getValues('customFields') };
    for (const field of findCategory(config, savedCategory)?.fields ?? []) {
      if (!(field.key in fields)) fields[field.key] = emptyCustomFieldValue(field.type);
    }
    setValue('customFields', fields);
  };

  /**
   * Security Incident forces (and locks) the security category (spec §7); the sub-type is kept
   * when the category was already right. The category and sub-type it replaced come back when
   * the type changes again, as long as no security sub-type was picked meanwhile — so arrowing
   * through the type radios (which selects each one) leaves no trace. Both are announced.
   */
  const changeType = (next: TicketType) => {
    const previous = getValues('type');
    if (next === previous) return;
    // A notice about the live config (a moved category, a cleared option) is about the form as
    // it was: the type change says what happens now.
    setConfigNotice('');
    setValue('type', next, validateAfterSubmit);
    if (!secCategory) {
      if (isSubmitted) void trigger();
      return;
    }
    const securityLabel = localizedLabel(secCategory, locale);
    if (next === 'SECURITY_INCIDENT') {
      const current = getValues('categoryId');
      if (current !== secCategory.id) {
        forcedFrom.current = { categoryId: current, subtypeId: getValues('subtypeId') };
        changeCategory(secCategory.id);
      } else {
        forcedFrom.current = null;
        if (isSubmitted) void trigger();
      }
      setTypeNotice(t('categoryLockedNotice', { category: securityLabel }));
      return;
    }
    if (previous === 'SECURITY_INCIDENT') {
      const saved = forcedFrom.current;
      forcedFrom.current = null;
      const untouched =
        saved !== null && getValues('categoryId') === secCategory.id && !getValues('subtypeId');
      if (saved && untouched) {
        restoreCategory(saved);
        const restored = findCategory(config, saved.categoryId);
        setTypeNotice(
          restored
            ? t('categoryRestoredNotice', { category: localizedLabel(restored, locale) })
            : t('categoryUnlockedNotice'),
        );
      } else {
        setTypeNotice(t('categoryUnlockedNotice'));
      }
    }
    if (isSubmitted) void trigger();
  };

  const changeRequester = (next: string) => {
    if (next === getValues('requesterId')) return;
    setValue('requesterId', next, validateAfterSubmit);
    // Sites belong to the requester's organisation.
    setValue('siteId', '', { shouldDirty: true });
  };

  // ── Submit
  const onSubmit = handleSubmit(async (values) => {
    if (createTicket.isPending) return;
    setFormError(null);
    if (uploads.isUploading) {
      setFormError(t('uploadsPending'));
      return;
    }
    if (uploads.hasFailed) {
      setFormError(t('uploadsFailed'));
      return;
    }
    try {
      const input = toCreateTicketInput(values, {
        config,
        isStaff,
        attachmentIds: uploads.attachmentIds,
      });
      const ticket = await createTicket.mutateAsync(input);
      onCreated(ticket);
    } catch (error) {
      if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
        let mapped = 0;
        for (const issue of validationIssues(error)) {
          const path = issue.path.map(String).join('.');
          const known =
            FIELD_PATHS.has(path) || (path.startsWith('customFields.') && issue.path.length === 2);
          if (!known) continue;
          setError(
            path as FieldPath<NewTicketFormValues>,
            {
              type: 'server',
              message:
                issue.message === 'validation.invalid' && issue.code && RULE_MESSAGES[issue.code]
                  ? RULE_MESSAGES[issue.code]
                  : issue.message,
            },
            { shouldFocus: mapped === 0 },
          );
          mapped += 1;
        }
        if (mapped === 0) setFormError(errorText(error));
      } else {
        setFormError(errorText(error));
      }
    }
  });

  const pending = createTicket.isPending;
  const errorCount = countFieldErrors(errors as Record<string, unknown>);
  const err = (name: keyof NewTicketFormValues) =>
    message(errors[name]?.message as string | undefined);

  const typeOptions = TICKET_TYPES.map((value) => ({ value, label: tTickets(`type.${value}`) }));
  const impactOptions = IMPACTS.map((value) => ({ value, label: tTickets(`impact.${value}`) }));
  const priorityNote = priority
    ? t('priorityManual')
    : subtype
      ? t('priorityAuto')
      : t('priorityPending');
  const siteDisabled = isStaff && !requesterId;

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-busy={pending || undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Header: title + client organisation + close */}
      <div className="flex items-center justify-between gap-3 border-b border-divider px-6 py-[18px]">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <DialogPrimitive.Title className="text-lg font-semibold text-ink">
            {t('title')}
          </DialogPrimitive.Title>
          {formContext ? <OrgChip org={formContext.org} /> : null}
        </div>
        <DialogPrimitive.Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('close')}
            className="shrink-0 text-ink-muted"
          >
            <X aria-hidden="true" className="size-5" />
          </Button>
        </DialogPrimitive.Close>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5">
        {isStaff ? (
          <FormField
            id={fid('requester')}
            label={t('requester')}
            required
            labelNote={t('requesterHint')}
            error={err('requesterId')}
          >
            <RequesterField
              ref={(node) => {
                requesterRef.current = node;
                register('requesterId').ref(node);
              }}
              {...fieldA11y(fid('requester'), { error: err('requesterId') })}
              value={requesterId}
              onValueChange={changeRequester}
              selectedLabel={
                formContext
                  ? `${formContext.requester.name} — ${placeName(formContext.org, locale)}`
                  : undefined
              }
            />
          </FormField>
        ) : null}

        <FormField id={fid('type')} label={t('ticketType')} labelKind="group">
          <SegmentedControl
            ref={typeRef}
            aria-labelledby={`${fid('type')}-label`}
            options={typeOptions}
            value={type}
            onValueChange={changeType}
          />
          <p aria-live="polite" className="sr-only">
            {typeNotice}
          </p>
        </FormField>

        <AnimatePresence initial={false}>
          {isSecurity && secCategory ? (
            <motion.div
              key="security"
              variants={fadeVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              role="note"
              className="flex flex-col gap-1.5 rounded-lg border border-note-border bg-note-bg px-3.5 py-3 text-sm text-note-ink-strong"
            >
              <strong className="font-semibold">
                {t('securityTitle', { category: localizedLabel(secCategory, locale) })}
              </strong>
              <ul className="flex flex-col gap-1.5">
                {[t('securityCheck1'), t('securityCheck2')].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-3.5 shrink-0 rounded-[3px] border-[1.5px] border-current"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <FormField id={fid('subject')} label={t('subject')} required error={err('subject')}>
          <Input
            {...fieldA11y(fid('subject'), { error: err('subject') })}
            {...register('subject')}
            placeholder={t('subjectPlaceholder')}
            maxLength={200}
            autoComplete="off"
          />
        </FormField>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
          <FormField
            id={fid('category')}
            label={t('category')}
            required
            error={err('categoryId')}
            hint={
              categoryLocked && secCategory ? (
                <span className="inline-flex items-center gap-1.5">
                  <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                  {t('categoryLocked', { category: localizedLabel(secCategory, locale) })}
                </span>
              ) : undefined
            }
          >
            <Select value={categoryId} onValueChange={changeCategory} disabled={categoryLocked}>
              <SelectTrigger
                {...fieldA11y(fid('category'), {
                  error: err('categoryId'),
                  hint: categoryLocked,
                })}
                {...refOf(register('categoryId'))}
                className="w-full"
              >
                <SelectValue placeholder={t('categoryPlaceholder')} />
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-80">
                {config.categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {localizedLabel(c, locale)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            id={fid('subtype')}
            label={t('subtype')}
            required
            disabled={!category}
            error={err('subtypeId')}
          >
            <Select
              value={subtypeId}
              onValueChange={(next) => {
                // '' is never a choice: only the native <select>'s echo (see changeCategory).
                if (!next) return;
                setConfigNotice('');
                setValue('subtypeId', next, validateAfterSubmit);
              }}
              disabled={!category}
            >
              <SelectTrigger
                {...fieldA11y(fid('subtype'), { error: err('subtypeId') })}
                {...refOf(register('subtypeId'))}
                className="w-full"
              >
                <SelectValue
                  placeholder={category ? t('subtypePlaceholder') : t('subtypeNeedsCategory')}
                />
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-80">
                {(category?.subtypes ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {localizedLabel(s, locale)}
                    <span className="text-ink-muted">{`  ·  ${s.defaultPriority}`}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        {/* Always mounted, so screen readers announce the notice when it appears. */}
        <div role="status" aria-live="polite" className={cn(!configNotice && 'sr-only')}>
          {configNotice ? (
            <p
              data-slot="config-notice"
              className="rounded-lg border border-note-border bg-note-bg px-3.5 py-3 text-sm leading-normal text-note-ink-strong"
            >
              {configNotice}
            </p>
          ) : null}
        </div>

        <FormField
          id={fid('priority')}
          label={t('priority')}
          labelKind="group"
          labelAside={<span id={`${fid('priority')}-note`}>{priorityNote}</span>}
          hint={
            policy
              ? t('targets', {
                  firstReply: formatWindow(policy.firstReplyMins, policy.businessHoursOnly),
                  resolution: formatWindow(policy.resolveMins, policy.businessHoursOnly),
                })
              : t('targetsPending')
          }
        >
          <PriorityCards
            ref={(handle) => {
              if (handle) register('priority').ref(handle);
            }}
            aria-labelledby={`${fid('priority')}-label`}
            aria-describedby={`${fid('priority')}-note ${fid('priority')}-hint`}
            value={effective}
            onValueChange={(next: Priority) => setValue('priority', next, validateAfterSubmit)}
            slaPolicies={config.slaPolicies}
          />
        </FormField>

        <AnimatePresence initial={false}>
          {effective === 'P1' ? (
            <motion.div
              key="p1"
              variants={fadeVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg bg-danger-alert px-3.5 py-3 text-primary-foreground"
            >
              <span className="flex-[1_1_280px] leading-[1.45] font-medium">
                <strong className="font-bold">{t('p1Title')}</strong> — {t('p1Message')}
              </span>
              {socHref ? (
                <a
                  href={socHref}
                  className="rounded-md bg-surface px-3.5 py-2 font-bold whitespace-nowrap text-danger-alert-ink no-underline hover:bg-danger-tint hover:text-danger-alert-ink"
                >
                  {t('callSoc')}
                  <span className="sr-only" dir="ltr">{` ${config.socPhone}`}</span>
                </a>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <FormField id={fid('impact')} label={t('impact')} labelKind="group">
          <SegmentedControl
            aria-labelledby={`${fid('impact')}-label`}
            options={impactOptions}
            value={impact}
            onValueChange={(next: Impact) => setValue('impact', next, validateAfterSubmit)}
          />
        </FormField>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
          <FormField
            id={fid('site')}
            label={t('site')}
            required
            disabled={siteDisabled}
            error={err('siteId')}
          >
            <Combobox
              {...refOf(register('siteId'))}
              {...fieldA11y(fid('site'), { error: err('siteId') })}
              value={siteId}
              onValueChange={(next) => setValue('siteId', next, validateAfterSubmit)}
              options={(sites ?? []).map((s) => ({
                value: s.id,
                label: placeName(s, locale),
                keywords: [s.name, s.nameAr ?? ''],
              }))}
              placeholder={siteDisabled ? t('siteNeedsRequester') : t('sitePlaceholder')}
              searchPlaceholder={t('sitePlaceholder')}
              emptyText={t('siteNone')}
              loading={contextQuery.isFetching}
              loadingText={tTickets('combobox.loading')}
              disabled={siteDisabled}
            />
          </FormField>

          <FormField
            id={fid('asset')}
            label={t('asset')}
            labelNote={t('optional')}
            error={err('assetId')}
          >
            <Input
              {...fieldA11y(fid('asset'), { error: err('assetId') })}
              {...register('assetId')}
              placeholder={
                assetPlaceholder(category?.assetPlaceholder, category?.assetPlaceholderAr) ??
                t('assetPlaceholder')
              }
              maxLength={100}
              autoComplete="off"
              className="font-mono"
            />
          </FormField>
        </div>

        {category && category.fields.length ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
            {category.fields.map((field) => (
              <CustomFieldInput
                key={field.id}
                field={field}
                control={control}
                idPrefix={idPrefix}
              />
            ))}
          </div>
        ) : null}

        <FormField
          id={fid('description')}
          label={t('description')}
          required
          error={err('description')}
        >
          <Textarea
            {...fieldA11y(fid('description'), { error: err('description') })}
            {...register('description')}
            rows={4}
            placeholder={t('descriptionPlaceholder')}
            maxLength={10_000}
            className="min-h-[104px] resize-y"
          />
        </FormField>

        <AttachmentDropzone uploads={uploads} disabled={pending} />

        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {/* Footer: routing summary, error count, actions */}
      <div className="flex flex-wrap items-center gap-2.5 border-t border-divider px-6 py-3.5">
        <p className="min-w-[200px] flex-1 text-[13px] text-ink-secondary">
          {t('routedTo')}{' '}
          <strong className="font-semibold text-ink">
            {category ? teamName(category.team, locale) : t('none')}
          </strong>
          {' · '}
          {t('targetFirst')}{' '}
          <strong className="font-semibold text-ink">
            {policy ? formatWindow(policy.firstReplyMins, policy.businessHoursOnly) : t('none')}
          </strong>
        </p>
        <span
          aria-live="polite"
          className={cn(
            'text-[13px] font-medium whitespace-nowrap text-danger',
            !(submitCount > 0 && errorCount > 0) && 'sr-only',
          )}
        >
          {submitCount > 0 && errorCount > 0
            ? t('errorCount', { count: errorCount, n: String(errorCount) })
            : ''}
        </span>
        <div className="ms-auto flex items-center gap-2.5">
          {/* Disabled while creating (like Escape and ×): the request can't be taken back, and
              closing would hide a ticket that is created anyway. */}
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!pending) onCancel();
            }}
            className="h-auto py-[9px]"
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            className="h-auto px-4 py-[9px]"
          >
            {pending ? t('creating') : t('create')}
          </Button>
        </div>
      </div>
    </form>
  );
}
