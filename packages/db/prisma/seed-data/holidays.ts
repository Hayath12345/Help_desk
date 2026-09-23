// Qatar public holidays for 2026 and 2027. Fixed-date holidays are exact; Eid dates follow the
// Hijri calendar and depend on moon sighting, so they are astronomical estimates and are labelled
// "(estimated)" — admins confirm or move them in Admin → Business hours & holidays.

import { addDays, nthWeekdayOfMonth, utcDate } from './util.ts';

export interface HolidaySeed {
  /** UTC-midnight calendar date (stored in a `@db.Date` column). */
  date: Date;
  name: string;
  nameAr: string;
}

/** Estimated first day of each Eid (Gregorian), keyed by year. */
const EID_ESTIMATES: Record<number, { fitr: Date; adha: Date }> = {
  // 1 Shawwal 1447 / 10 Dhu al-Hijjah 1447
  2026: { fitr: utcDate(2026, 3, 20), adha: utcDate(2026, 5, 27) },
  // 1 Shawwal 1448 / 10 Dhu al-Hijjah 1448
  2027: { fitr: utcDate(2027, 3, 9), adha: utcDate(2027, 5, 16) },
};

/** Eid holidays in Qatar's private sector span three days. */
const EID_DAYS = 3;

const DAY_NAMES_EN = ['', ', day 2', ', day 3'];
const DAY_NAMES_AR = ['', ' – اليوم الثاني', ' – اليوم الثالث'];

function eidDays(start: Date, nameEn: string, nameAr: string): HolidaySeed[] {
  return Array.from({ length: EID_DAYS }, (_, i) => ({
    date: addDays(start, i),
    name: `${nameEn}${DAY_NAMES_EN[i] ?? ''} (estimated)`,
    nameAr: `${nameAr}${DAY_NAMES_AR[i] ?? ''} (تقديري)`,
  }));
}

export function qatarHolidays(year: number): HolidaySeed[] {
  const eid = EID_ESTIMATES[year];
  if (!eid) throw new Error(`No Eid estimates for ${year}`);
  return [
    {
      // Second Tuesday of February.
      date: nthWeekdayOfMonth(year, 2, 2, 2),
      name: 'National Sports Day',
      nameAr: 'اليوم الرياضي للدولة',
    },
    ...eidDays(eid.fitr, 'Eid al-Fitr', 'عيد الفطر'),
    ...eidDays(eid.adha, 'Eid al-Adha', 'عيد الأضحى'),
    {
      date: utcDate(year, 12, 18),
      name: 'Qatar National Day',
      nameAr: 'اليوم الوطني لدولة قطر',
    },
  ];
}

export const HOLIDAY_YEARS = [2026, 2027] as const;

export const HOLIDAYS: readonly HolidaySeed[] = HOLIDAY_YEARS.flatMap(qatarHolidays);
