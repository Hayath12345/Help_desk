'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADMIN_KEY_PATTERN,
  ADMIN_LIMITS,
  CUSTOM_FIELD_LIMITS,
  CUSTOM_FIELD_TYPES,
  customFieldOptionsProblem,
  hasOptions,
  slugifyKey,
  type CategoryAdminDto,
  type CustomFieldAdminDto,
  type CustomFieldType,
  type Locale,
} from '@loons/shared';
import { Plus, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import {
  Controller,
  useFieldArray,
  useForm,
  useFormState,
  useWatch,
  type Control,
  type UseFormSetValue,
} from 'react-hook-form';
import { z } from 'zod';
import {
  AdminSheet,
  ArchivedBadge,
  BilingualField,
  KeyField,
  RhfBilingualField,
} from '@/components/admin/kit';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAdminMutation } from '@/lib/admin';
import { localizedLabel } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import { useSetupMessage, useWriteErrorHandler } from '../categories/setup-shared';
import { customFieldsApi } from './data';

// The custom-field sheet (spec §10.2; E4, E5, E6): name EN/AR, key (`_` separated, editable while
// creating only), type (changes only while no ticket holds a value — the API says so), options
// for dropdowns and multi-selects (each archived on its own; an option a ticket holds can't be
// removed), placeholder EN/AR, required, and the categories it appears in (its position within a
// category is set in the category's sheet).

const text = (max: number) => z.string().max(max, { error: 'validation.tooLong' });

const optionSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .regex(ADMIN_KEY_PATTERN, { error: 'validation.keyFormat' }),
  labelEn: text(ADMIN_LIMITS.labelMax).refine((v) => v.trim() !== '', {
    error: 'validation.required',
  }),
  labelAr: text(ADMIN_LIMITS.labelMax),
  isActive: z.boolean(),
  /** Stored already (its value can't be edited any more). */
  saved: z.boolean(),
});

const formSchema = z
  .object({
    labelEn: text(ADMIN_LIMITS.labelMax).refine((v) => v.trim() !== '', {
      error: 'validation.required',
    }),
    labelAr: text(ADMIN_LIMITS.labelMax),
    key: z.string().refine((v) => v === '' || ADMIN_KEY_PATTERN.test(v), {
      error: 'validation.keyFormat',
    }),
    type: z.enum(CUSTOM_FIELD_TYPES),
    placeholderEn: text(CUSTOM_FIELD_LIMITS.placeholderMax),
    placeholderAr: text(CUSTOM_FIELD_LIMITS.placeholderMax),
    required: z.boolean(),
    options: z.array(optionSchema).max(CUSTOM_FIELD_LIMITS.optionsMax),
    categoryIds: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    if (!hasOptions(value.type)) return;
    const problem = customFieldOptionsProblem(value.type, value.options);
    if (problem) ctx.addIssue({ code: 'custom', path: ['options'], message: problem });
    const seen = new Set<string>();
    value.options.forEach((option, i) => {
      if (seen.has(option.value)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', i, 'value'],
          message: 'validation.duplicateValue',
        });
      }
      seen.add(option.value);
    });
  });

export type FieldFormValues = z.infer<typeof formSchema>;

function valuesOf(field: CustomFieldAdminDto | undefined): FieldFormValues {
  return {
    labelEn: field?.labelEn ?? '',
    labelAr: field?.labelAr ?? '',
    key: field?.key ?? '',
    type: field?.type ?? 'TEXT',
    placeholderEn: field?.placeholderEn ?? '',
    placeholderAr: field?.placeholderAr ?? '',
    required: field?.required ?? false,
    options: (field?.options ?? []).map((o) => ({ ...o, saved: true })),
    categoryIds: field?.categories.map((c) => c.id) ?? [],
  };
}

const optionsOut = (options: FieldFormValues['options']) =>
  options.map(({ value, labelEn, labelAr, isActive }) => ({ value, labelEn, labelAr, isActive }));

const orNull = (value: string) => (value.trim() === '' ? null : value);

/** The PATCH body for what changed since `base` (null when nothing did). */
export function fieldPatch(
  base: CustomFieldAdminDto,
  values: FieldFormValues,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (values.labelEn !== base.labelEn) patch.labelEn = values.labelEn;
  if (values.labelAr !== base.labelAr) patch.labelAr = values.labelAr;
  if (values.type !== base.type) patch.type = values.type;
  if (orNull(values.placeholderEn) !== base.placeholderEn)
    patch.placeholderEn = values.placeholderEn;
  if (orNull(values.placeholderAr) !== base.placeholderAr)
    patch.placeholderAr = values.placeholderAr;
  if (values.required !== base.required) patch.required = values.required;
  if (hasOptions(values.type)) {
    const next = optionsOut(values.options);
    if (JSON.stringify(next) !== JSON.stringify(base.options)) patch.options = next;
  }
  const before = base.categories
    .map((c) => c.id)
    .sort()
    .join();
  if ([...values.categoryIds].sort().join() !== before) patch.categoryIds = values.categoryIds;
  return Object.keys(patch).length ? patch : null;
}

export interface FieldSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  field?: CustomFieldAdminDto;
  takenKeys: readonly string[];
  categories: readonly CategoryAdminDto[];
  reload: () => Promise<CustomFieldAdminDto | undefined>;
}

export function FieldSheet({
  open,
  onOpenChange,
  field,
  takenKeys,
  categories,
  reload,
}: FieldSheetProps) {
  const t = useTranslations('admin-setup.customFields');
  const tTypes = useTranslations('admin-setup.fieldTypes');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const message = useSetupMessage();
  const writeError = useWriteErrorHandler();
  const formId = useId();
  const mode = field ? 'edit' : 'create';
  const [base, setBase] = useState<CustomFieldAdminDto | undefined>(field);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<FieldFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(field),
  });
  const type = useWatch({ control: form.control, name: 'type' });
  const labelEn = useWatch({ control: form.control, name: 'labelEn' });
  const optionCount = useWatch({ control: form.control, name: 'options' }).length;
  const errorText = (m?: string) => message(m);
  const paths = [
    'labelEn',
    'labelAr',
    'key',
    'type',
    'placeholderEn',
    'placeholderAr',
    'required',
    'options',
    'categoryIds',
    ...Array.from({ length: optionCount }, (_, i) => [
      `options.${i}.value`,
      `options.${i}.labelEn`,
      `options.${i}.labelAr`,
    ]).flat(),
  ];

  const save = useAdminMutation<FieldFormValues, CustomFieldAdminDto | null>({
    section: 'custom-fields',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: async (values) => {
      if (!base) {
        return customFieldsApi.create({
          key: values.key || undefined,
          labelEn: values.labelEn,
          labelAr: values.labelAr,
          type: values.type,
          options: hasOptions(values.type) ? optionsOut(values.options) : [],
          placeholderEn: values.placeholderEn,
          placeholderAr: values.placeholderAr,
          required: values.required,
          categoryIds: values.categoryIds,
        });
      }
      const patch = fieldPatch(base, values);
      if (!patch) return null;
      const row = await customFieldsApi.update(base.id, {
        ...patch,
        expectedUpdatedAt: base.updatedAt,
      });
      setBase(row);
      return row;
    },
    success: (row, values) =>
      base ? tKit('toast.saved') : tKit('toast.created', { label: row?.labelEn ?? values.labelEn }),
    onSuccess: () => onOpenChange(false),
    onError: (error) => setFormError(writeError(error, form.setError, paths)),
  });

  const setActive = useAdminMutation<boolean, CustomFieldAdminDto>({
    section: 'custom-fields',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: (active) => customFieldsApi.setActive(base!.id, active, base!.updatedAt),
    success: (row, active) =>
      tKit(active ? 'toast.restored' : 'toast.archived', { label: row.labelEn }),
    onSuccess: (row) => {
      setBase(row);
      if (!row.isActive) onOpenChange(false);
    },
    onError: (error) => setFormError(writeError(error, form.setError, paths)),
  });

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

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    save.mutate(values);
  });

  // Categories offered: active ones, plus archived ones it is still linked to.
  const linked = new Set(field?.categories.map((c) => c.id) ?? []);
  const categoryChoices = categories.filter((c) => c.isActive || linked.has(c.id));

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      title={mode === 'create' ? t('createTitle') : localizedLabel(field!, locale)}
      description={mode === 'create' ? t('createDescription') : undefined}
      dirty={form.formState.isDirty}
      archived={base ? !base.isActive : false}
      formId={formId}
      saving={save.isPending}
      onArchive={base ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={base ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={base ? localizedLabel(base, locale) : undefined}
      archiveWarning={t('archiveWarning')}
      conflict={save.isConflict || setActive.isConflict}
      onReload={onReload}
      error={formError}
    >
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
          render={({ field: key, fieldState }) => (
            <KeyField
              id={`${formId}-key`}
              mode={mode}
              value={key.value}
              onChange={key.onChange}
              onBlur={key.onBlur}
              inputRef={key.ref}
              source={labelEn}
              takenKeys={takenKeys}
              separator="_"
              error={errorText(fieldState.error?.message)}
            />
          )}
        />
        <Controller
          control={form.control}
          name="type"
          render={({ field: typeField, fieldState }) => {
            const id = `${formId}-type`;
            const error = errorText(fieldState.error?.message);
            return (
              <FormField
                id={id}
                label={t('type')}
                required
                hint={mode === 'edit' ? t('typeHintEdit') : t('typeHint')}
                error={error}
              >
                <Select
                  value={typeField.value}
                  onValueChange={(next) => typeField.onChange(next as CustomFieldType)}
                >
                  <SelectTrigger
                    {...fieldA11y(id, { error, hint: true })}
                    ref={typeField.ref}
                    className="w-full sm:w-72"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {CUSTOM_FIELD_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {tTypes(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            );
          }}
        />
        {hasOptions(type) ? (
          <OptionsEditor control={form.control} setValue={form.setValue} formId={formId} />
        ) : null}
        <Controller
          control={form.control}
          name="placeholderEn"
          render={({ field: en, fieldState: enState }) => (
            <Controller
              control={form.control}
              name="placeholderAr"
              render={({ field: ar, fieldState: arState }) => (
                <BilingualField
                  id={`${formId}-placeholder`}
                  label={t('placeholder')}
                  hint={t('placeholderHint')}
                  maxLength={CUSTOM_FIELD_LIMITS.placeholderMax}
                  valueEn={en.value}
                  valueAr={ar.value}
                  onChangeEn={en.onChange}
                  onChangeAr={ar.onChange}
                  onBlurEn={en.onBlur}
                  onBlurAr={ar.onBlur}
                  refEn={en.ref}
                  refAr={ar.ref}
                  errorEn={errorText(enState.error?.message)}
                  errorAr={errorText(arState.error?.message)}
                />
              )}
            />
          )}
        />
        <Controller
          control={form.control}
          name="required"
          render={({ field: required }) => (
            <div className="flex items-start gap-3">
              <Switch
                id={`${formId}-required`}
                checked={required.value}
                onCheckedChange={required.onChange}
                aria-describedby={`${formId}-required-hint`}
                className="mt-1"
              />
              <div className="flex flex-col gap-0.5">
                <label
                  htmlFor={`${formId}-required`}
                  className="cursor-pointer font-medium text-ink"
                >
                  {t('required')}
                </label>
                <span id={`${formId}-required-hint`} className="text-[13px] text-ink-secondary">
                  {t('requiredHint')}
                </span>
              </div>
            </div>
          )}
        />
        <Controller
          control={form.control}
          name="categoryIds"
          render={({ field: ids, fieldState }) => (
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium text-ink">{t('categories')}</legend>
              <p className="text-[13px] text-ink-secondary">{t('categoriesHint')}</p>
              {categoryChoices.length === 0 ? (
                <p className="text-[13px] text-ink-muted">{t('noCategories')}</p>
              ) : (
                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {categoryChoices.map((category) => {
                    const id = `${formId}-cat-${category.id}`;
                    const checked = ids.value.includes(category.id);
                    return (
                      <label
                        key={category.id}
                        htmlFor={id}
                        className="flex min-w-0 items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(next) =>
                            ids.onChange(
                              next === true
                                ? [...ids.value, category.id]
                                : ids.value.filter((v) => v !== category.id),
                            )
                          }
                        />
                        <span className="truncate">{localizedLabel(category, locale)}</span>
                        {!category.isActive ? <ArchivedBadge /> : null}
                      </label>
                    );
                  })}
                </div>
              )}
              {fieldState.error ? (
                <p className="text-[13px] font-medium text-danger">
                  {errorText(fieldState.error.message)}
                </p>
              ) : null}
            </fieldset>
          )}
        />
      </form>
    </AdminSheet>
  );
}

/**
 * Dropdown / multi-select options: value (a key, fixed once saved), English and Arabic labels,
 * archive / restore per option, remove, add.
 */
function OptionsEditor({
  control,
  setValue,
  formId,
}: {
  control: Control<FieldFormValues>;
  setValue: UseFormSetValue<FieldFormValues>;
  formId: string;
}) {
  const t = useTranslations('admin-setup.customFields.options');
  const tKit = useTranslations('admin.kit');
  const message = useSetupMessage();
  const { fields, append, remove } = useFieldArray({ control, name: 'options' });
  // setValue (not the field array's update) keeps each row mounted, so focus stays put.
  const setActive = (index: number, isActive: boolean) =>
    setValue(`options.${index}.isActive`, isActive, { shouldDirty: true });
  const setOptionValue = (index: number, value: string) =>
    setValue(`options.${index}.value`, value, { shouldDirty: true });
  const options = useWatch({ control, name: 'options' });
  const { errors } = useFormState({ control, name: 'options' });
  // The list's own problem (none active, none at all), from zod or from the API.
  const listError = errors.options?.message ?? errors.options?.root?.message;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="font-medium text-ink">
        {t('title')}
        <span aria-hidden="true" className="text-danger">
          {' *'}
        </span>
      </legend>
      <p className="text-[13px] text-ink-secondary">{t('hint')}</p>
      <ol className="flex flex-col gap-3">
        {fields.map((row, index) => {
          const option = options[index] ?? row;
          const id = `${formId}-opt-${index}`;
          return (
            <li
              key={row.id}
              aria-label={t('item', { n: index + 1 })}
              className={cn(
                'flex flex-col gap-2.5 rounded-lg border border-line p-3',
                !option.isActive && 'bg-surface-muted',
              )}
            >
              <div className="flex flex-wrap items-end gap-2">
                <Controller
                  control={control}
                  name={`options.${index}.value`}
                  render={({ field: value, fieldState: valueState }) => {
                    const error = message(valueState.error?.message);
                    return (
                      <FormField
                        id={`${id}-value`}
                        label={t('value')}
                        error={error}
                        className="min-w-40 flex-1"
                      >
                        <Input
                          {...fieldA11y(`${id}-value`, { error })}
                          ref={value.ref}
                          value={value.value}
                          readOnly={option.saved}
                          aria-readonly={option.saved || undefined}
                          dir="ltr"
                          spellCheck={false}
                          autoComplete="off"
                          maxLength={64}
                          onBlur={value.onBlur}
                          onChange={(event) => value.onChange(event.target.value.toLowerCase())}
                          className={cn(
                            'font-mono',
                            option.saved && 'bg-surface-sunken text-ink-secondary',
                          )}
                        />
                      </FormField>
                    );
                  }}
                />
                {!option.isActive ? <ArchivedBadge className="mb-2" /> : null}
                <div className="ms-auto flex items-center gap-1.5">
                  {option.saved ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t(option.isActive ? 'archive' : 'restore', {
                        label: option.labelEn || option.value,
                      })}
                      onClick={() => setActive(index, !option.isActive)}
                    >
                      {option.isActive ? tKit('archive') : tKit('restore')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('remove', { label: option.labelEn || option.value || index + 1 })}
                    onClick={() => remove(index)}
                    className="size-8"
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <Controller
                control={control}
                name={`options.${index}.labelEn`}
                render={({ field: en, fieldState: enState }) => (
                  <Controller
                    control={control}
                    name={`options.${index}.labelAr`}
                    render={({ field: ar, fieldState: arState }) => (
                      <BilingualField
                        id={`${id}-label`}
                        label={t('label')}
                        required
                        maxLength={ADMIN_LIMITS.labelMax}
                        valueEn={en.value}
                        valueAr={ar.value}
                        onChangeEn={en.onChange}
                        onChangeAr={ar.onChange}
                        onBlurEn={() => {
                          en.onBlur();
                          // A new option's value follows its English label until typed.
                          if (!option.saved && option.value === '') {
                            const suggested = slugifyKey(en.value, { separator: '_' });
                            if (suggested) setOptionValue(index, suggested);
                          }
                        }}
                        onBlurAr={ar.onBlur}
                        refEn={en.ref}
                        refAr={ar.ref}
                        errorEn={message(enState.error?.message)}
                        errorAr={message(arState.error?.message)}
                      />
                    )}
                  />
                )}
              />
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={fields.length >= CUSTOM_FIELD_LIMITS.optionsMax}
        onClick={() =>
          append({ value: '', labelEn: '', labelAr: '', isActive: true, saved: false })
        }
      >
        <Plus aria-hidden="true" />
        {t('add')}
      </Button>
      {listError ? (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {message(listError)}
        </p>
      ) : null}
    </fieldset>
  );
}
