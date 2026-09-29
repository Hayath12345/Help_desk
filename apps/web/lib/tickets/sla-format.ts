// SLA window labels ("15 min", "1 hour", "1 business day") from policy minutes.

/**
 * Length of one business day in business minutes (Sun–Thu 07:30–16:30 = 9 h, spec §13). The form
 * config does not carry the business calendar, so a whole number of these is shown as business
 * days, as in the design. Anything else is shown in hours / minutes, which is always exact.
 */
export const BUSINESS_DAY_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;

export type SlaWindowParts =
  | { unit: 'minutes'; n: number }
  | { unit: 'hours'; n: number }
  | { unit: 'hoursMinutes'; hours: number; minutes: number }
  | { unit: 'days'; n: number }
  | { unit: 'businessDays'; n: number };

/** How to phrase an SLA window of `minutes` (calendar or business minutes). */
export function slaWindowParts(minutes: number, businessHoursOnly: boolean): SlaWindowParts {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return { unit: 'minutes', n: m };
  if (businessHoursOnly && m % BUSINESS_DAY_MINUTES === 0) {
    return { unit: 'businessDays', n: m / BUSINESS_DAY_MINUTES };
  }
  if (!businessHoursOnly && m % DAY_MINUTES === 0) return { unit: 'days', n: m / DAY_MINUTES };
  if (m % 60 === 0) return { unit: 'hours', n: m / 60 };
  return { unit: 'hoursMinutes', hours: Math.floor(m / 60), minutes: m % 60 };
}
