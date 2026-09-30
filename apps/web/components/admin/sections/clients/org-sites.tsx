'use client';

import {
  ADMIN_LIMITS,
  siteResponseSchema,
  type OrganizationAdminDto,
  type SiteAdminDto,
} from '@loons/shared';
import { Archive, ArchiveRestore, Pencil } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminPath, adminWrite, useAdminMutation, withExpectedUpdatedAt } from '@/lib/admin';
import { placeName } from '@/lib/tickets/labels';
import { BilingualField, InlineEditor, ReorderList, useListFocus } from '../../kit';
import { usePeopleErrorText } from '../teams/people';

interface SiteDraft {
  /** null: a new site. */
  id: string | null;
  name: string;
  nameAr: string;
  address: string;
  /** The site's version when the editor opened (E19: an edit sends it, not a newer one). */
  updatedAt?: SiteAdminDto['updatedAt'];
}

const emptyDraft: SiteDraft = { id: null, name: '', nameAr: '', address: '' };

/**
 * The sites of an organisation inside its sheet (spec §10.7): add, rename, archive / restore and
 * reorder (drag or Move up / Move down). Each change is saved right away. The editor takes focus
 * when it opens and gives it back to Add / Edit; archiving a site moves focus to the next site's
 * Archive button (or the heading).
 */
export function OrgSites({ org }: { org: OrganizationAdminDto }) {
  const t = useTranslations('admin-people.clients.sites');
  const tKit = useTranslations('admin.kit');
  const tValidation = useTranslations('admin-people.validation');
  const locale = useLocale();
  const errorText = usePeopleErrorText();
  const id = useId();
  const [draft, setDraft] = useState<SiteDraft | null>(null);
  // What the editor started from (unsaved text = a difference; the sheet asks before closing).
  const [draftBase, setDraftBase] = useState<SiteDraft | null>(null);
  const openEditor = (next: SiteDraft) => {
    setDraft(next);
    setDraftBase(next);
  };
  const [nameError, setNameError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const active = org.sites.filter((s) => s.isActive);
  const archived = org.sites.filter((s) => !s.isActive);
  const orgName = placeName(org, locale);
  const { attach: attachList, ...listFocus } = useListFocus(
    active.map((s) => s.id),
    { fallback: () => document.getElementById(`${id}-title`) },
  );
  const { control } = listFocus;

  const common = {
    section: 'clients' as const,
    scopes: ['form-context' as const],
    errorToast: false,
    onError: (e: unknown) => setError(errorText(e)),
  };
  const saveSite = useAdminMutation({
    ...common,
    mutationFn: ({ id: siteId, body }: { id: string | null; body: Record<string, unknown> }) =>
      siteId === null
        ? adminWrite('POST', adminPath('clients', org.id, 'sites'), body, siteResponseSchema)
        : adminWrite(
            'PATCH',
            adminPath('clients', org.id, 'sites', siteId),
            body,
            siteResponseSchema,
          ),
    success: (result, v) => (v.id === null ? t('added', { name: result.item.name }) : t('saved')),
    onSuccess: () => {
      setDraft(null);
      setError(null);
    },
  });
  const draftDirty =
    draft !== null &&
    draftBase !== null &&
    (draft.name !== draftBase.name ||
      draft.nameAr !== draftBase.nameAr ||
      draft.address !== draftBase.address);
  const closeEditor = () => {
    setDraft(null);
    setNameError(undefined);
  };
  const setActive = useAdminMutation({
    ...common,
    mutationFn: ({ site, action }: { site: SiteAdminDto; action: 'archive' | 'restore' }) =>
      adminWrite(
        'POST',
        adminPath('clients', org.id, 'sites', site.id, action),
        withExpectedUpdatedAt({}, site),
        siteResponseSchema,
      ),
    success: (result, { action }) =>
      t(action === 'archive' ? 'archived' : 'restored', { name: result.item.name }),
    onSuccess: () => setError(null),
    onError: (e: unknown) => {
      listFocus.cancelRemoval();
      setError(errorText(e));
    },
  });
  const reorder = useAdminMutation({
    ...common,
    mutationFn: (body: { ids: string[]; expectedIds: string[] }) =>
      adminWrite('POST', adminPath('clients', org.id, 'sites', 'reorder'), body),
    success: tKit('toast.reordered'),
    onSuccess: () => setError(null),
  });
  const busy = saveSite.isPending || setActive.isPending || reorder.isPending;

  const submitDraft = () => {
    if (!draft || busy) return;
    if (draft.name.trim() === '') {
      setNameError(tValidation('required'));
      return;
    }
    setNameError(undefined);
    const fields = (d: SiteDraft) => ({
      name: d.name.trim(),
      nameAr: d.nameAr.trim(),
      address: d.address.trim() || null,
    });
    const next = fields(draft);
    if (draft.id === null || !draftBase) {
      saveSite.mutate({ id: null, body: next });
      return;
    }
    // Only what the admin changed, against the version the editor opened on (E19): a site
    // another admin changed meanwhile answers 409 instead of being written back.
    const before = fields(draftBase);
    const body: Record<string, unknown> = {};
    for (const key of ['name', 'nameAr', 'address'] as const) {
      if (next[key] !== before[key]) body[key] = next[key];
    }
    if (Object.keys(body).length === 0) {
      closeEditor();
      return;
    }
    saveSite.mutate({
      id: draft.id,
      body: withExpectedUpdatedAt(body, { updatedAt: draftBase.updatedAt! }),
    });
  };

  const editor = draft ? (
    <InlineEditor
      aria-labelledby={`${id}-editor`}
      dirty={draftDirty}
      onCancel={closeEditor}
      returnFocus={() => (draft.id ? control('edit', draft.id) : null) ?? control('add')}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-muted p-3.5"
    >
      <span id={`${id}-editor`} className="text-[13px] font-medium text-ink">
        {draft.id === null ? t('add') : t('edit', { name: draft.name })}
      </span>
      <BilingualField
        id={`${id}-site-name`}
        label={t('name')}
        required
        maxLength={ADMIN_LIMITS.labelMax}
        valueEn={draft.name}
        valueAr={draft.nameAr}
        onChangeEn={(name) => setDraft({ ...draft, name })}
        onChangeAr={(nameAr) => setDraft({ ...draft, nameAr })}
        errorEn={nameError}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-site-address`} className="font-medium text-ink">
          {t('address')}
        </label>
        <Input
          id={`${id}-site-address`}
          dir="auto"
          value={draft.address}
          maxLength={ADMIN_LIMITS.addressMax}
          onChange={(event) => setDraft({ ...draft, address: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitDraft();
            }
          }}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={closeEditor}>
          {t('cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          aria-busy={saveSite.isPending || undefined}
          aria-disabled={busy || undefined}
          onClick={submitDraft}
        >
          {t('save')}
        </Button>
      </div>
    </InlineEditor>
  ) : null;

  return (
    <section ref={attachList} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3
          id={`${id}-title`}
          tabIndex={-1}
          className="font-medium text-ink outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand"
        >
          {t('title')}
        </h3>
        {draft === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-list-control="add"
            onClick={() => openEditor(emptyDraft)}
          >
            {t('add')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] leading-normal font-medium text-danger">
          {error}
        </p>
      ) : null}
      {editor}
      {active.length === 0 ? (
        <p className="text-[13px] text-ink-muted">{t('empty')}</p>
      ) : (
        <ReorderList
          items={active}
          getId={(site) => site.id}
          getLabel={(site) => placeName(site, locale)}
          label={t('list', { name: orgName })}
          disabled={busy}
          onReorder={(ids, expectedIds) => reorder.mutateAsync({ ids, expectedIds })}
          renderItem={(site) => (
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-ink">{placeName(site, locale)}</span>
                {site.address ? (
                  <span dir="auto" className="truncate text-[13px] text-ink-muted">
                    {site.address}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('edit', { name: placeName(site, locale) })}
                title={t('edit', { name: placeName(site, locale) })}
                data-list-control="edit"
                data-row-id={site.id}
                onClick={() =>
                  openEditor({
                    id: site.id,
                    name: site.name,
                    nameAr: site.nameAr ?? '',
                    address: site.address ?? '',
                    updatedAt: site.updatedAt,
                  })
                }
              >
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('archive', { name: placeName(site, locale) })}
                title={t('archive', { name: placeName(site, locale) })}
                data-list-control="archive"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  listFocus.expectRemoval(site.id, 'archive');
                  setActive.mutate({ site, action: 'archive' });
                }}
              >
                <Archive aria-hidden="true" />
              </Button>
            </div>
          )}
        />
      )}
      {archived.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-secondary">{t('archivedTitle')}</span>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-line">
            {archived.map((site) => (
              <li
                key={site.id}
                className="flex items-center gap-2 border-b border-divider bg-surface-muted px-3.5 py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {placeName(site, locale)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('restore', { name: placeName(site, locale) })}
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (!busy) setActive.mutate({ site, action: 'restore' });
                  }}
                >
                  <ArchiveRestore aria-hidden="true" />
                  {tKit('restore')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
