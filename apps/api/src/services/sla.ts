import {
  computeDueDates,
  resumeDueDate,
  type BusinessCalendar,
  type SlaPause,
  type SlaPolicyLike,
} from '@loons/shared';

// SLA due-date arithmetic used by the ticket services. The implementation is the shared one
// (`@loons/shared` sla.ts); it is injectable so tests (and a future engine) can swap it.

export interface SlaMath {
  /**
   * Due dates for a new ticket, or after a priority change (from `createdAt`, replaying the
   * ticket's finished PENDING pauses on the resolution clock).
   */
  computeDueDates(
    createdAt: Date,
    policy: SlaPolicyLike,
    calendar: BusinessCalendar,
    pauses?: readonly SlaPause[],
  ): { firstReplyDueAt: Date; resolveDueAt: Date };
  /** Resolution due date once a PENDING pause ends. */
  resumeDueDate(
    dueAt: Date,
    pausedAt: Date,
    resumedAt: Date,
    calendar: BusinessCalendar,
    businessHoursOnly: boolean,
  ): Date;
}

export const sharedSlaMath: SlaMath = { computeDueDates, resumeDueDate };

/** Where the business calendar comes from (the config service by default; tests may fake it). */
export type SlaCalendarSource = () => Promise<BusinessCalendar>;

/** Default business time zone when AppSetting "business.timezone" is missing or invalid. */
export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Qatar';

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
