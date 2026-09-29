// Reply macros (design console composer): localised title/body, placeholder filling and the
// status a macro applies when the reply is sent.

import {
  STAFF_SETTABLE_STATUSES,
  staffCanSetStatus,
  statusAfterMessage,
  type Locale,
  type MacroDto,
  type TicketStatus,
  type TicketSummaryDto,
} from '@loons/shared';
import { firstNameOf } from '@/lib/format';
import { placeName } from '@/lib/tickets/labels';

/** Values of the placeholders a macro body may contain ({{requesterFirstName}}, {{siteName}}). */
export interface MacroContext {
  requesterFirstName: string;
  siteName: string;
}

const PLACEHOLDER = /\{\{\s*(requesterFirstName|siteName)\s*\}\}/g;

const pick = (locale: Locale, en: string, ar: string) =>
  locale === 'ar' && ar.trim() !== '' ? ar : en;

export function macroTitle(macro: Pick<MacroDto, 'titleEn' | 'titleAr'>, locale: Locale): string {
  return pick(locale, macro.titleEn, macro.titleAr);
}

/** Body in the UI language (empty Arabic falls back to English), placeholders not yet filled. */
export function macroBody(macro: Pick<MacroDto, 'bodyEn' | 'bodyAr'>, locale: Locale): string {
  return pick(locale, macro.bodyEn, macro.bodyAr);
}

/** Placeholder values for a ticket: the requester's first name and the site (else the client). */
export function macroContext(
  ticket: Pick<TicketSummaryDto, 'requester' | 'site' | 'org'>,
  locale: Locale,
): MacroContext {
  return {
    requesterFirstName: firstNameOf(ticket.requester.name),
    siteName: ticket.site ? placeName(ticket.site, locale) : placeName(ticket.org, locale),
  };
}

/** Replaces the known placeholders; unknown `{{…}}` stay visible so the agent can fix them. */
export function fillMacro(body: string, context: MacroContext): string {
  return body.replace(PLACEHOLDER, (_, key: keyof MacroContext) => context[key]);
}

/** Appends macro text to a draft, separated by a blank line (design: `text + '\n\n' + macro`). */
export function appendToDraft(draft: string, text: string): string {
  const head = draft.replace(/\s+$/u, '');
  return head ? `${head}\n\n${text}` : text;
}

/**
 * How a send carries out a macro's `setStatus`:
 * - `andSolve`: a public reply that should solve the ticket uses "Send & solve".
 * - `followUp`: the status to PATCH once the message is stored (when the message alone would
 *   leave the ticket elsewhere, e.g. an internal note with "Pending"). `null` = nothing to do.
 */
export function macroStatusPlan(input: {
  current: TicketStatus;
  armed: TicketStatus | null;
  type: 'PUBLIC' | 'INTERNAL';
  andSolve: boolean;
}): { andSolve: boolean; followUp: StaffSettableStatus | null } {
  const { current, armed, type } = input;
  let andSolve = input.andSolve;
  if (armed === 'SOLVED' && type === 'PUBLIC') andSolve = true;
  const after = statusAfterMessage({ current, author: 'staff', type, andSolve }) ?? current;
  const followUp =
    armed && isStaffSettable(armed) && armed !== after && staffCanSetStatus(after, armed)
      ? armed
      : null;
  return { andSolve, followUp };
}

type StaffSettableStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

function isStaffSettable(status: TicketStatus): status is StaffSettableStatus {
  return (STAFF_SETTABLE_STATUSES as readonly TicketStatus[]).includes(status);
}
