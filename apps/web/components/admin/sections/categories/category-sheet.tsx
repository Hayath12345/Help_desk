'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADMIN_KEY_PATTERN,
  ADMIN_LIMITS,
  ASSET_PLACEHOLDER_MAX,
  CATEGORY_FIELDS_MAX,
  CATEGORY_ICONS,
  DEFAULT_CATEGORY_ICON,
  PRIORITIES,
  type CategoryAdminDto,
  type Locale,
  type Priority,
} from '@loons/shared';
import { X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  AdminSheet,
  ArchivedBadge,
  BilingualField,
  KeyField,
  ReorderList,
  RhfBilingualField,
} from '@/components/admin/kit';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminMutation } from '@/lib/admin';
import { useTeams, useTicketFormConfig } from '@/lib/tickets/queries';
import { localizedLabel, teamName } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import { useCustomFieldList } from '../custom-fields/data';
import { CategoryPreview, type PreviewField } from './category-preview';
import { categoriesApi } from './data';
import {
  CATEGORY_ICON_COMPONENTS,
  PrioritySelect,
  useSetupMessage,
  useWriteErrorHandler,
} from './setup-shared';
import { SubtypesManager } from './subtypes-manager';

// The category sheet (spec §10.1; E4, E5, E16): name EN/AR, key (editable while creating only),
// routed team (active teams), icon from the allow-list, asset placeholder EN/AR, the first
// sub-type (create) or the sub-types manager (edit), and the linked custom fields in form order —
// with the live New Ticket preview beside it (wide sheet).

const text = (max: number) => z.string().max(max, { error: 'validation.tooLong' });

const baseSchema = z.object({
  labelEn: text(ADMIN_LIMITS.labelMax).refine((v) => v.trim() !== '', {
    error: 'validation.required',
  }),
  labelAr: text(ADMIN_LIMITS.labelMax),
  key: z.string().refine((v) => v === '' || ADMIN_KEY_PATTERN.test(v), {
    error: 'validation.keyFormat',
  }),
  icon: z.string(),
  teamId: z.string().min(1, { error: 'validation.required' }),
  assetPlaceholder: text(ASSET_PLACEHOLDER_MAX),
  assetPlaceholderAr: text(ASSET_PLACEHOLDER_MAX),
  firstSubtype: z.object({
    labelEn: text(ADMIN_LIMITS.labelMax),
    labelAr: text(ADMIN_LIMITS.labelMax),
    defaultPriority: z.enum(PRIORITIES),
  }),
  fieldIds: z.array(z.string()).max(CATEGORY_FIELDS_MAX, { error: 'validation.tooLong' }),
});

const createSchema = baseSchema.superRefine((value, ctx) => {
  if (value.firstSubtype.labelEn.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['firstSubtype', 'labelEn'],
      message: 'validation.required',
    });
  }
});

export type CategoryFormValues = z.infer<typeof baseSchema>;

const FORM_PATHS = [
  'labelEn',
  'labelAr',
  'key',
  'icon',
  'teamId',
  'assetPlaceholder',
  'assetPlaceholderAr',
  'firstSubtype.labelEn',
  'firstSubtype.labelAr',
  'firstSubtype.key',
  'firstSubtype.defaultPriority',
  'fieldIds',
] as const;

function valuesOf(category: CategoryAdminDto | undefined): CategoryFormValues {
  return {
    labelEn: category?.labelEn ?? '',
    labelAr: category?.labelAr ?? '',
    key: category?.key ?? '',
    icon: category?.icon ?? DEFAULT_CATEGORY_ICON,
    teamId: category?.team.id ?? '',
    assetPlaceholder: category?.assetPlaceholder ?? '',
    assetPlaceholderAr: category?.assetPlaceholderAr ?? '',
    firstSubtype: { labelEn: '', labelAr: '', defaultPriority: 'P3' },
    fieldIds: category?.fields.map((f) => f.fieldId) ?? [],
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value);

/** The PATCH body for what changed since `base` (null when nothing did). */
export function categoryPatch(
  base: CategoryAdminDto,
  values: CategoryFormValues,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (values.labelEn !== base.labelEn) patch.labelEn = values.labelEn;
  if (values.labelAr !== base.labelAr) patch.labelAr = values.labelAr;
  if (values.icon !== base.icon) patch.icon = values.icon;
  if (values.teamId !== base.team.id) patch.teamId = values.teamId;
  if (orNull(values.assetPlaceholder) !== base.assetPlaceholder) {
    patch.assetPlaceholder = values.assetPlaceholder;
  }
  if (orNull(values.assetPlaceholderAr) !== base.assetPlaceholderAr) {
    patch.assetPlaceholderAr = values.assetPlaceholderAr;
  }
  return Object.keys(patch).length ? patch : null;
}

export interface CategorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being edited (live from the list); undefined = create. */
  category?: CategoryAdminDto;
  /** Every category key (archived included), for key suggestions. */
  takenKeys: readonly string[];
  /** Refetches the list and returns the row's latest version (the conflict "Reload"). */
  reload: () => Promise<CategoryAdminDto | undefined>;
}

export function CategorySheet({
  open,
  onOpenChange,
  category,
  takenKeys,
  reload,
}: CategorySheetProps) {
  const t = useTranslations('admin-setup.categories');
  const tKit = useTranslations('admin.kit');
  const tPriority = useTranslations('common.priority');
  const locale = useLocale() as Locale;
  const message = useSetupMessage();
  const writeError = useWriteErrorHandler();
  const formId = useId();
  const mode = category ? 'edit' : 'create';
  // The version the edit started from (E19); moves on after each save or an explicit reload.
  const [base, setBase] = useState<CategoryAdminDto | undefined>(category);
  const [formError, setFormError] = useState<string | null>(null);

  const teams = useTeams();
  const fieldList = useCustomFieldList();
  const config = useTicketFormConfig();

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(mode === 'create' ? createSchema : baseSchema),
    defaultValues: valuesOf(category),
  });
  const draft = useWatch({ control: form.control });
  const errorText = (m?: string) => message(m);

  const save = useAdminMutation<CategoryFormValues, CategoryAdminDto | null>({
    section: 'categories',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: async (values) => {
      if (!base) {
        return categoriesApi.create({
          key: values.key || undefined,
          labelEn: values.labelEn,
          labelAr: values.labelAr,
          icon: values.icon,
          assetPlaceholder: values.assetPlaceholder,
          assetPlaceholderAr: values.assetPlaceholderAr,
          teamId: values.teamId,
          firstSubtype: values.firstSubtype,
          fieldIds: values.fieldIds,
        });
      }
      let current = base;
      const patch = categoryPatch(base, values);
      if (patch) {
        current = await categoriesApi.update(base.id, {
          ...patch,
          expectedUpdatedAt: base.updatedAt,
        });
        setBase(current);
      }
      const linked = base.fields.map((f) => f.fieldId);
      if (linked.join() !== values.fieldIds.join()) {
        current = await categoriesApi.setFields(base.id, {
          expectedUpdatedAt: current.updatedAt,
          fieldIds: values.fieldIds,
        });
        setBase(current);
      }
      return patch || current !== base ? current : null;
    },
    success: (result, values) =>
      base
        ? tKit('toast.saved')
        : tKit('toast.created', { label: result?.labelEn ?? values.labelEn }),
    onSuccess: () => onOpenChange(false),
    onError: (error) => setFormError(writeError(error, form.setError, FORM_PATHS)),
  });

  const setActive = useAdminMutation<boolean, CategoryAdminDto>({
    section: 'categories',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: (active) =>
      active
        ? categoriesApi.restore(base!.id, base!.updatedAt)
        : categoriesApi.archive(base!.id, base!.updatedAt),
    success: (row, active) =>
      tKit(active ? 'toast.restored' : 'toast.archived', { label: row.labelEn }),
    onSuccess: (row) => {
      setBase(row);
      if (!row.isActive) onOpenChange(false);
    },
    onError: (error) => setFormError(writeError(error, form.setError, FORM_PATHS)),
  });

  const conflict = save.isConflict || setActive.isConflict;
  const onReload = async () => {
    const fresh = await reload();
    if (fresh) {
      setBase(fresh);
      form.reset(valuesOf(fresh));
    }
    save.reset();
    setActive.reset();
    setFormError(null);
  };

  // ── Choices
  const teamOptions = useMemo(() => {
    const options = (teams.data ?? []).map((team) => ({
      id: team.id,
      label: teamName(team, locale),
      archived: false,
    }));
    if (category && !options.some((o) => o.id === category.team.id)) {
      options.push({
        id: category.team.id,
        label: teamName(category.team, locale),
        archived: !category.team.isActive,
      });
    }
    return options;
  }, [teams.data, category, locale]);

  const fieldsById = useMemo(
    () => new Map((fieldList.data?.items ?? []).map((f) => [f.id, f])),
    [fieldList.data],
  );
  const linkedIds = draft.fieldIds ?? [];

  // ── Preview (E16): the draft as the New Ticket form would show it.
  const previewSubtypes =
    mode === 'create'
      ? [
          {
            id: 'draft',
            labelEn: draft.firstSubtype?.labelEn ?? '',
            labelAr: draft.firstSubtype?.labelAr ?? '',
            defaultPriority: (draft.firstSubtype?.defaultPriority ?? 'P3') as Priority,
          },
        ]
      : (category?.subtypes ?? []).filter((s) => s.isActive);
  const previewFields: PreviewField[] = linkedIds.flatMap((id) => {
    const field = fieldsById.get(id);
    if (!field || !field.isActive) return [];
    return [{ ...field, options: field.options.filter((o) => o.isActive) }];
  });
  const previewTeam = teamOptions.find((o) => o.id === draft.teamId);
  const preview = (
    <CategoryPreview
      labelEn={draft.labelEn ?? ''}
      labelAr={draft.labelAr ?? ''}
      icon={draft.icon ?? DEFAULT_CATEGORY_ICON}
      team={
        previewTeam
          ? (teams.data?.find((team) => team.id === previewTeam.id) ??
            (category?.team.id === previewTeam.id ? category.team : null))
          : null
      }
      assetPlaceholder={draft.assetPlaceholder ?? ''}
      assetPlaceholderAr={draft.assetPlaceholderAr ?? ''}
      subtypes={previewSubtypes}
      fields={previewFields}
      slaPolicies={config.data?.slaPolicies}
    />
  );

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    save.mutate(values);
  });

  const archived = base ? !base.isActive : false;
  const hiddenReason = category?.hiddenReason;

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      size="wide"
      title={mode === 'create' ? t('createTitle') : localizedLabel(category!, locale)}
      description={mode === 'create' ? t('createDescription') : undefined}
      dirty={form.formState.isDirty}
      archived={archived}
      formId={formId}
      saving={save.isPending}
      onArchive={base && !base.isSecurityCategory ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={base ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={base ? localizedLabel(base, locale) : undefined}
      archiveWarning={t('archiveWarning')}
      conflict={conflict}
      onReload={onReload}
      error={formError}
      aside={preview}
    >
      {category?.isSecurityCategory ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-surface-muted px-3.5 py-3 text-[13px] text-ink-secondary"
        >
          {t('securityNote')}
        </p>
      ) : null}
      {hiddenReason && hiddenReason !== 'archived' ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-status-pending-bg px-3.5 py-3 text-[13px] text-status-pending-fg"
        >
          {t(`hidden.${hiddenReason}`)}
        </p>
      ) : null}
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-[18px]">
        <RhfBilingualField
          id={`${formId}-name`}
          label={t('name')}
          required
          maxLength={ADMIN_LIMITS.labelMax}
          control={form.control}
          nameEn="labelEn"
          nameAr="labelAr"
          errorText={errorText}
        />
        <Controller
          control={form.control}
          name="key"
          render={({ field, fieldState }) => (
            <KeyField
              id={`${formId}-key`}
              mode={mode}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              source={draft.labelEn ?? ''}
              takenKeys={takenKeys}
              error={errorText(fieldState.error?.message)}
            />
          )}
        />
        <Controller
          control={form.control}
          name="teamId"
          render={({ field, fieldState }) => {
            const id = `${formId}-team`;
            const error = errorText(fieldState.error?.message);
            return (
              <FormField id={id} label={t('team')} required hint={t('teamHint')} error={error}>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger
                    {...fieldA11y(id, { error, hint: true })}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className="w-full"
                  >
                    <SelectValue placeholder={t('teamPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {teamOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id} disabled={option.archived}>
                        {option.archived ? t('archivedTeam', { team: option.label }) : option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            );
          }}
        />
        <Controller
          control={form.control}
          name="icon"
          render={({ field }) => (
            <IconPicker id={`${formId}-icon`} value={field.value} onChange={field.onChange} />
          )}
        />
        <Controller
          control={form.control}
          name="assetPlaceholder"
          render={({ field: en, fieldState: enState }) => (
            <Controller
              control={form.control}
              name="assetPlaceholderAr"
              render={({ field: ar, fieldState: arState }) => (
                <BilingualField
                  id={`${formId}-asset`}
                  label={t('assetPlaceholder')}
                  hint={t('assetPlaceholderHint')}
                  maxLength={ASSET_PLACEHOLDER_MAX}
                  valueEn={en.value}
                  valueAr={ar.value}
                  onChangeEn={en.onChange}
                  onChangeAr={ar.onChange}
                  onBlurEn={en.onBlur}
                  onBlurAr={ar.onBlur}
                  refEn={en.ref}
                  refAr={ar.ref}
                  placeholderEn={t('assetPlaceholderExample')}
                  errorEn={errorText(enState.error?.message)}
                  errorAr={errorText(arState.error?.message)}
                />
              )}
            />
          )}
        />

        {mode === 'create' ? (
          <fieldset className="flex flex-col gap-3.5 rounded-lg border border-line p-4">
            <legend className="px-1 font-medium text-ink">{t('firstSubtype')}</legend>
            <p className="text-[13px] text-ink-secondary">{t('firstSubtypeHint')}</p>
            <RhfBilingualField
              id={`${formId}-subtype`}
              label={t('subtypeName')}
              required
              maxLength={ADMIN_LIMITS.labelMax}
              control={form.control}
              nameEn="firstSubtype.labelEn"
              nameAr="firstSubtype.labelAr"
              errorText={errorText}
            />
            <Controller
              control={form.control}
              name="firstSubtype.defaultPriority"
              render={({ field }) => (
                <PrioritySelect
                  id={`${formId}-subtype-priority`}
                  label={t('defaultPriority')}
                  value={field.value}
                  onChange={field.onChange}
                  tPriority={tPriority}
                />
              )}
            />
          </fieldset>
        ) : null}

        <Controller
          control={form.control}
          name="fieldIds"
          render={({ field, fieldState }) => (
            <LinkedFieldsEditor
              id={`${formId}-fields`}
              value={field.value}
              onChange={field.onChange}
              error={errorText(fieldState.error?.message)}
              fields={fieldList.data?.items ?? []}
              loading={fieldList.isPending}
            />
          )}
        />
      </form>

      {base && category ? <SubtypesManager category={category} /> : null}
    </AdminSheet>
  );
}

// ───────────── Pieces ─────────────

function IconPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('admin-setup.categories');
  const tIcons = useTranslations('admin-setup.icons');
  // An older row may hold an icon outside the allow-list: it stays selected until changed.
  const known = (CATEGORY_ICONS as readonly string[]).includes(value);
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="font-medium text-ink">
        {t('icon')}
      </span>
      <RadioGroupPrimitive.Root
        aria-labelledby={`${id}-label`}
        value={known ? value : ''}
        onValueChange={onChange}
        className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1.5"
      >
        {CATEGORY_ICONS.map((name) => {
          const Icon = CATEGORY_ICON_COMPONENTS[name];
          return (
            <RadioGroupPrimitive.Item
              key={name}
              value={name}
              aria-label={tIcons(name)}
              title={tIcons(name)}
              className="grid size-10 cursor-pointer place-items-center rounded-md border border-line bg-surface text-ink-secondary transition-colors duration-150 ease-out outline-none hover:border-line-dashed focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint focus-visible:outline-hidden data-[state=checked]:border-brand data-[state=checked]:bg-brand-tint data-[state=checked]:text-brand"
            >
              <Icon aria-hidden="true" className="size-[18px]" />
            </RadioGroupPrimitive.Item>
          );
        })}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

interface CatalogField {
  id: string;
  labelEn: string;
  labelAr: string;
  key: string;
  type: string;
  required: boolean;
  isActive: boolean;
}

/**
 * The custom fields linked to the category, in form order: reorder (drag or Move up / down),
 * remove, and add an active field. An archived field already linked stays (old tickets), marked.
 */
function LinkedFieldsEditor({
  id,
  value,
  onChange,
  error,
  fields,
  loading,
}: {
  id: string;
  value: string[];
  onChange: (ids: string[]) => void;
  error?: string;
  fields: readonly CatalogField[];
  loading: boolean;
}) {
  const t = useTranslations('admin-setup.categories.fields');
  const tTypes = useTranslations('admin-setup.fieldTypes');
  const locale = useLocale() as Locale;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const linked = value.map((fieldId) => byId.get(fieldId) ?? null);
  const addable = fields.filter((f) => f.isActive && !value.includes(f.id));
  const [adding, setAdding] = useState('');
  const labelOf = (fieldId: string) => {
    const field = byId.get(fieldId);
    return field ? localizedLabel(field, locale) : fieldId;
  };

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span id={`${id}-label`} className="font-medium text-ink">
          {t('title')}
        </span>
        <span className="text-[13px] text-ink-secondary">{t('hint')}</span>
      </div>
      {value.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-ink-muted">
          {loading ? t('loading') : t('none')}
        </p>
      ) : (
        <ReorderList
          label={t('title')}
          items={value.map((fieldId, i) => ({ fieldId, field: linked[i] }))}
          getId={(item) => item.fieldId}
          getLabel={(item) => labelOf(item.fieldId)}
          onReorder={(next) => onChange(next)}
          itemClassName="py-2"
          renderItem={(item) => (
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  <span className="truncate">{labelOf(item.fieldId)}</span>
                  {item.field && !item.field.isActive ? <ArchivedBadge /> : null}
                </span>
                {item.field ? (
                  <span className="truncate text-xs text-ink-muted">
                    {tTypes(item.field.type as never)}
                    {item.field.required ? ` · ${t('required')}` : ''}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('remove', { label: labelOf(item.fieldId) })}
                onClick={() => onChange(value.filter((v) => v !== item.fieldId))}
                className="size-8 shrink-0"
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          )}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={adding}
          onValueChange={(fieldId) => {
            setAdding('');
            if (fieldId && !value.includes(fieldId)) onChange([...value, fieldId]);
          }}
          disabled={addable.length === 0 || value.length >= CATEGORY_FIELDS_MAX}
        >
          <SelectTrigger
            aria-label={t('add')}
            className={cn('w-full sm:w-72', addable.length === 0 && 'text-ink-muted')}
          >
            <SelectValue placeholder={addable.length ? t('add') : t('noneToAdd')} />
          </SelectTrigger>
          <SelectContent position="popper">
            {addable.map((field) => (
              <SelectItem key={field.id} value={field.id}>
                {localizedLabel(field, locale)} · {tTypes(field.type as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-[13px] font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
