'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useController, type Control } from 'react-hook-form';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTicketValidationMessage } from '@/lib/tickets/i18n';
import { fieldPlaceholder, localizedLabel } from '@/lib/tickets/labels';
import type { FormCustomField, NewTicketFormValues } from '@/lib/tickets/new-ticket-form';
import { cn } from '@/lib/utils';
import { FormField, fieldA11y } from '../form-field';
import { SegmentedControl } from '../segmented-control';

export interface CustomFieldInputProps {
  field: FormCustomField;
  control: Control<NewTicketFormValues>;
  idPrefix: string;
}

/**
 * One category custom field, typed like the admin defined it (spec §10.2): text, number,
 * dropdown, multi-select, date, yes/no, asset ID. Required fields show the asterisk.
 */
export function CustomFieldInput({ field, control, idPrefix }: CustomFieldInputProps) {
  const t = useTranslations('tickets');
  const locale = useLocale();
  const message = useTicketValidationMessage();
  const {
    field: { ref: fieldRef, value, onChange, onBlur, name },
    fieldState,
  } = useController({ control, name: `customFields.${field.key}` });
  const id = `${idPrefix}-cf-${field.key}`;
  const label = localizedLabel(field, locale);
  const error = message(fieldState.error?.message, { field: label });
  const a11y = fieldA11y(id, { error });
  const placeholder = fieldPlaceholder(field, locale);
  const stringValue = typeof value === 'string' ? value : '';

  const common = {
    id,
    label,
    required: field.required,
    labelNote: field.required ? undefined : t('newTicket.optional'),
    error,
  };

  switch (field.type) {
    case 'TEXT':
    case 'ASSET_ID':
    case 'NUMBER':
    case 'DATE':
      return (
        <FormField {...common}>
          <Input
            {...a11y}
            ref={fieldRef}
            name={name}
            value={stringValue}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            placeholder={placeholder}
            type={field.type === 'DATE' ? 'date' : 'text'}
            inputMode={field.type === 'NUMBER' ? 'decimal' : undefined}
            maxLength={500}
            className={cn(field.type === 'ASSET_ID' && 'font-mono')}
          />
        </FormField>
      );
    case 'DROPDOWN':
      return (
        <FormField {...common}>
          <Select value={stringValue} onValueChange={(next) => onChange(next)}>
            <SelectTrigger {...a11y} ref={fieldRef} onBlur={onBlur} className="w-full">
              <SelectValue placeholder={placeholder ?? t('newTicket.fieldPlaceholder')} />
            </SelectTrigger>
            <SelectContent position="popper">
              {field.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {localizedLabel(option, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      );
    case 'MULTI_SELECT': {
      const selected = Array.isArray(value) ? value : [];
      return (
        <FormField {...common} labelKind="group">
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={a11y['aria-describedby']}
            className="flex flex-wrap gap-x-4 gap-y-2 pt-1"
          >
            {field.options.map((option, index) => {
              const optionId = `${id}-${index}`;
              const checked = selected.includes(option.value);
              return (
                <label key={option.value} htmlFor={optionId} className="flex items-center gap-2">
                  <Checkbox
                    id={optionId}
                    ref={index === 0 ? fieldRef : undefined}
                    checked={checked}
                    aria-invalid={a11y['aria-invalid']}
                    onCheckedChange={(next) =>
                      onChange(
                        next === true
                          ? [...selected, option.value]
                          : selected.filter((v) => v !== option.value),
                      )
                    }
                  />
                  {localizedLabel(option, locale)}
                </label>
              );
            })}
          </div>
        </FormField>
      );
    }
    case 'YES_NO':
      return (
        <FormField {...common} labelKind="group">
          <SegmentedControl
            ref={fieldRef}
            value={value === true ? 'yes' : value === false ? 'no' : ''}
            onValueChange={(next) => onChange(next === 'yes')}
            aria-labelledby={`${id}-label`}
            aria-describedby={a11y['aria-describedby']}
            aria-invalid={a11y['aria-invalid']}
            options={[
              { value: 'yes', label: t('yes') },
              { value: 'no', label: t('no') },
            ]}
            className="max-w-60"
          />
        </FormField>
      );
  }
}
