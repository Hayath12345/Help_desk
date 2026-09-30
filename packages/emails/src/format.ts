// Values for ticket email variables, formatted for the recipient's language: the same labels the
// web app shows (apps/web/messages/*/common.json, tickets.json), dates in a given IANA time zone,
// durations with Arabic plural forms, and the placeholders for missing values. Digits stay Latin
// in Arabic (`-u-nu-latn`), as in the app.

import {
  formatTicketNumber,
  type Locale,
  type Priority,
  type TicketStatus,
  type TicketType,
} from '@loons/shared';
import { BLOCK_MAX_CHARS } from './blocks.ts';

/** Shown for an empty field (site, asset, sub-type…). */
export const EMPTY_VALUE = '—';

const PRIORITY_LABELS: Readonly<Record<Locale, Record<Priority, string>>> = {
  en: { P1: 'P1 Critical', P2: 'P2 High', P3: 'P3 Medium', P4: 'P4 Low' },
  ar: { P1: 'P1 حرجة', P2: 'P2 عالية', P3: 'P3 متوسطة', P4: 'P4 منخفضة' },
};

const TYPE_LABELS: Readonly<Record<Locale, Record<TicketType, string>>> = {
  en: {
    INCIDENT: 'Incident',
    SERVICE_REQUEST: 'Service Request',
    CHANGE_REQUEST: 'Change Request',
    SECURITY_INCIDENT: 'Security Incident',
    ENQUIRY: 'Enquiry',
  },
  ar: {
    INCIDENT: 'عطل',
    SERVICE_REQUEST: 'طلب خدمة',
    CHANGE_REQUEST: 'طلب تغيير',
    SECURITY_INCIDENT: 'حادث أمني',
    ENQUIRY: 'استفسار',
  },
};

const STATUS_LABELS: Readonly<Record<Locale, Record<TicketStatus, string>>> = {
  en: { NEW: 'New', OPEN: 'Open', PENDING: 'Pending', SOLVED: 'Solved', CLOSED: 'Closed' },
  ar: {
    NEW: 'جديدة',
    OPEN: 'مفتوحة',
    PENDING: 'قيد الانتظار',
    SOLVED: 'تم الحل',
    CLOSED: 'مغلقة',
  },
};

export type SlaTarget = 'FIRST_REPLY' | 'RESOLUTION';

/** Lower-case in English: the templates say "The {{slaTarget}} target …". */
const SLA_TARGET_LABELS: Readonly<Record<Locale, Record<SlaTarget, string>>> = {
  en: { FIRST_REPLY: 'first reply', RESOLUTION: 'resolution' },
  ar: { FIRST_REPLY: 'الرد الأول', RESOLUTION: 'الحل' },
};

const UNASSIGNED: Readonly<Record<Locale, string>> = { en: 'Unassigned', ar: 'غير مسندة' };

export function priorityLabel(priority: Priority, locale: Locale): string {
  return PRIORITY_LABELS[locale][priority];
}

export function ticketTypeLabel(type: TicketType, locale: Locale): string {
  return TYPE_LABELS[locale][type];
}

export function ticketStatusLabel(status: TicketStatus, locale: Locale): string {
  return STATUS_LABELS[locale][status];
}

export function slaTargetLabel(target: SlaTarget, locale: Locale): string {
  return SLA_TARGET_LABELS[locale][target];
}

export function unassignedLabel(locale: Locale): string {
  return UNASSIGNED[locale];
}

/** The value on one line, or EMPTY_VALUE when it is missing or blank. */
export function orEmpty(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? EMPTY_VALUE : text;
}

/** A name given in both languages (e.g. Team.nameEn / nameAr, Category.labelEn / labelAr). */
export type LocalizedName = string | { en: string; ar?: string | null };

/** The name in `locale`, falling back to English when the Arabic one is missing or blank. */
export function localizedName(name: LocalizedName | null | undefined, locale: Locale): string {
  if (name === null || name === undefined) return '';
  if (typeof name === 'string') return name;
  const ar = name.ar?.trim();
  return locale === 'ar' && ar ? ar : name.en;
}

// ---- Dates ----

/** BCP-47 tag used with Intl for an app locale (Latin digits in Arabic, as in the app). */
export function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-QA-u-nu-latn' : 'en-US';
}

function toDate(value: Date | string | number): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return date;
}

/**
 * Full timestamp with the zone, for emails read later and elsewhere:
 * "Tue, Sep 29, 2026, 14:05 GMT+3" / "الثلاثاء، 29 سبتمبر 2026، 14:05 غرينتش+3".
 * Throws a RangeError for an unknown IANA zone.
 */
export function formatEmailDateTime(
  value: Date | string | number,
  locale: Locale,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    timeZoneName: 'short',
  }).format(toDate(value));
}

/** Calendar date: "Sep 29, 2026" / "29 سبتمبر 2026". */
export function formatEmailDate(
  value: Date | string | number,
  locale: Locale,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(toDate(value));
}

/** Short stamp for list lines: "Sep 29, 08:15" / "29 سبتمبر، 08:15". */
export function formatShortDateTime(
  value: Date | string | number,
  locale: Locale,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(toDate(value));
}

// ---- Durations ----

type Unit = 'minute' | 'hour' | 'day' | 'businessHour' | 'businessDay';
type ArabicForms = Record<Intl.LDMLPluralRule, string>;

const EN_UNITS: Readonly<Record<Unit, [one: string, other: string]>> = {
  minute: ['minute', 'minutes'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
  businessHour: ['business hour', 'business hours'],
  businessDay: ['business day', 'business days'],
};

// Arabic counted nouns: 1 and 2 have their own forms, 3–10 take the plural, 11–99 the singular
// accusative, 100+ the singular genitive. `{n}` is the number.
const AR_UNITS: Readonly<Record<Unit, ArabicForms>> = {
  minute: {
    zero: '{n} دقيقة',
    one: 'دقيقة واحدة',
    two: 'دقيقتان',
    few: '{n} دقائق',
    many: '{n} دقيقة',
    other: '{n} دقيقة',
  },
  hour: {
    zero: '{n} ساعة',
    one: 'ساعة واحدة',
    two: 'ساعتان',
    few: '{n} ساعات',
    many: '{n} ساعة',
    other: '{n} ساعة',
  },
  day: {
    zero: '{n} يوم',
    one: 'يوم واحد',
    two: 'يومان',
    few: '{n} أيام',
    many: '{n} يومًا',
    other: '{n} يوم',
  },
  businessHour: {
    zero: '{n} ساعة عمل',
    one: 'ساعة عمل واحدة',
    two: 'ساعتا عمل',
    few: '{n} ساعات عمل',
    many: '{n} ساعة عمل',
    other: '{n} ساعة عمل',
  },
  businessDay: {
    zero: '{n} يوم عمل',
    one: 'يوم عمل واحد',
    two: 'يوما عمل',
    few: '{n} أيام عمل',
    many: '{n} يوم عمل',
    other: '{n} يوم عمل',
  },
};

const arabicPlural = new Intl.PluralRules('ar');

function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

/** "15 minutes", "1 hour" / "15 دقيقة", "ساعة واحدة", "دقيقتان", "3 دقائق". */
export function formatCount(value: number, unit: Unit, locale: Locale): string {
  const n = formatNumber(value, locale);
  if (locale === 'ar') return AR_UNITS[unit][arabicPlural.select(value)].replace('{n}', n);
  const [one, other] = EN_UNITS[unit];
  return `${n} ${value === 1 ? one : other}`;
}

function join(parts: string[], locale: Locale): string {
  return locale === 'ar' ? parts.join(' و') : parts.join(' ');
}

/**
 * An elapsed / remaining time in whole minutes: "45 minutes", "2 hours 5 minutes",
 * "3 days 4 hours" / "45 دقيقة", "ساعتان و5 دقائق". Negative values count as zero; days drop the
 * minutes.
 */
export function formatDurationMinutes(minutes: number, locale: Locale): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return formatCount(m, 'minute', locale);
  const hours = Math.floor(m / 60);
  if (hours < 24) {
    const rest = m % 60;
    return rest === 0
      ? formatCount(hours, 'hour', locale)
      : join([formatCount(hours, 'hour', locale), formatCount(rest, 'minute', locale)], locale);
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0
    ? formatCount(days, 'day', locale)
    : join([formatCount(days, 'day', locale), formatCount(restHours, 'hour', locale)], locale);
}

/**
 * Default length of one business day in business minutes (Sun–Thu 07:30–16:30 = 9 h, spec §13).
 * Senders pass the configured length (decision E12: the ticket form config's
 * `businessDayMinutes`, derived from the business hours); this is only the fallback.
 */
export const BUSINESS_DAY_MINUTES = 9 * 60;
const DAY_MINUTES = 24 * 60;

/**
 * An SLA target window from policy minutes: "15 minutes", "4 business hours", "1 business day",
 * "2 days", "1 hour 30 minutes" / "15 دقيقة", "4 ساعات عمل", "يوم عمل واحد". Business-hours
 * policies say "business" for whole hours and days; a business day is `businessDayMinutes` long
 * (the configured one, E12; 9 h when not given).
 */
export function formatTargetDuration(
  minutes: number,
  businessHoursOnly: boolean,
  locale: Locale,
  businessDayMinutes: number = BUSINESS_DAY_MINUTES,
): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return formatCount(m, 'minute', locale);
  if (businessHoursOnly && businessDayMinutes > 0 && m % businessDayMinutes === 0) {
    return formatCount(m / businessDayMinutes, 'businessDay', locale);
  }
  if (!businessHoursOnly && m % DAY_MINUTES === 0) {
    return formatCount(m / DAY_MINUTES, 'day', locale);
  }
  if (m % 60 === 0) return formatCount(m / 60, businessHoursOnly ? 'businessHour' : 'hour', locale);
  return join(
    [formatCount(Math.floor(m / 60), 'hour', locale), formatCount(m % 60, 'minute', locale)],
    locale,
  );
}

// ---- Ticket variables ----

type DateInput = Date | string | number;

/** What the ticket templates show about a ticket (names already chosen or given per language). */
export interface TicketFacts {
  /** 4821 or "LG-4821". */
  number: number | string;
  subject: string;
  type?: TicketType | null;
  priority: Priority;
  status?: TicketStatus | null;
  teamName?: LocalizedName | null;
  categoryName?: LocalizedName | null;
  subtypeName?: LocalizedName | null;
  orgName?: LocalizedName | null;
  requesterName?: string | null;
  siteName?: LocalizedName | null;
  assetId?: string | null;
  /** Null = "Unassigned". */
  assigneeName?: string | null;
  createdAt?: DateInput | null;
  firstReplyDueAt?: DateInput | null;
  /** Block variable: kept as written (paragraphs, line breaks). */
  description?: string | null;
}

export interface FormatOptions {
  locale: Locale;
  /** IANA zone for dates (AppSetting `business.timezone`, e.g. "Asia/Qatar"). */
  timeZone: string;
}

/**
 * The shared ticket variables of the ticket templates, formatted for `locale`: ticketNumber,
 * ticketSubject, ticketType, priority, ticketStatus, teamName, categoryName, subtypeName, orgName,
 * requesterName, siteName, assetId, assigneeName ("Unassigned" when null), createdAt,
 * firstReplyDueAt and description. Missing values become EMPTY_VALUE ("—"), except description,
 * which stays empty so its paragraph disappears.
 */
export function ticketTemplateVariables(
  ticket: TicketFacts,
  { locale, timeZone }: FormatOptions,
): Record<string, string> {
  const name = (value: LocalizedName | null | undefined) => orEmpty(localizedName(value, locale));
  const date = (value: DateInput | null | undefined) =>
    value === null || value === undefined
      ? EMPTY_VALUE
      : formatEmailDateTime(value, locale, timeZone);
  const assignee = ticket.assigneeName?.trim();
  return {
    ticketNumber:
      typeof ticket.number === 'number' ? formatTicketNumber(ticket.number) : ticket.number,
    ticketSubject: orEmpty(ticket.subject),
    ticketType: ticket.type ? ticketTypeLabel(ticket.type, locale) : EMPTY_VALUE,
    priority: priorityLabel(ticket.priority, locale),
    ticketStatus: ticket.status ? ticketStatusLabel(ticket.status, locale) : EMPTY_VALUE,
    teamName: name(ticket.teamName),
    categoryName: name(ticket.categoryName),
    subtypeName: name(ticket.subtypeName),
    orgName: name(ticket.orgName),
    requesterName: orEmpty(ticket.requesterName),
    siteName: name(ticket.siteName),
    assetId: orEmpty(ticket.assetId),
    assigneeName: assignee ? orEmpty(assignee) : unassignedLabel(locale),
    createdAt: date(ticket.createdAt),
    firstReplyDueAt: date(ticket.firstReplyDueAt),
    description: ticket.description ?? '',
  };
}

// ---- Digest list ----

export interface TicketListItem {
  number: number | string;
  subject: string;
  orgName?: LocalizedName | null;
  createdAt: DateInput;
}

const LIST_SUBJECT_MAX = 80;

const MORE_TICKETS: Readonly<Record<Locale, (n: number) => string>> = {
  en: (n) => `…and ${formatNumber(n, 'en')} more ${n === 1 ? 'ticket' : 'tickets'}`,
  ar: (n) =>
    ({
      zero: `…و${formatNumber(n, 'ar')} تذكرة أخرى`,
      one: '…وتذكرة أخرى',
      two: '…وتذكرتان أخريان',
      few: `…و${formatNumber(n, 'ar')} تذاكر أخرى`,
      many: `…و${formatNumber(n, 'ar')} تذكرة أخرى`,
      other: `…و${formatNumber(n, 'ar')} تذكرة أخرى`,
    })[arabicPlural.select(n)],
};

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max
    ? value
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * The digest's `{{ticketList}}`: one line per ticket, no links —
 * "• LG-4821 · Camera offline in lobby · Qatar Airways · Sep 29, 08:15". Subjects are cut at 80
 * characters; when the lines would pass `maxChars` (BLOCK_MAX_CHARS), the rest is summed up as
 * "…and N more tickets" so the block itself is never cut mid-line.
 */
export function buildTicketList(
  items: readonly TicketListItem[],
  { locale, timeZone, maxChars = BLOCK_MAX_CHARS }: FormatOptions & { maxChars?: number },
): string {
  const lines: string[] = [];
  let length = 0;
  for (const [index, item] of items.entries()) {
    const number = typeof item.number === 'number' ? formatTicketNumber(item.number) : item.number;
    const parts = [
      number,
      clip(orEmpty(item.subject), LIST_SUBJECT_MAX),
      orEmpty(localizedName(item.orgName, locale)),
      formatShortDateTime(item.createdAt, locale, timeZone),
    ];
    const line = `• ${parts.join(' · ')}`;
    const more = MORE_TICKETS[locale](items.length - index - 1);
    const reserve = index < items.length - 1 ? Array.from(more).length + 1 : 0;
    const next = length + (lines.length > 0 ? 1 : 0) + Array.from(line).length;
    if (next + reserve > maxChars && lines.length > 0) {
      lines.push(MORE_TICKETS[locale](items.length - index));
      return lines.join('\n');
    }
    lines.push(line);
    length = next;
  }
  return lines.join('\n');
}

// ---- Links ----

/**
 * The links a ticket notification carries, from APP_URL. `ackUrl` opens the console like
 * `consoleUrl` (D5: nothing acknowledges on GET; the console shows the Acknowledge button).
 */
export function ticketLinks(
  appUrl: string,
  ticketNumber: number | string,
): { portalUrl: string; consoleUrl: string; ackUrl: string } {
  const ref = typeof ticketNumber === 'number' ? formatTicketNumber(ticketNumber) : ticketNumber;
  const base = new URL(appUrl);
  const portal = new URL(`tickets/${encodeURIComponent(ref)}`, withSlash(base));
  const consoleUrl = new URL('console/inbox', withSlash(base));
  consoleUrl.searchParams.set('ticket', ref);
  return {
    portalUrl: portal.toString(),
    consoleUrl: consoleUrl.toString(),
    ackUrl: consoleUrl.toString(),
  };
}

function withSlash(url: URL): URL {
  const copy = new URL(url.toString());
  copy.search = '';
  copy.hash = '';
  if (!copy.pathname.endsWith('/')) copy.pathname = `${copy.pathname}/`;
  return copy;
}
