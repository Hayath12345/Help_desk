// Admin API errors → UI states: the lost-update 409 (E19) opens the sheet's "Someone else changed
// this — reload" state; 400 VALIDATION_FAILED issues go onto the form fields.

import {
  adminConflictDetailsSchema,
  type AdminConflictDetails,
  type AdminConflictReason,
} from '@loons/shared';
import type { FieldPath, FieldValues, UseFormSetError } from 'react-hook-form';
import { isApiRequestError, validationIssues } from '@/lib/api/errors';

/**
 * A 409 caused by a concurrent change — `details.reason` `stale` (the `expectedUpdatedAt` is not
 * the row's `updatedAt` any more) or `order_changed` (a reorder's `expectedIds` is not the current
 * order) — as opposed to a 409 about the data itself (`duplicate`, `in_use`, `guard`; see
 * `adminConflictDetailsSchema`). A `CONFLICT` 409 without details is treated as stale; a 409 with
 * another code (e.g. `EMAIL_TAKEN`) is about the data, so its own message is shown.
 */
export function isStaleConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || error.code !== 'CONFLICT') return false;
  if (error.details === undefined || error.details === null) return true;
  const reason = conflictReason(error);
  return reason === 'stale' || reason === 'order_changed';
}

/** The parsed `details` of an admin 409 (reason, fields, guard…), or null. */
export function adminConflictDetails(error: unknown): AdminConflictDetails | null {
  if (!isApiRequestError(error) || error.status !== 409) return null;
  const parsed = adminConflictDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

function conflictReason(error: unknown): AdminConflictReason | null {
  return adminConflictDetails(error)?.reason ?? null;
}

/**
 * Puts the API's 400 VALIDATION_FAILED issues on the matching form fields (`path` joined with
 * dots). `paths` limits it to fields the form has (others are left to a form-level message);
 * `message` translates an API message (default: kept as is — pair with the validation-message
 * hooks). Returns how many issues were mapped (0 ⇒ show a form-level error instead). The first
 * mapped field is focused.
 */
export function applyServerIssues<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  options: {
    paths?: ReadonlySet<string> | readonly string[];
    message?: (m: string) => string;
  } = {},
): number {
  if (!isApiRequestError(error) || error.code !== 'VALIDATION_FAILED') return 0;
  const allowed = options.paths ? new Set(options.paths) : null;
  let mapped = 0;
  for (const issue of validationIssues(error)) {
    const path = issue.path.map(String).join('.');
    if (!path || (allowed && !allowed.has(path))) continue;
    setError(
      path as FieldPath<T>,
      { type: 'server', message: options.message ? options.message(issue.message) : issue.message },
      { shouldFocus: mapped === 0 },
    );
    mapped += 1;
  }
  return mapped;
}
