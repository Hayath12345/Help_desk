import {
  computeSlaTargets,
  resumeDueDate,
  type BusinessCalendar,
  type SlaPause,
  type SlaPolicyRiskLike,
  type SlaTargets,
} from '@loons/shared';

// SLA due-date arithmetic used by the ticket services. The implementation is the shared one
// (`@loons/shared` sla.ts); it is injectable so tests (and a future engine) can swap it.

export interface SlaMath {
  /**
   * Due dates and at-risk instants (decisions D1/D2) for a new ticket, or after a priority change
   * (from `createdAt`, replaying the ticket's finished PENDING pauses on the resolution clock).
   */
  computeSlaTargets(
    createdAt: Date,
    policy: SlaPolicyRiskLike,
    calendar: BusinessCalendar,
    pauses?: readonly SlaPause[],
  ): SlaTargets;
  /**
   * Resolution due date once a PENDING pause ends; also moves the resolution at-risk instant
   * (pass it as `dueAt`).
   */
  resumeDueDate(
    dueAt: Date,
    pausedAt: Date,
    resumedAt: Date,
    calendar: BusinessCalendar,
    businessHoursOnly: boolean,
  ): Date;
}

export const sharedSlaMath: SlaMath = { computeSlaTargets, resumeDueDate };

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
