'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { adminKeySchema, labelArSchema, labelEnSchema, type SkillAdminDto } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { AdminSheet, KeyField, RhfBilingualField } from '@/components/admin/kit';
import { Button } from '@/components/ui/button';
import {
  adminConflictDetails,
  applyServerIssues,
  isStaleConflict,
  useAdminMutation,
} from '@/lib/admin';
import { isApiRequestError } from '@/lib/api/errors';
import { isolate } from '@/lib/format';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { usePeopleValidation } from '../teams/people';
import { skillsApi } from './data';

// The skill sheet: English name (required), Arabic name (optional) and the key (generated from the
// English name, read-only once created). Edits send only the changed labels with the
// `expectedUpdatedAt` they started from (E19). A duplicate English name or key (409) lands on the
// field; when the skill that holds it is archived, creating offers to restore that one instead.

const formSchema = z.object({
  labelEn: labelEnSchema,
  labelAr: labelArSchema,
  key: z.union([z.literal(''), adminKeySchema]),
});

export type SkillFormValues = z.infer<typeof formSchema>;

/** API issue paths the form shows (others become a form-level message). */
const FORM_PATHS = ['labelEn', 'labelAr', 'key'];

/** Field-error messages this sheet writes itself (i18n keys under `admin-people.skills.errors`). */
const LOCAL_ERROR = 'skills.errors.';
type LocalError =
  'duplicateLabel' | 'duplicateLabelArchived' | 'duplicateKey' | 'duplicateKeyArchived';

function valuesOf(skill: SkillAdminDto | undefined): SkillFormValues {
  return {
    labelEn: skill?.labelEn ?? '',
    labelAr: skill?.labelAr ?? '',
    key: skill?.key ?? '',
  };
}

/** The PATCH body for what changed since `base` (null when nothing did). The key never changes. */
export function skillPatch(
  base: SkillAdminDto,
  values: SkillFormValues,
): { labelEn?: string; labelAr?: string } | null {
  const patch: { labelEn?: string; labelAr?: string } = {};
  if (values.labelEn !== base.labelEn) patch.labelEn = values.labelEn;
  if (values.labelAr !== base.labelAr) patch.labelAr = values.labelAr;
  return Object.keys(patch).length ? patch : null;
}

/** The archived skill a refused create collided with, while the colliding field is unchanged. */
interface ArchivedMatch {
  id: string;
  field: 'labelEn' | 'key';
  value: string;
}

export interface SkillSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skill being edited; omitted when creating. */
  skill?: SkillAdminDto;
  /** Every skill, archived included: key suggestions, and the archived skill a duplicate hit. */
  skills: readonly SkillAdminDto[];
  /** Reload the list after a stale save (E19); resolves to the skill's newest version. */
  reload: () => Promise<SkillAdminDto | undefined>;
}

export function SkillSheet({ open, onOpenChange, skill, skills, reload }: SkillSheetProps) {
  const t = useTranslations('admin-people.skills');
  const tKit = useTranslations('admin.kit');
  const validation = usePeopleValidation();
  const apiErrorText = useApiErrorText();
  const formId = useId();
  const mode = skill ? 'edit' : 'create';
  // The version the edit started from: the save diffs against it and sends its `updatedAt`, so a
  // change made by someone else meanwhile answers 409 instead of being written back.
  const [base, setBase] = useState<SkillAdminDto | undefined>(skill);
  const [formError, setFormError] = useState<string | null>(null);
  const [archivedMatch, setArchivedMatch] = useState<ArchivedMatch | null>(null);
  // The key follows the English name until the admin types one. While it does, the API generates
  // it (and adds a suffix on a collision) instead of trusting the suggestion.
  const [keyFollowing, setKeyFollowing] = useState(true);

  const form = useForm<SkillFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: valuesOf(skill),
  });
  const [labelEn, keyValue] = useWatch({ control: form.control, name: ['labelEn', 'key'] });

  const errorText = (message?: string) => {
    if (!message) return undefined;
    if (message.startsWith(LOCAL_ERROR)) {
      return t(`errors.${message.slice(LOCAL_ERROR.length) as LocalError}`);
    }
    return validation(message);
  };

  /** A refused write → field errors; returns the form-level message (null when none is needed). */
  const describeError = (error: unknown): string | null => {
    setArchivedMatch(null);
    if (isStaleConflict(error)) return null;
    if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
      return applyServerIssues(error, form.setError, { paths: FORM_PATHS }) > 0
        ? null
        : t('errors.checkForm');
    }
    const details = adminConflictDetails(error);
    const field = details?.fields?.find(
      (f): f is 'labelEn' | 'key' => f === 'labelEn' || f === 'key',
    );
    if (details?.reason === 'duplicate' && field) {
      const archived = details.existingIsActive === false;
      const name: LocalError = archived
        ? field === 'labelEn'
          ? 'duplicateLabelArchived'
          : 'duplicateKeyArchived'
        : field === 'labelEn'
          ? 'duplicateLabel'
          : 'duplicateKey';
      form.setError(
        field,
        { type: 'server', message: `${LOCAL_ERROR}${name}` },
        { shouldFocus: true },
      );
      if (archived && details.existingId) {
        setArchivedMatch({ id: details.existingId, field, value: form.getValues(field) });
      }
      return null;
    }
    return apiErrorText(error);
  };

  const save = useAdminMutation<SkillFormValues, SkillAdminDto>({
    section: 'skills',
    scopes: ['skills'],
    errorToast: false,
    mutationFn: async (values) => {
      if (!base) {
        return skillsApi.create({
          ...(keyFollowing || !values.key ? {} : { key: values.key }),
          labelEn: values.labelEn,
          labelAr: values.labelAr,
        });
      }
      return skillsApi.update(base.id, {
        ...skillPatch(base, values),
        expectedUpdatedAt: base.updatedAt,
      });
    },
    success: (row, values) =>
      base
        ? tKit('toast.saved')
        : values.key && row.key !== values.key
          ? // The key box showed a suggestion; the API added a suffix because something else took
            // it meanwhile: say which key the skill got.
            tKit('toast.createdWithKey', { label: row.labelEn, key: row.key })
          : tKit('toast.created', { label: row.labelEn }),
    onSuccess: () => onOpenChange(false),
    onError: (error) => setFormError(describeError(error)),
  });

  const setActive = useAdminMutation<boolean, SkillAdminDto>({
    section: 'skills',
    scopes: ['skills'],
    errorToast: false,
    mutationFn: (active) => skillsApi.setActive(base!.id, active, base!.updatedAt),
    success: (row, active) =>
      tKit(active ? 'toast.restored' : 'toast.archived', { label: row.labelEn }),
    onSuccess: (row) => {
      setBase(row);
      if (!row.isActive) onOpenChange(false);
    },
    onError: (error) => setFormError(describeError(error)),
  });

  // "Restore it instead": the archived skill the new name or key collided with.
  const restoreExisting = useAdminMutation<SkillAdminDto, SkillAdminDto>({
    section: 'skills',
    scopes: ['skills'],
    // Nothing else on screen would show a refused restore (a stale one included).
    errorToast: true,
    mutationFn: (row) => skillsApi.setActive(row.id, true, row.updatedAt),
    success: (row) => tKit('toast.restored', { label: row.labelEn }),
    onSuccess: () => onOpenChange(false),
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
    setArchivedMatch(null);
    // Nothing changed: there is nothing to send (and nothing to report).
    if (base && !skillPatch(base, values)) {
      onOpenChange(false);
      return;
    }
    save.mutate(values);
  });

  const takenKeys = skills.map((row) => row.key);
  // The collision note stays only while the colliding value is unchanged.
  const matchedRow =
    mode === 'create' &&
    archivedMatch &&
    (archivedMatch.field === 'labelEn' ? labelEn : keyValue) === archivedMatch.value
      ? skills.find((row) => row.id === archivedMatch.id)
      : undefined;
  const restoreOffer = matchedRow ? (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={restoreExisting.isPending || undefined}
        aria-busy={restoreExisting.isPending || undefined}
        onClick={() => {
          if (!restoreExisting.isPending) restoreExisting.mutate(matchedRow);
        }}
      >
        {t('restoreExisting', { label: isolate(matchedRow.labelEn) })}
      </Button>
    </div>
  ) : null;

  return (
    <AdminSheet
      open={open}
      onOpenChange={onOpenChange}
      mode={mode}
      title={
        mode === 'create' ? t('createTitle') : t('editTitle', { name: isolate(skill!.labelEn) })
      }
      description={mode === 'create' ? t('createDescription') : undefined}
      dirty={form.formState.isDirty}
      archived={base ? !base.isActive : false}
      formId={formId}
      saving={save.isPending}
      onArchive={base ? () => setActive.mutate(false) : undefined}
      archiving={setActive.isPending && setActive.variables === false}
      onRestore={base ? () => setActive.mutate(true) : undefined}
      restoring={setActive.isPending && setActive.variables === true}
      itemLabel={base ? isolate(base.labelEn) : undefined}
      archiveWarning={
        base
          ? t('archiveWarning', { staff: base.staffCount, categories: base.categoryCount })
          : undefined
      }
      conflict={save.isConflict || setActive.isConflict}
      onReload={onReload}
      error={formError}
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-2.5">
          <RhfBilingualField
            id={`${formId}-name`}
            label={t('form.name')}
            required
            hint={t('form.nameHint')}
            maxLength={120}
            control={form.control}
            nameEn="labelEn"
            nameAr="labelAr"
            errorText={errorText}
          />
          {matchedRow && archivedMatch?.field === 'labelEn' ? restoreOffer : null}
        </div>
        <div className="flex flex-col gap-2.5">
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
                source={labelEn}
                takenKeys={takenKeys}
                onFollowingChange={setKeyFollowing}
                error={errorText(fieldState.error?.message)}
              />
            )}
          />
          {matchedRow && archivedMatch?.field === 'key' ? restoreOffer : null}
        </div>
      </form>
    </AdminSheet>
  );
}
