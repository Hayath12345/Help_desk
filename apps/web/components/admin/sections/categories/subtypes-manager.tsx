'use client';

import {
  ADMIN_LIMITS,
  type CategoryAdminDto,
  type Locale,
  type Priority,
  type SubtypeAdminDto,
} from '@loons/shared';
import { Pencil, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  ArchivedBadge,
  BilingualField,
  InlineEditor,
  ReorderList,
  useListFocus,
} from '@/components/admin/kit';
import { Kicker } from '@/components/common/kicker';
import { PriorityPill } from '@/components/common/priority';
import { Button } from '@/components/ui/button';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { isStaleConflict, useAdminMutation } from '@/lib/admin';
import { localizedLabel } from '@/lib/tickets/labels';
import { categoriesApi } from './data';
import { PrioritySelect, useSetupMessage, useWriteErrorHandler } from './setup-shared';

// Sub-types of a category, managed inside its sheet (spec §10.1): each change is saved on its own
// (add, rename / default priority, archive / restore, reorder), independently of the category's
// Save. Archived sub-types keep their place for old tickets and can be restored. Keyboard focus:
// the editor takes it when it opens and gives it back to Add / Edit when it closes; archiving a
// sub-type moves it to the next sub-type's Archive button (or the heading when none is left).

interface Draft {
  labelEn: string;
  labelAr: string;
  defaultPriority: Priority;
}

const EMPTY: Draft = { labelEn: '', labelAr: '', defaultPriority: 'P3' };

export function SubtypesManager({ category }: { category: CategoryAdminDto }) {
  const t = useTranslations('admin-setup.categories.subtypes');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const writeError = useWriteErrorHandler();
  const headingId = useId();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const active = category.subtypes.filter((s) => s.isActive);
  const archived = category.subtypes.filter((s) => !s.isActive);
  const label = (s: SubtypeAdminDto) => localizedLabel(s, locale);
  const { attach: attachList, ...listFocus } = useListFocus(
    active.map((s) => s.id),
    { fallback: () => document.getElementById(headingId) },
  );
  const addButton = () => listFocus.control('add');
  const editButton = (id: string) => () => listFocus.control('edit', id) ?? addButton();

  const onError = (error: unknown) => {
    const text = isStaleConflict(error)
      ? tKit('conflictTitle')
      : writeError(error, () => undefined, []);
    if (text) toast.error(text);
  };

  const reorder = useAdminMutation<{ ids: string[]; expectedIds: string[] }, unknown>({
    section: 'categories',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: (body) => categoriesApi.reorderSubtypes(category.id, body),
    success: tKit('toast.reordered'),
    onError,
  });

  const setActive = useAdminMutation<
    { subtype: SubtypeAdminDto; active: boolean },
    SubtypeAdminDto
  >({
    section: 'categories',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: ({ subtype, active: next }) =>
      categoriesApi.setSubtypeActive(category.id, subtype.id, next, subtype.updatedAt),
    success: (row, { active: next }) =>
      tKit(next ? 'toast.restored' : 'toast.archived', { label: row.labelEn }),
    onError: (error) => {
      listFocus.cancelRemoval();
      onError(error);
    },
  });

  return (
    <section
      ref={attachList}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 border-t border-divider pt-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <Kicker
            as="h3"
            id={headingId}
            tabIndex={-1}
            className="outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand"
          >
            {t('title')}
          </Kicker>
          <p className="text-[13px] text-ink-secondary">{t('hint')}</p>
        </div>
        {editing !== 'new' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-list-control="add"
            onClick={() => setEditing('new')}
          >
            <Plus aria-hidden="true" />
            {t('add')}
          </Button>
        ) : null}
      </div>

      {editing === 'new' ? (
        <SubtypeEditor
          categoryId={category.id}
          onDone={() => setEditing(null)}
          returnFocus={addButton}
          submitLabel={t('addSubmit')}
        />
      ) : null}

      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-ink-muted">
          {t('noneActive')}
        </p>
      ) : (
        <ReorderList
          label={t('title')}
          items={active}
          getId={(s) => s.id}
          getLabel={label}
          disabled={reorder.isPending}
          onReorder={(ids, expectedIds) => reorder.mutateAsync({ ids, expectedIds })}
          itemClassName="py-2"
          renderItem={(subtype) =>
            editing === subtype.id ? (
              <SubtypeEditor
                categoryId={category.id}
                subtype={subtype}
                onDone={() => setEditing(null)}
                returnFocus={editButton(subtype.id)}
                submitLabel={tKit('save')}
              />
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-ink">{label(subtype)}</span>
                  <span dir="ltr" className="w-fit truncate font-mono text-xs text-ink-muted">
                    {subtype.key}
                  </span>
                </div>
                <PriorityPill priority={subtype.defaultPriority} withDot />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('edit', { label: label(subtype) })}
                  data-list-control="edit"
                  data-row-id={subtype.id}
                  onClick={() => setEditing(subtype.id)}
                >
                  <Pencil aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('archive', { label: label(subtype) })}
                  data-list-control="archive"
                  aria-disabled={setActive.isPending || undefined}
                  onClick={() => {
                    if (setActive.isPending) return;
                    listFocus.expectRemoval(subtype.id, 'archive');
                    setActive.mutate({ subtype, active: false });
                  }}
                >
                  {tKit('archive')}
                </Button>
              </div>
            )
          }
        />
      )}

      {archived.length ? (
        <ul
          aria-label={t('archivedTitle')}
          className="flex flex-col divide-y divide-divider rounded-lg border border-line"
        >
          {archived.map((subtype) => (
            <li
              key={subtype.id}
              className="flex flex-wrap items-center gap-2 bg-surface-muted px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                {label(subtype)}
              </span>
              <ArchivedBadge />
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t('restore', { label: label(subtype) })}
                disabled={setActive.isPending}
                onClick={() => setActive.mutate({ subtype, active: true })}
              >
                {tKit('restore')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Add a sub-type, or edit one (labels + default priority), inline. */
function SubtypeEditor({
  categoryId,
  subtype,
  onDone,
  returnFocus,
  submitLabel,
}: {
  categoryId: string;
  subtype?: SubtypeAdminDto;
  onDone: () => void;
  /** The Add / Edit button that opened the editor (focus goes back there). */
  returnFocus: () => HTMLElement | null | undefined;
  submitLabel: string;
}) {
  const t = useTranslations('admin-setup.categories');
  const tKit = useTranslations('admin.kit');
  const tPriority = useTranslations('common.priority');
  const message = useSetupMessage();
  const writeError = useWriteErrorHandler();
  const id = useId();
  const [initial] = useState<Draft>(() =>
    subtype
      ? {
          labelEn: subtype.labelEn,
          labelAr: subtype.labelAr,
          defaultPriority: subtype.defaultPriority,
        }
      : EMPTY,
  );
  // The version the editor opened on (E19): the save sends its `updatedAt` and only what the
  // admin changed since, so a concurrent change answers 409 instead of being written back.
  const [base] = useState(subtype);
  const [draft, setDraft] = useState<Draft>(initial);
  const dirty =
    draft.labelEn !== initial.labelEn ||
    draft.labelAr !== initial.labelAr ||
    draft.defaultPriority !== initial.defaultPriority;
  const [errors, setErrors] = useState<{ labelEn?: string; labelAr?: string; form?: string }>({});

  const save = useAdminMutation<Draft, SubtypeAdminDto>({
    section: 'categories',
    scopes: ['ticket-form'],
    errorToast: false,
    mutationFn: (value) => {
      if (!base) return categoriesApi.createSubtype(categoryId, value);
      const patch: Record<string, unknown> = { expectedUpdatedAt: base.updatedAt };
      if (value.labelEn !== initial.labelEn) patch.labelEn = value.labelEn;
      if (value.labelAr !== initial.labelAr) patch.labelAr = value.labelAr;
      if (value.defaultPriority !== initial.defaultPriority) {
        patch.defaultPriority = value.defaultPriority;
      }
      return categoriesApi.updateSubtype(categoryId, base.id, patch);
    },
    success: (row) =>
      subtype ? tKit('toast.saved') : tKit('toast.created', { label: row.labelEn }),
    onSuccess: onDone,
    onError: (error) => {
      if (isStaleConflict(error)) {
        setErrors({ form: `${tKit('conflictTitle')}. ${tKit('conflictBody')}` });
        return;
      }
      if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
        const next: typeof errors = {};
        for (const issue of validationIssues(error)) {
          const field = issue.path[0];
          if (field === 'labelEn' || field === 'labelAr') next[field] = message(issue.message);
          else next.form = message(issue.message);
        }
        setErrors(next);
        return;
      }
      setErrors({ form: writeError(error, () => undefined, []) ?? undefined });
    },
  });

  const submit = () => {
    if (draft.labelEn.trim() === '') {
      setErrors({ labelEn: message('validation.required') });
      return;
    }
    if (base && !dirty) {
      onDone();
      return;
    }
    setErrors({});
    save.mutate(draft);
  };

  return (
    <InlineEditor
      aria-label={subtype ? t('subtypes.editTitle') : t('subtypes.addTitle')}
      dirty={dirty && !save.isSuccess}
      onCancel={onDone}
      returnFocus={returnFocus}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          submit();
        }
      }}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <BilingualField
        id={`${id}-name`}
        label={t('subtypeName')}
        required
        maxLength={ADMIN_LIMITS.labelMax}
        valueEn={draft.labelEn}
        valueAr={draft.labelAr}
        onChangeEn={(labelEn) => setDraft((d) => ({ ...d, labelEn }))}
        onChangeAr={(labelAr) => setDraft((d) => ({ ...d, labelAr }))}
        errorEn={errors.labelEn}
        errorAr={errors.labelAr}
      />
      <PrioritySelect
        id={`${id}-priority`}
        label={t('defaultPriority')}
        value={draft.defaultPriority}
        onChange={(defaultPriority) => setDraft((d) => ({ ...d, defaultPriority }))}
        tPriority={tPriority}
      />
      {errors.form ? (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {errors.form}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {tKit('cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          aria-busy={save.isPending || undefined}
          onClick={() => {
            if (!save.isPending) submit();
          }}
        >
          {save.isPending ? tKit('saving') : submitLabel}
        </Button>
      </div>
    </InlineEditor>
  );
}
