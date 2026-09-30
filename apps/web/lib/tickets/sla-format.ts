// SLA window labels ("15 min", "1 hour", "1 business day") from policy minutes.

/**
 * Default length of one business day in business minutes (Sun–Thu 07:30–16:30 = 9 h, spec §13).
 * The configured length (decision E12) comes with the form config (`businessDayMinutes`, derived
 * from the business hours); this is only the fallback before it is known.
 */
export const BUSINESS_DAY_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;

export type SlaWindowParts =
  | { unit: 'minutes'; n: number }
  | { unit: 'hours'; n: number }
  | { unit: 'hoursMinutes'; hours: number; minutes: number }
  | { unit: 'days'; n: number }
  | { unit: 'businessDays'; n: number };

/**
 * How to phrase an SLA window of `minutes` (calendar or business minutes). A whole number of
 * business days (`businessDayMinutes` long) is shown as business days, as in the design; anything
 * else in hours / minutes, which is always exact.
 */
export function slaWindowParts(
  minutes: number,
  businessHoursOnly: boolean,
  businessDayMinutes: number = BUSINESS_DAY_MINUTES,
): SlaWindowParts {
  const m = Math.max(0, Math.round(minutes));
  const day = businessDayMinutes > 0 ? Math.round(businessDayMinutes) : BUSINESS_DAY_MINUTES;
  if (m < 60) return { unit: 'minutes', n: m };
  if (businessHoursOnly && m % day === 0) {
    return { unit: 'businessDays', n: m / day };
  }
  if (!businessHoursOnly && m % DAY_MINUTES === 0) return { unit: 'days', n: m / DAY_MINUTES };
  if (m % 60 === 0) return { unit: 'hours', n: m / 60 };
  return { unit: 'hoursMinutes', hours: Math.floor(m / 60), minutes: m % 60 };
}
