'use client';

import { useTranslations } from 'next-intl';
import { useController, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ContentLanguage } from './language-switch';

type TextControl = HTMLInputElement | HTMLTextAreaElement;

export interface BilingualFieldProps {
  /** Prefix of the ids: `${id}-label`, `${id}-en`, `${id}-ar`, `${id}-hint`, `${id}-ar-missing`. */
  id: string;
  label: React.ReactNode;
  /** The English text is required (Arabic is always optional: English is shown instead, E2). */
  required?: boolean;
  hint?: React.ReactNode;
  multiline?: boolean;
  /** Textarea rows (multiline). Default 3. */
  rows?: number;
  maxLength?: number;
  valueEn: string;
  valueAr: string;
  onChangeEn: (value: string) => void;
  onChangeAr: (value: string) => void;
  onBlurEn?: () => void;
  onBlurAr?: () => void;
  /** Already translated. */
  errorEn?: string;
  errorAr?: string;
  placeholderEn?: string;
  placeholderAr?: string;
  disabled?: boolean;
  /** For react-hook-form focus on errors. */
  refEn?: React.Ref<TextControl>;
  refAr?: React.Ref<TextControl>;
  className?: string;
}

/**
 * A short translatable text edited in both languages side by side (E2): English `dir="ltr"`,
 * Arabic `dir="rtl"`, each with its language tag (written in that language); when the Arabic is
 * empty, "Arabic missing — English is shown". Stacks on phones.
 */
export function BilingualField(props: BilingualFieldProps) {
  const {
    id,
    label,
    required = false,
    hint,
    multiline = false,
    rows = 3,
    maxLength,
    disabled,
    className,
  } = props;
  const t = useTranslations('admin.kit');
  const tForm = useTranslations('tickets.newTicket');
  const arabicMissing = props.valueAr.trim() === '';

  const side = (language: ContentLanguage) => {
    const en = language === 'en';
    const controlId = `${id}-${language}`;
    const error = en ? props.errorEn : props.errorAr;
    const describedBy = [
      error ? `${controlId}-error` : null,
      !en && arabicMissing ? `${id}-ar-missing` : null,
      hint ? `${id}-hint` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const common = {
      id: controlId,
      lang: language,
      dir: en ? 'ltr' : 'rtl',
      value: en ? props.valueEn : props.valueAr,
      placeholder: en ? props.placeholderEn : props.placeholderAr,
      maxLength,
      disabled,
      'aria-labelledby': `${id}-label ${controlId}-tag`,
      'aria-describedby': describedBy || undefined,
      'aria-invalid': error ? true : undefined,
      'aria-required': en && required ? true : undefined,
      onBlur: en ? props.onBlurEn : props.onBlurAr,
    } as const;
    const onChange = (event: React.ChangeEvent<TextControl>) =>
      (en ? props.onChangeEn : props.onChangeAr)(event.target.value);
    const ref = en ? props.refEn : props.refAr;

    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span
          id={`${controlId}-tag`}
          lang={language}
          dir={en ? 'ltr' : 'rtl'}
          className="w-fit text-xs text-ink-muted"
        >
          {t(`languages.${language}`)}
        </span>
        {multiline ? (
          <Textarea
            {...common}
            ref={ref as React.Ref<HTMLTextAreaElement>}
            rows={rows}
            onChange={onChange}
            className="resize-y"
          />
        ) : (
          <Input
            {...common}
            ref={ref as React.Ref<HTMLInputElement>}
            onChange={onChange}
            autoComplete="off"
          />
        )}
        {!en && arabicMissing ? (
          <p id={`${id}-ar-missing`} className="text-[13px] leading-normal text-ink-muted">
            {t('arabicMissing')}
          </p>
        ) : null}
        {error ? (
          <p
            id={`${controlId}-error`}
            className="text-[13px] leading-normal font-medium text-danger"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      {/* The label names the group and both inputs ("Name English"); "required" is carried by
          the English input's aria-required, so it stays out of the name. */}
      <span className={cn('font-medium text-ink', disabled && 'text-ink-muted')}>
        <span id={`${id}-label`}>{label}</span>
        {required ? (
          <span aria-hidden="true" className="text-danger" title={tForm('required')}>
            {' *'}
          </span>
        ) : null}
      </span>
      <div className="grid gap-x-3.5 gap-y-2.5 sm:grid-cols-2">
        {side('en')}
        {side('ar')}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-[13px] leading-normal text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface RhfBilingualFieldProps<T extends FieldValues> extends Omit<
  BilingualFieldProps,
  | 'valueEn'
  | 'valueAr'
  | 'onChangeEn'
  | 'onChangeAr'
  | 'onBlurEn'
  | 'onBlurAr'
  | 'errorEn'
  | 'errorAr'
  | 'refEn'
  | 'refAr'
> {
  control: Control<T>;
  nameEn: FieldPath<T>;
  nameAr: FieldPath<T>;
  /** Turns a field error message (an i18n key from the shared schemas) into text. */
  errorText?: (message: string | undefined) => string | undefined;
}

/** `BilingualField` bound to two react-hook-form fields (e.g. `labelEn` / `labelAr`). */
export function RhfBilingualField<T extends FieldValues>({
  control,
  nameEn,
  nameAr,
  errorText = (message) => message,
  ...props
}: RhfBilingualFieldProps<T>) {
  const en = useController({ control, name: nameEn });
  const ar = useController({ control, name: nameAr });
  return (
    <BilingualField
      {...props}
      valueEn={(en.field.value as string | null | undefined) ?? ''}
      valueAr={(ar.field.value as string | null | undefined) ?? ''}
      onChangeEn={en.field.onChange}
      onChangeAr={ar.field.onChange}
      onBlurEn={en.field.onBlur}
      onBlurAr={ar.field.onBlur}
      refEn={en.field.ref}
      refAr={ar.field.ref}
      errorEn={errorText(en.fieldState.error?.message)}
      errorAr={errorText(ar.fieldState.error?.message)}
    />
  );
}
