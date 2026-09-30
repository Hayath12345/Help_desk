'use client';

// Translates validation messages for the Communication sections (email templates, help center):
// the shared schemas and the API send i18n keys like `validation.required`; the section-specific
// ones (unknown template variables, key rules) live in `admin-comms.validation`, the generic ones
// in the `validation` namespace. A message may carry its `{names}` value after a `|`
// (see placeholders.ts).

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { MESSAGE_VALUE_SEPARATOR } from './placeholders';

type Untyped = {
  (key: string, values?: Record<string, string>): string;
  has: (key: string) => boolean;
};

/** Server issues without the names: a sentence that doesn't need them. */
const SERVER_VARIANT: Readonly<Record<string, string>> = {
  unknownVariable: 'unknownVariableServer',
  blockInSubject: 'blockInSubjectServer',
  malformedPlaceholder: 'malformedPlaceholderServer',
};

export function useCommsValidationMessage(): (message: string | undefined) => string | undefined {
  const tComms = useTranslations('admin-comms.validation') as unknown as Untyped;
  const tValidation = useTranslations('validation') as unknown as Untyped;
  return useCallback(
    (message) => {
      if (!message) return undefined;
      // Only the first separator splits: the names themselves may contain one ({{a|b}}).
      const at = message.indexOf(MESSAGE_VALUE_SEPARATOR);
      const raw = at < 0 ? message : message.slice(0, at);
      const names = at < 0 ? undefined : message.slice(at + MESSAGE_VALUE_SEPARATOR.length);
      const key = raw.startsWith('validation.') ? raw.slice('validation.'.length) : raw;
      if (names === undefined && SERVER_VARIANT[key]) return tComms(SERVER_VARIANT[key]);
      if (tComms.has(key)) return tComms(key, { names: names ?? '' });
      if (tValidation.has(key)) return tValidation(key);
      return tValidation('invalid');
    },
    [tComms, tValidation],
  );
}
