'use client';

import { TICKET_LIMITS } from '@loons/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { listItemVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { normalizeTag, tagProblem, type TagProblem } from './tags';

// Editors of the console right panel (design 829–863): a two-column grid of muted labels and
// quiet controls that only show a border on hover / focus. Every change is saved at once
// (optimistically, through useUpdateTicket in the panel).

/** Label column of the properties grid. */
export function PropertyLabel({
  id,
  htmlFor,
  className,
  children,
}: {
  id?: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const classes = cn('text-ink-muted', className);
  return htmlFor ? (
    <label id={id} htmlFor={htmlFor} className={classes}>
      {children}
    </label>
  ) : (
    <span id={id} className={classes}>
      {children}
    </span>
  );
}

/** Quiet select trigger (design: transparent border, 3px 4px padding, border on hover). */
const GHOST_TRIGGER =
  'w-full max-w-full min-w-0 border-transparent bg-transparent text-sm shadow-none hover:border-line data-[size=sm]:h-7 data-[size=sm]:py-[3px] data-[size=sm]:ps-1 data-[size=sm]:pe-1';

export interface PropertyOption {
  value: string;
  label: React.ReactNode;
  /** Plain text for type-ahead when `label` is not a string. */
  textValue?: string;
  disabled?: boolean;
}

export interface PropertySelectProps {
  label: string;
  value: string;
  options: readonly PropertyOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** One "Priority ▾" style row: label + select. Renders two grid cells. */
export function PropertySelect({
  label,
  value,
  options,
  onValueChange,
  disabled,
  placeholder,
}: PropertySelectProps) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <>
      <PropertyLabel id={labelId}>{label}</PropertyLabel>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== value) onValueChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          size="sm"
          aria-labelledby={`${labelId} ${id}`}
          className={GHOST_TRIGGER}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="max-w-[min(360px,90vw)]">
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              textValue={option.textValue}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

/**
 * Asset / device ID (design: mono 13px input). Saved on Enter or when leaving the field; Escape
 * restores the saved value. An empty value clears it.
 */
export function AssetIdEditor({
  label,
  value,
  placeholder,
  onCommit,
  disabled,
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  onCommit: (value: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = value ?? '';

  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== saved) onCommit(next || null);
  };

  return (
    <>
      <PropertyLabel htmlFor={id}>{label}</PropertyLabel>
      <input
        id={id}
        value={draft ?? saved}
        placeholder={placeholder}
        maxLength={TICKET_LIMITS.assetIdMax}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            setDraft(null);
          }
        }}
        className="h-7 w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1.5 text-start font-mono text-[13px] text-ink transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:font-sans placeholder:text-ink-muted hover:border-line focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint focus-visible:outline-hidden disabled:cursor-not-allowed disabled:text-ink-muted rtl:text-end"
      />
    </>
  );
}

/**
 * Tags (design 856–862): mono chips — click one to remove it — and a small "+ tag" input that
 * adds on Enter (lower-cased, spaces → dashes).
 */
export function TagsEditor({
  label,
  tags,
  onChange,
  disabled,
}: {
  label: string;
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('console.panel.tagsEditor');
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<TagProblem | null>(null);

  const add = () => {
    const tag = normalizeTag(draft);
    if (!tag) return;
    const found = tagProblem(tag, tags);
    if (found) {
      setProblem(found);
      return;
    }
    setDraft('');
    setProblem(null);
    if (!tags.includes(tag)) onChange([...tags, tag]);
  };

  const remove = (tag: string) => {
    onChange(tags.filter((existing) => existing !== tag));
    input.current?.focus();
  };

  return (
    <>
      <PropertyLabel id={labelId} className="self-start pt-1">
        {label}
      </PropertyLabel>
      <div className="flex min-w-0 flex-col gap-1">
        <ul aria-labelledby={labelId} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <AnimatePresence initial={false}>
            {tags.map((tag) => (
              <motion.li
                key={tag}
                layout="position"
                variants={listItemVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="max-w-full min-w-0"
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(tag)}
                  title={t('remove', { tag })}
                  aria-label={t('remove', { tag })}
                  dir="ltr"
                  className="max-w-full cursor-pointer truncate rounded-[5px] bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink-secondary transition-colors duration-150 ease-out hover:bg-danger-tint hover:text-danger disabled:cursor-not-allowed"
                >
                  {tag}
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
          <li className="min-w-0">
            <input
              ref={input}
              value={draft}
              disabled={disabled}
              onChange={(event) => {
                setDraft(event.target.value);
                if (problem) setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add();
                } else if (event.key === 'Escape' && draft) {
                  event.preventDefault();
                  setDraft('');
                  setProblem(null);
                }
              }}
              placeholder={t('placeholder')}
              aria-label={t('add')}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? errorId : undefined}
              maxLength={TICKET_LIMITS.tagMax + 10}
              autoComplete="off"
              spellCheck={false}
              className="w-20 rounded-sm border border-transparent bg-transparent px-0.5 py-0.5 font-mono text-xs text-ink transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-ink-muted hover:border-line focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint focus-visible:outline-hidden aria-invalid:text-danger aria-invalid:focus-visible:border-danger-strong"
            />
          </li>
        </ul>
        {problem ? (
          <p id={errorId} role="alert" className="text-xs font-medium text-danger">
            {t(`problem.${problem}`, {
              max: TICKET_LIMITS.tagsPerTicket,
              length: TICKET_LIMITS.tagMax,
            })}
          </p>
        ) : null}
      </div>
    </>
  );
}
