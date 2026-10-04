'use client';

import { SKILLS_PER_LINK_MAX, type Locale, type SkillRef } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import { ArchivedBadge } from '@/components/admin/kit';
import { FormField } from '@/components/tickets/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { localizedLabel } from '@/lib/tickets/labels';
import { useActiveSkills } from './data';

// The skills multi-select of the Staff ("Skills") and Categories ("Skills needed") sheets
// (docs/AUTO_ASSIGN.md): a checklist of the active skills catalog. A skill the row already has but
// that was archived since stays in the list, marked "Archived", ticked and removable (the API lets
// an archived skill stay on a row but never be added to one). The ids it hands back are sorted, so
// the form's dirty check does not depend on the order things were ticked in.

export interface SkillPickerProps {
  id: string;
  label: string;
  hint: React.ReactNode;
  /** Ids ticked now. */
  value: readonly string[];
  onChange: (ids: string[]) => void;
  /** The skills the row has (archived ones included): they are listed even when archived. */
  linked?: readonly SkillRef[];
  /** Shown when there is no skill to pick yet; carries the link to the Skills section. */
  empty: React.ReactNode;
  /** Shown when `SKILLS_PER_LINK_MAX` skills are ticked (the rest are disabled). */
  limitNote: string;
  /** Already translated. */
  error?: string;
}

const NO_SKILLS: readonly SkillRef[] = [];

/** A link to the Skills section (Super Admins only, like both sheets that use the picker). */
export function SkillsAdminLink({ children }: { children?: React.ReactNode }) {
  return (
    <Link
      href="/admin/skills"
      className="rounded-sm text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-hidden"
    >
      {children}
    </Link>
  );
}

export function SkillPicker({
  id,
  label,
  hint,
  value,
  onChange,
  linked = NO_SKILLS,
  empty,
  limitNote,
  error,
}: SkillPickerProps) {
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const catalog = useActiveSkills();

  // Active skills plus the archived ones the row still has, by name in the UI language.
  const options = useMemo(() => {
    const byId = new Map<string, SkillRef>();
    for (const skill of catalog.data?.items ?? []) byId.set(skill.id, skill);
    for (const skill of linked) if (!byId.has(skill.id)) byId.set(skill.id, skill);
    return [...byId.values()].sort(
      (a, b) =>
        localizedLabel(a, locale).localeCompare(localizedLabel(b, locale), locale) ||
        a.id.localeCompare(b.id),
    );
  }, [catalog.data, linked, locale]);

  const ticked = new Set(value);
  const atLimit = value.length >= SKILLS_PER_LINK_MAX;
  const toggle = (skillId: string, checked: boolean) =>
    onChange(
      checked ? [...new Set([...value, skillId])].sort() : value.filter((v) => v !== skillId),
    );

  const describedBy =
    [error ? `${id}-error` : null, `${id}-hint`].filter(Boolean).join(' ') || undefined;

  let body: React.ReactNode;
  if (options.length === 0 && catalog.isPending) {
    body = <p className="text-[13px] text-ink-muted">{tKit('loading')}</p>;
  } else if (options.length === 0 && catalog.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line px-3.5 py-3">
        <p className="text-[13px] text-ink-muted">{tKit('loadError')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void catalog.refetch()}>
          {tKit('retry')}
        </Button>
      </div>
    );
  } else if (options.length === 0) {
    body = (
      <p className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-ink-muted">
        {empty}
      </p>
    );
  } else {
    body = (
      <ul className="grid max-h-72 gap-1.5 overflow-y-auto sm:grid-cols-2">
        {options.map((skill) => {
          const checked = ticked.has(skill.id);
          const boxId = `${id}-${skill.id}`;
          return (
            <li key={skill.id} className="min-w-0">
              <label
                htmlFor={boxId}
                className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors duration-150 ease-out hover:bg-surface-muted has-data-[state=checked]:border-brand has-data-[state=checked]:bg-brand-tint has-disabled:cursor-not-allowed"
              >
                <Checkbox
                  id={boxId}
                  checked={checked}
                  disabled={atLimit && !checked}
                  onCheckedChange={(next) => toggle(skill.id, next === true)}
                />
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {localizedLabel(skill, locale)}
                </span>
                {skill.isActive ? null : <ArchivedBadge />}
              </label>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <FormField id={id} labelKind="group" label={label} hint={hint} error={error}>
      <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
        {body}
        {atLimit ? <p className="mt-1.5 text-[13px] text-ink-muted">{limitNote}</p> : null}
        {catalog.isError && options.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <p className="text-[13px] text-danger">{tKit('loadError')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void catalog.refetch()}
            >
              {tKit('retry')}
            </Button>
          </div>
        ) : null}
      </div>
    </FormField>
  );
}

/**
 * A person's or a category's skills as small chips for the lists: the first `max` active skills and
 * "+N" for the rest (named in its tooltip and for screen readers). Archived skills don't count for
 * matching (docs/AUTO_ASSIGN.md), so the lists leave them out; the sheets still show them.
 */
export function SkillChips({ skills, max = 3 }: { skills: readonly SkillRef[]; max?: number }) {
  const locale = useLocale() as Locale;
  const active = skills.filter((skill) => skill.isActive);
  if (active.length === 0) return <span className="text-ink-muted">—</span>;
  const shown = active.slice(0, max);
  const rest = active.slice(max);
  const restNames = rest.map((skill) => localizedLabel(skill, locale)).join(', ');
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((skill) => (
        <Badge key={skill.id} variant="secondary" className="max-w-full">
          <span dir="auto" className="truncate">
            {localizedLabel(skill, locale)}
          </span>
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Badge variant="outline" title={restNames}>
          +{rest.length}
          <span className="sr-only">: {restNames}</span>
        </Badge>
      ) : null}
    </span>
  );
}
