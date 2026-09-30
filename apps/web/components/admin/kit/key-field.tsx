'use client';

import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { FormField, fieldA11y } from '@/components/tickets/form-field';
import { Input } from '@/components/ui/input';
import { suggestKey, type KeySuggestionOptions } from '@/lib/admin/key-suggestion';
import { cn } from '@/lib/utils';

export interface KeyFieldProps extends KeySuggestionOptions {
  id: string;
  /** `create`: generated from `source` until the admin edits it. `edit`: read-only (E4). */
  mode: 'create' | 'edit';
  value: string;
  onChange: (value: string) => void;
  /** The English label the key is generated from while creating. */
  source: string;
  /** Keys already taken, archived rows included (collisions get `-2`, `-3`…). */
  takenKeys?: Iterable<string>;
  /**
   * Told whether the value is still the generated suggestion (the admin has not typed a key).
   * When `takenKeys` may be incomplete (rows the viewer can't see), a create form omits the key
   * while it is: the API then generates it, with its collision suffix over every row.
   */
  onFollowingChange?: (following: boolean) => void;
  /** Already translated. */
  error?: string;
  /** Default "Key". */
  label?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement>;
  onBlur?: () => void;
  className?: string;
}

/**
 * The stable key of a config row (E4). While creating it follows the English label (slug +
 * collision suffix) until the admin types their own; leaving it empty goes back to following the
 * label. Once created it is shown read-only.
 */
export function KeyField({
  id,
  mode,
  value,
  onChange,
  source,
  takenKeys,
  onFollowingChange,
  separator,
  maxLength,
  error,
  label,
  inputRef,
  onBlur,
  className,
}: KeyFieldProps) {
  const t = useTranslations('admin.kit');
  const [following, setFollowing] = useState(() => mode === 'create' && value === '');
  // A stable dependency for the taken keys (callers often pass a fresh array every render).
  const takenList = useMemo(() => Array.from(takenKeys ?? []), [takenKeys]);
  const takenSignature = takenList.join('\n');
  const suggestion = useMemo(
    () =>
      suggestKey(source, takenSignature ? takenSignature.split('\n') : [], {
        separator,
        maxLength,
      }),
    [source, takenSignature, separator, maxLength],
  );

  useEffect(() => {
    if (mode === 'create' && following && suggestion !== value) onChange(suggestion);
  }, [mode, following, suggestion, value, onChange]);

  useEffect(() => {
    onFollowingChange?.(following);
  }, [following, onFollowingChange]);

  const locked = mode === 'edit';
  return (
    <FormField
      id={id}
      label={label ?? t('key')}
      error={error}
      hint={
        locked ? (
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            {t('keyLocked')}
          </span>
        ) : (
          t('keyHint')
        )
      }
      className={className}
    >
      <Input
        {...fieldA11y(id, { error, hint: true })}
        ref={inputRef}
        value={value}
        readOnly={locked}
        aria-readonly={locked || undefined}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        maxLength={maxLength ?? 48}
        onBlur={() => {
          if (!locked && value === '') setFollowing(true);
          onBlur?.();
        }}
        onChange={(event) => {
          if (locked) return;
          setFollowing(false);
          onChange(event.target.value.toLowerCase());
        }}
        className={cn('font-mono', locked && 'bg-surface-sunken text-ink-secondary')}
      />
    </FormField>
  );
}
