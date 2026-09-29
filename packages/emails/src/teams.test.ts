import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_CARD_CONTENT_TYPE,
  buildTeamsCard,
  escapeTeamsMarkdown,
  type AdaptiveFactSet,
  type AdaptiveTextBlock,
  type TeamsCardInput,
} from './teams.ts';

const WJ = String.fromCharCode(0x2060); // word joiner
const RLO = String.fromCharCode(0x202e); // right-to-left override
const CONSOLE = 'https://help.example.com/console/inbox?ticket=LG-4821';
/** "](" whose "]" is not backslash-escaped: a Markdown link. */
const UNESCAPED_LINK = /(^|[^\\])\]\(/;

const base: TeamsCardInput = {
  kind: 'P1_CREATED',
  ticketNumber: 4821,
  subject: 'Cameras offline at HQ',
  priority: 'P1',
  teamName: { en: 'SOC', ar: 'مركز العمليات الأمنية (SOC)' },
  orgName: 'Qatar Airways',
  categoryName: 'CCTV & Video Surveillance',
  subtypeName: 'Camera offline',
  step: 1,
  stepCount: 3,
  raisedAt: new Date('2026-09-29T11:05:00Z'),
  timeZone: 'Asia/Qatar',
  ticketUrl: CONSOLE,
  ackUrl: CONSOLE,
};

function card(input: TeamsCardInput = base) {
  return buildTeamsCard(input).attachments[0].content;
}

function texts(input: TeamsCardInput): string[] {
  const c = card(input);
  const out: string[] = [];
  for (const el of c.body) {
    if (el.type === 'TextBlock') out.push((el as AdaptiveTextBlock).text);
    else for (const f of (el as AdaptiveFactSet).facts) out.push(f.title, f.value);
  }
  return out;
}

describe('escapeTeamsMarkdown', () => {
  it('neutralizes a Markdown link and the URL inside it', () => {
    const out = escapeTeamsMarkdown('[x](http://evil)');
    expect(out).toBe(`\\[x\\](http:${WJ}//evil)`);
    expect(out).not.toContain('[x](');
    expect(out).not.toContain('http://');
  });

  it('escapes emphasis, code, strike-through, tables and HTML / mention tags', () => {
    expect(escapeTeamsMarkdown('**bold** _it_ `code` ~~s~~ a|b')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~s\\~\\~ a\\|b',
    );
    expect(escapeTeamsMarkdown('<at>Bob</at> <b>x</b> &lt;')).toBe(
      '\\<at\\>Bob\\</at\\> \\<b\\>x\\</b\\> \\&lt;',
    );
    expect(escapeTeamsMarkdown('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes list and heading markers at the start', () => {
    expect(escapeTeamsMarkdown('# Heading')).toBe('\\# Heading');
    expect(escapeTeamsMarkdown('- item')).toBe('\\- item');
    expect(escapeTeamsMarkdown('+ item')).toBe('\\+ item');
    expect(escapeTeamsMarkdown('1. item')).toBe('1\\. item');
    expect(escapeTeamsMarkdown('2) item')).toBe('2\\) item');
    expect(escapeTeamsMarkdown('Al-Kuwari 1. x')).toBe('Al-Kuwari 1. x');
  });

  it('breaks bare URLs, domains and e-mail addresses so Teams cannot auto-link them', () => {
    expect(escapeTeamsMarkdown('see https://evil.example/x')).toBe(
      `see https:${WJ}//evil${WJ}.example/x`,
    );
    expect(escapeTeamsMarkdown('www.evil.com')).toBe(`www${WJ}.evil${WJ}.com`);
    expect(escapeTeamsMarkdown('a@b.co')).toBe(`a@${WJ}b${WJ}.co`);
    expect(escapeTeamsMarkdown('Version 1. Done.')).toBe('Version 1. Done.');
  });

  it('keeps one line, drops control and bidi-override characters, cuts long values', () => {
    expect(escapeTeamsMarkdown('line one\n\n- line two\r\n')).toBe('line one - line two');
    expect(escapeTeamsMarkdown(`abc${RLO}def${String.fromCharCode(0)}`)).toBe('abcdef');
    const long = escapeTeamsMarkdown('a'.repeat(300));
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(escapeTeamsMarkdown('مرحبا بالعالم')).toBe('مرحبا بالعالم');
  });
});

describe('buildTeamsCard', () => {
  it('wraps an Adaptive Card 1.4 in the message envelope webhooks and workflows accept', () => {
    const msg = buildTeamsCard(base);
    expect(msg.type).toBe('message');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].contentType).toBe(ADAPTIVE_CARD_CONTENT_TYPE);
    expect(msg.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(msg.attachments[0].contentUrl).toBeNull();
    const c = msg.attachments[0].content;
    expect(c.type).toBe('AdaptiveCard');
    expect(c.version).toBe('1.4');
    expect(c.$schema).toBe('http://adaptivecards.io/schemas/adaptive-card.json');
    expect(Object.keys(msg).sort()).toEqual(['attachments', 'type']);
    // Round-trips as JSON (what the provider POSTs).
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });

  it('shows the facts: number, priority, team, client, category, step, raised', () => {
    const facts = (card().body.find((el) => el.type === 'FactSet') as AdaptiveFactSet).facts;
    expect(facts).toEqual([
      { title: 'Ticket', value: 'LG-4821' },
      { title: 'Priority', value: 'P1 Critical' },
      { title: 'Team', value: 'SOC' }, // English (D7)
      { title: 'Client', value: 'Qatar Airways' },
      { title: 'Category', value: 'CCTV \\& Video Surveillance › Camera offline' },
      { title: 'Escalation step', value: '1 of 3' },
      { title: 'Raised', value: 'Tue, Sep 29, 2026, 14:05 GMT+3' },
    ]);
    expect((card().body[0] as AdaptiveTextBlock).text).toBe('P1 critical ticket · LG-4821');
  });

  it('has exactly two OpenUrl buttons, Open ticket and Acknowledge, to the given console URLs', () => {
    const ack = `${CONSOLE}&focus=ack`;
    const c = card({ ...base, ackUrl: ack });
    expect(c.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open ticket', url: CONSOLE },
      { type: 'Action.OpenUrl', title: 'Acknowledge', url: ack, style: 'positive' },
    ]);
  });

  it('refuses an acknowledge-on-GET URL and non-http(s) or relative URLs', () => {
    expect(() =>
      buildTeamsCard({ ...base, ackUrl: 'https://api.example.com/tickets/abc/acknowledge' }),
    ).toThrow(/acknowledge on GET/);
    expect(() =>
      buildTeamsCard({ ...base, ackUrl: 'https://api.example.com/tickets/abc/ACKNOWLEDGE/' }),
    ).toThrow(/acknowledge on GET/);
    expect(() => buildTeamsCard({ ...base, ticketUrl: 'javascript:alert(1)' })).toThrow(/http/);
    expect(() => buildTeamsCard({ ...base, ticketUrl: '/console/inbox' })).toThrow(/absolute/);
  });

  it('escapes every client-supplied string (subject, names)', () => {
    const hostile: TeamsCardInput = {
      ...base,
      kind: 'P1_ESCALATED',
      step: 2,
      subject: '[Click here](http://evil.example) **URGENT** <at>Everyone</at>',
      orgName: '_Org_ [a](b)',
      teamName: '# SOC',
      categoryName: '<b>CCTV</b>',
      subtypeName: 'x|y',
      minutesUnacknowledged: 5,
    };
    const all = texts(hostile);
    const joined = all.join('\n');
    // No unescaped Markdown / HTML syntax character anywhere in the card text.
    for (const text of all) expect(text, text).not.toMatch(/(^|[^\\])[*_[\]<>`~|]/);
    expect(joined).not.toMatch(UNESCAPED_LINK); // no unescaped "]("
    expect(joined).not.toContain('http://');
    expect(joined).toContain('\\[Click here\\]');
    expect(joined).toContain('\\*\\*URGENT\\*\\*');
    expect(joined).toContain('\\<at\\>Everyone\\</at\\>');
    expect(joined).toContain('\\# SOC');
    const c = card(hostile);
    expect(c.fallbackText).not.toMatch(UNESCAPED_LINK);
    expect((c.body[0] as AdaptiveTextBlock).text).toBe('P1 escalation · step 2 of 3 · LG-4821');
    expect((c.body[2] as AdaptiveTextBlock).text).toBe(
      'Not acknowledged after 5 min. Acknowledge it in the console.',
    );
    // The only URLs in the card are the two buttons (and the schema).
    const urls = JSON.stringify(c).match(/https?:\/\/[^"\s]+/g) ?? [];
    expect(urls.sort()).toEqual(
      [CONSOLE, CONSOLE, 'http://adaptivecards.io/schemas/adaptive-card.json'].sort(),
    );
  });

  it('escapes a ticket number given as text and omits optional facts', () => {
    const c = card({
      ...base,
      ticketNumber: 'LG-9*',
      stepCount: null,
      raisedAt: null,
      subtypeName: null,
    });
    const facts = (c.body.find((el) => el.type === 'FactSet') as AdaptiveFactSet).facts;
    expect(facts.map((f) => f.title)).not.toContain('Raised');
    expect(facts.find((f) => f.title === 'Ticket')?.value).toBe('LG-9\\*');
    expect(facts.find((f) => f.title === 'Escalation step')?.value).toBe('1');
    expect(facts.find((f) => f.title === 'Category')?.value).toBe('CCTV \\& Video Surveillance');
  });
});
