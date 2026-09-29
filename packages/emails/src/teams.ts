// Microsoft Teams card for P1 alerts (spec §9, contract D4 / D5 / D7): one Adaptive Card per
// "P1 created" and per escalation step that has the TEAMS channel, posted to the team's webhook.
//
// Envelope: `{ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive',
// contentUrl: null, content: <AdaptiveCard> }] }` — the shape Microsoft documents for both legacy
// Office 365 connector incoming webhooks and the Power Automate "Post to a channel when a webhook
// request is received" workflow (which reads `attachments[].content`). Card schema 1.4 (Teams
// renders up to 1.5 on desktop / mobile; 1.4 is the documented ceiling for webhooks). Only
// `Action.OpenUrl` is used: incoming webhooks cannot run `Action.Submit` / `Action.Execute`.
//
// Teams renders Markdown in TextBlock text and in FactSet titles / values, and turns bare URLs
// and domains into links. Every value that comes from a person (subject, names) goes through
// `escapeTeamsMarkdown`, so the only links in a card are its two buttons, which open the console
// (never a URL that acknowledges on GET). Cards are English (D7).

import { formatTicketNumber, type Priority } from '@loons/shared';
import { formatEmailDateTime, localizedName, priorityLabel, type LocalizedName } from './format.ts';

export const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';
export const ADAPTIVE_CARD_VERSION = '1.4';

export interface AdaptiveTextBlock {
  type: 'TextBlock';
  text: string;
  wrap: true;
  size?: 'Small' | 'Default' | 'Medium' | 'Large';
  weight?: 'Default' | 'Bolder';
  color?: 'Default' | 'Attention' | 'Warning' | 'Good' | 'Accent';
  isSubtle?: boolean;
  spacing?: 'None' | 'Small' | 'Medium';
}

export interface AdaptiveFactSet {
  type: 'FactSet';
  facts: { title: string; value: string }[];
}

export interface AdaptiveOpenUrlAction {
  type: 'Action.OpenUrl';
  title: string;
  url: string;
  style?: 'default' | 'positive' | 'destructive';
}

export interface AdaptiveCard {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json';
  type: 'AdaptiveCard';
  version: typeof ADAPTIVE_CARD_VERSION;
  /** Plain text for clients that can't render the card (notifications, previews). */
  fallbackText: string;
  msteams: { width: 'Full' };
  body: (AdaptiveTextBlock | AdaptiveFactSet)[];
  actions: AdaptiveOpenUrlAction[];
}

/** The JSON body POSTed to a Teams incoming webhook / Power Automate workflow URL. */
export interface TeamsMessage {
  type: 'message';
  attachments: [
    { contentType: typeof ADAPTIVE_CARD_CONTENT_TYPE; contentUrl: null; content: AdaptiveCard },
  ];
}

export type TeamsCardKind = 'P1_CREATED' | 'P1_ESCALATED';

export interface TeamsCardInput {
  kind: TeamsCardKind;
  /** 4821 or "LG-4821". */
  ticketNumber: number | string;
  /** Client-written: escaped, cut at 200 characters. */
  subject: string;
  priority: Priority;
  teamName: LocalizedName;
  orgName: LocalizedName;
  categoryName: LocalizedName;
  subtypeName?: LocalizedName | null;
  /** Escalation step this card belongs to (P1 created = step 1, D4). */
  step: number;
  /** Steps in the active chain, for "2 of 3"; omitted = "2". */
  stepCount?: number | null;
  /** P1_ESCALATED: minutes since the ticket became P1. */
  minutesUnacknowledged?: number | null;
  /** When the ticket became P1 (shown with `timeZone`). */
  raisedAt?: Date | string | number | null;
  /** IANA zone for `raisedAt` (AppSetting `business.timezone`). */
  timeZone?: string;
  /** Console link to the ticket (`/console/inbox?ticket=LG-n`). */
  ticketUrl: string;
  /** Console link where the Acknowledge button is (D5). Must not acknowledge on GET. */
  ackUrl: string;
}

// ---- Escaping ----

const WORD_JOINER = '\u2060';
/** Bidi overrides / isolates (reordering tricks) and control characters, dropped from values. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
/** Characters that start or end Markdown / HTML syntax anywhere in a line. */
const MARKDOWN_SPECIALS = /[\\`*_~[\]<>|&]/g;

function clipText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max
    ? value
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * Makes a person-written value inert in a Teams Markdown TextBlock / Fact: one line, no control or
 * bidi-override characters, cut at `maxLength`, Markdown punctuation backslash-escaped
 * (CommonMark), a leading list / heading marker escaped, and bare URLs, domains and e-mail
 * addresses broken with an invisible word joiner so Teams can't auto-link them.
 */
export function escapeTeamsMarkdown(value: string, maxLength = 200): string {
  const line = value
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(UNSAFE_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return (
    clipText(line, maxLength)
      .replace(MARKDOWN_SPECIALS, (ch) => `\\${ch}`)
      // "# x", "- x", "+ x", "1. x" / "1) x" at the start of the text.
      .replace(/^([#+-])/, '\\$1')
      .replace(/^(\d+)([.)])/, '$1\\$2')
      // Auto-links: "http://", "www.", "evil.com", "a@b".
      .replace(/:\/\//g, `:${WORD_JOINER}//`)
      .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, `${WORD_JOINER}.`)
      .replace(/@/g, `@${WORD_JOINER}`)
  );
}

// ---- Card ----

function requireConsoleUrl(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Teams card: ${what} is not an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Teams card: ${what} must be http(s)`);
  }
  // D5: a link preview or safe-links scanner fetches every URL in a card.
  if (/\/acknowledge\/?$/i.test(url.pathname)) {
    throw new Error(`Teams card: ${what} must open the console, not acknowledge on GET`);
  }
  return url.toString();
}

/**
 * The Teams message for a P1 created / escalated alert: title, subject, FactSet (ticket,
 * priority, team, client, category, escalation step, raised / unacknowledged time) and two
 * `Action.OpenUrl` buttons, "Open ticket" and "Acknowledge", pointing at the given console URLs.
 * Throws when a URL is not absolute http(s) or points at an acknowledge endpoint.
 */
export function buildTeamsCard(input: TeamsCardInput): TeamsMessage {
  const ticketUrl = requireConsoleUrl(input.ticketUrl, 'ticketUrl');
  const ackUrl = requireConsoleUrl(input.ackUrl, 'ackUrl');
  const number =
    typeof input.ticketNumber === 'number'
      ? formatTicketNumber(input.ticketNumber)
      : escapeTeamsMarkdown(input.ticketNumber, 20);
  const name = (value: LocalizedName | null | undefined) =>
    escapeTeamsMarkdown(localizedName(value, 'en'), 80) || '—';
  const subject = escapeTeamsMarkdown(input.subject, 200) || '—';
  const team = name(input.teamName);
  const org = name(input.orgName);
  const subtype = input.subtypeName ? name(input.subtypeName) : '';
  const category = subtype ? `${name(input.categoryName)} › ${subtype}` : name(input.categoryName);
  const step = input.stepCount ? `${input.step} of ${input.stepCount}` : String(input.step);
  const escalated = input.kind === 'P1_ESCALATED';

  const title = escalated
    ? `P1 escalation · step ${step} · ${number}`
    : `P1 critical ticket · ${number}`;
  const lead = escalated
    ? `Not acknowledged${
        input.minutesUnacknowledged != null
          ? ` after ${Math.max(0, Math.round(input.minutesUnacknowledged))} min`
          : ''
      }. Acknowledge it in the console.`
    : 'Needs acknowledgement now. Acknowledge it in the console.';

  const facts = [
    { title: 'Ticket', value: number },
    { title: 'Priority', value: priorityLabel(input.priority, 'en') },
    { title: 'Team', value: team },
    { title: 'Client', value: org },
    { title: 'Category', value: category },
    { title: 'Escalation step', value: step },
  ];
  if (input.raisedAt != null) {
    facts.push({
      title: 'Raised',
      value: escapeTeamsMarkdown(
        formatEmailDateTime(input.raisedAt, 'en', input.timeZone ?? 'UTC'),
      ),
    });
  }

  const summary = `${title} — ${team} — ${org}`;
  return {
    type: 'message',
    attachments: [
      {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: ADAPTIVE_CARD_VERSION,
          fallbackText: `${summary}: ${subject}`,
          msteams: { width: 'Full' },
          body: [
            {
              type: 'TextBlock',
              text: title,
              wrap: true,
              size: 'Medium',
              weight: 'Bolder',
              color: 'Attention',
            },
            { type: 'TextBlock', text: subject, wrap: true, weight: 'Bolder', spacing: 'Small' },
            { type: 'TextBlock', text: lead, wrap: true, isSubtle: true, spacing: 'Small' },
            { type: 'FactSet', facts },
          ],
          actions: [
            { type: 'Action.OpenUrl', title: 'Open ticket', url: ticketUrl },
            { type: 'Action.OpenUrl', title: 'Acknowledge', url: ackUrl, style: 'positive' },
          ],
        },
      },
    ],
  };
}
