import type { AdminConflictDetails, AdminGuard } from '@loons/shared';
import { AppError } from '../../lib/errors.ts';

// 409 CONFLICT answers of /admin/* (E5, E19). `error.details` matches `adminConflictDetailsSchema`
// from @loons/shared, so the web can say what happened.

function conflict(message: string, details: AdminConflictDetails): AppError {
  return new AppError(409, 'CONFLICT', message, details);
}

export const adminErrors = {
  /** `expectedUpdatedAt` is not the row's `updatedAt` any more (E19). */
  stale: (currentUpdatedAt: Date | null) =>
    conflict('Someone else changed this — reload to see their changes.', {
      reason: 'stale',
      ...(currentUpdatedAt ? { currentUpdatedAt: currentUpdatedAt.toISOString() } : {}),
    }),
  /**
   * A unique key / value is taken. Pass the existing row when known (e.g. an archived holiday or
   * escalation step the admin should restore instead).
   */
  duplicate: (fields: string[], existing?: { id: string; isActive: boolean }) =>
    conflict('This value is already used by another record.', {
      reason: 'duplicate',
      fields,
      ...(existing ? { existingId: existing.id, existingIsActive: existing.isActive } : {}),
    }),
  /** Another row still references this one. */
  inUse: (message = 'This record is still in use.') => conflict(message, { reason: 'in_use' }),
  /** A reorder's `expectedIds` is not the current order (E3). */
  orderChanged: () =>
    conflict('The order changed meanwhile — reload and try again.', { reason: 'order_changed' }),
  /** An archive / change guard (E5, E9); `guard` names it for the web. */
  guard: (guard: AdminGuard | (string & {}), message: string) =>
    conflict(message, { reason: 'guard', guard }),
};
