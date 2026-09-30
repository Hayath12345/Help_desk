'use client';

// Helpers shared by the Ticket setup sections (categories, custom fields, macros): validation
// messages from the shared admin schemas, the answers of a refused write (field issues, duplicate
// keys, archive guards), and the category icon set.

import {
  PRIORITIES,
  adminConflictDetailsSchema,
  type CategoryIcon as CategoryIconName,
  type Priority,
} from '@loons/shared';
import {
  AppWindow,
  Bell,
  BriefcaseBusiness,
  BuildingComplex,
  Camera,
  Cctv,
  CircleQuestionMark,
  Cloud,
  Cpu,
  Database,
  FileText,
  Flame,
  Globe,
  HardDrive,
  Headset,
  KeyRound,
  Laptop,
  Lock,
  Mail,
  MonitorSpeaker,
  Network,
  Phone,
  Printer,
  Router,
  Server,
  ShieldAlert,
  Siren,
  Thermometer,
  Wifi,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { FieldPath, FieldValues, UseFormSetError } from 'react-hook-form';
import { FormField } from '@/components/tickets/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';
import { isStaleConflict } from '@/lib/admin/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';

type Values = Record<string, string | number>;
type Untyped = (key: string, values?: Values) => string;

/**
 * Translates a validation message from the shared admin schemas or the API (`validation.<key>`):
 * the app's `validation` namespace first, then the Ticket setup strings (admin-specific rules
 * such as `validation.teamArchived`), else the generic "Check this value.".
 */
export function useSetupMessage(): (message: string | undefined) => string | undefined {
  const tValidation = useTranslations('validation');
  const tSetup = useTranslations('admin-setup.validation');
  return useCallback(
    (message) => {
      if (!message) return undefined;
      const key = message.startsWith('validation.') ? message.slice('validation.'.length) : '';
      if (key && tValidation.has(key as never)) return (tValidation as unknown as Untyped)(key);
      if (key && tSetup.has(key as never)) return (tSetup as unknown as Untyped)(key);
      return tValidation('invalid');
    },
    [tValidation, tSetup],
  );
}

/**
 * What a refused write means for the form: field issues (400) and a duplicate key (409) go onto
 * the fields; an archive guard or anything else becomes a form-level message (returned). The
 * stale 409 returns null (the sheet shows its own "Someone else changed this" state).
 */
export function useWriteErrorHandler() {
  const tSetup = useTranslations('admin-setup');
  const errorText = useApiErrorText();
  return useCallback(
    <T extends FieldValues>(
      error: unknown,
      setError: UseFormSetError<T>,
      paths: readonly string[],
    ): string | null => {
      if (isStaleConflict(error)) return null;
      if (isApiRequestError(error) && error.code === 'VALIDATION_FAILED') {
        // Each issue goes on the deepest form field its path starts with ("fieldIds.2" → the
        // "fieldIds" list); issues on nothing the form shows become one form-level message.
        let mapped = 0;
        let unmapped = false;
        for (const issue of validationIssues(error)) {
          const path = issue.path.map(String);
          const target = [...paths]
            .sort((a, b) => b.length - a.length)
            .find((p) => {
              const parts = p.split('.');
              return parts.every((part, i) => path[i] === part);
            });
          if (!target) {
            unmapped = true;
            continue;
          }
          setError(
            target as FieldPath<T>,
            { type: 'server', message: issue.message },
            { shouldFocus: mapped === 0 },
          );
          mapped += 1;
        }
        return unmapped || mapped === 0 ? tSetup('errors.checkForm') : null;
      }
      if (isApiRequestError(error) && error.status === 409) {
        const details = adminConflictDetailsSchema.safeParse(error.details);
        if (details.success && details.data.reason === 'duplicate') {
          const field = details.data.fields?.join('.') ?? '';
          const archived = details.data.existingIsActive === false;
          if (paths.includes(field)) {
            // An i18n key, like every field error (translated where the field shows it).
            const message = archived
              ? 'validation.duplicateKeyArchived'
              : 'validation.duplicateKey';
            setError(field as FieldPath<T>, { type: 'server', message }, { shouldFocus: true });
            return null;
          }
          return tSetup(archived ? 'errors.duplicateArchived' : 'errors.duplicate');
        }
        if (details.success && details.data.reason === 'guard' && details.data.guard) {
          const key = `guards.${details.data.guard}`;
          if (tSetup.has(key as never)) return (tSetup as unknown as Untyped)(key);
        }
      }
      return errorText(error);
    },
    [tSetup, errorText],
  );
}

/** The lucide icon of each allowed category icon (shared CATEGORY_ICONS). */
export const CATEGORY_ICON_COMPONENTS: Record<CategoryIconName, LucideIcon> = {
  'shield-alert': ShieldAlert,
  network: Network,
  server: Server,
  cloud: Cloud,
  cctv: Cctv,
  'key-round': KeyRound,
  siren: Siren,
  'building-complex': BuildingComplex,
  'monitor-speaker': MonitorSpeaker,
  'app-window': AppWindow,
  'briefcase-business': BriefcaseBusiness,
  'circle-question-mark': CircleQuestionMark,
  wifi: Wifi,
  router: Router,
  database: Database,
  'hard-drive': HardDrive,
  cpu: Cpu,
  laptop: Laptop,
  printer: Printer,
  phone: Phone,
  camera: Camera,
  lock: Lock,
  flame: Flame,
  thermometer: Thermometer,
  wrench: Wrench,
  headset: Headset,
  mail: Mail,
  globe: Globe,
  bell: Bell,
  'file-text': FileText,
};

/** A category's icon; names outside the allow-list (older rows) fall back to the question mark. */
export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon =
    CATEGORY_ICON_COMPONENTS[name as CategoryIconName] ??
    CATEGORY_ICON_COMPONENTS['circle-question-mark'];
  return <Icon aria-hidden="true" className={className} />;
}

/** A priority picker (sub-type default priority). */
export function PrioritySelect({
  id,
  label,
  value,
  onChange,
  tPriority,
}: {
  id: string;
  label: string;
  value: Priority;
  onChange: (value: Priority) => void;
  tPriority: (priority: Priority) => string;
}) {
  return (
    <FormField id={id} label={label}>
      <Select value={value} onValueChange={(v) => onChange(v as Priority)}>
        <SelectTrigger id={id} className="w-full sm:w-60">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {PRIORITIES.map((priority) => (
            <SelectItem key={priority} value={priority}>
              {tPriority(priority)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
