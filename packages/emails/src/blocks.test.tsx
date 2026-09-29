import { describe, expect, it } from 'vitest';
import {
  BLOCK_MAX_CHARS,
  BLOCK_VARIABLES,
  blockParagraphs,
  normalizeBlockText,
  truncateBlockText,
} from './blocks.ts';
import { renderTemplateEmail } from './render.tsx';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
/** React inserts `<!-- -->` between adjacent text nodes. */
const gap = '(?:<!-- -->)?';

/** The body paragraphs of the text part (between the subject and the footer). */
function bodyOf(text: string): string {
  const parts = text.split('\n\n—\n\n')[0] ?? '';
  return parts.slice(parts.indexOf('\n\n') + 2);
}

describe('truncateBlockText / blockParagraphs', () => {
  it('lists the block variables and the limit', () => {
    expect(BLOCK_VARIABLES).toEqual(['description', 'messageBody', 'ticketList']);
    expect(BLOCK_MAX_CHARS).toBe(2000);
  });

  it('keeps short values (trimmed) and cuts long ones to 2,000 characters ending in "…"', () => {
    expect(truncateBlockText('  hello \n')).toEqual({ text: 'hello', truncated: false });
    const exact = 'a'.repeat(2000);
    expect(truncateBlockText(exact)).toEqual({ text: exact, truncated: false });
    const cut = truncateBlockText('a'.repeat(2001));
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.text)).toHaveLength(2000);
    expect(cut.text.endsWith('a…')).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateBlockText('🔥'.repeat(2500));
    expect(Array.from(cut.text)).toHaveLength(2000);
    expect(cut.text).toBe(`${'🔥'.repeat(1999)}…`);
  });

  it('cuts at a line break near the end so a list line is not broken', () => {
    const line = `${'x'.repeat(99)}\n`; // 100 characters per line
    const cut = truncateBlockText(line.repeat(30));
    expect(cut.truncated).toBe(true);
    expect(
      cut.text.split('\n').every((l) => l === 'x'.repeat(99) || l === `${'x'.repeat(99)}…`),
    ).toBe(true);
  });

  it('normalizes CRLF, CR and the Unicode separators, and drops control characters', () => {
    expect(
      normalizeBlockText(
        `a\r\nb\rc${LINE_SEPARATOR}d${PARAGRAPH_SEPARATOR}e${String.fromCharCode(0)}f${String.fromCharCode(7)}`,
      ),
    ).toBe('a\nb\nc\nd\n\nef');
  });

  it('splits paragraphs at blank lines and keeps line breaks inside them', () => {
    expect(blockParagraphs('one\ntwo  \n \n\n\nthree\n')).toEqual([['one', 'two'], ['three']]);
    expect(blockParagraphs('   \n')).toEqual([]);
  });
});

describe('block variables in renderTemplateEmail', () => {
  const body = 'Intro line.\n\n{{messageBody}}\n\nOutro line.';

  it('keeps paragraphs and line breaks when the placeholder is a whole paragraph', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { messageBody: 'First line\nSecond line\n\nSecond paragraph' },
    });
    expect(out.html).toMatch(new RegExp(`First line${gap}<br/?>${gap}Second line`));
    expect(out.html).toMatch(/<p[^>]*>Second paragraph<\/p>/);
    expect(bodyOf(out.text)).toBe(
      'Intro line.\n\nFirst line\nSecond line\n\nSecond paragraph\n\nOutro line.',
    );
  });

  it('never linkifies a URL written in the message (HTML and text parts)', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: {
        messageBody:
          'Please verify at https://loons-support.evil.example/login\nor www.evil.example',
      },
    });
    expect(out.html).not.toContain('href="https://loons-support.evil.example');
    expect(out.html).not.toMatch(/href="[^"]*evil/);
    expect(out.html).toContain('Please verify at https://loons-support.evil.example/login');
    expect(out.text).toContain(
      'Please verify at https://loons-support.evil.example/login\nor www.',
    );
  });

  it('escapes markup like every other value', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { messageBody: '<b>bold</b>\n<script>alert(1)</script>\n<a href="x">y</a>' },
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).not.toContain('<b>bold</b>');
    expect(out.html).not.toContain('<a href="x">');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.text).toContain('<b>bold</b>\n<script>alert(1)</script>');
  });

  it('leaves no empty paragraph for an empty value', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { messageBody: '  \n\n ' },
    });
    expect(bodyOf(out.text)).toBe('Intro line.\n\nOutro line.');
    expect(out.html).not.toMatch(/<p[^>]*><\/p>/);
  });

  it('collapses a block variable used mid-sentence onto one line', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Summary: {{description}} (from the form)\n\nNext.',
      variables: { description: 'Door 3\nreader offline\n\nsince 08:00 https://evil.example' },
    });
    expect(bodyOf(out.text)).toBe(
      'Summary: Door 3 reader offline since 08:00 https://evil.example (from the form)\n\nNext.',
    );
    expect(out.html).not.toMatch(/Door 3(<!-- -->)?<br/);
    expect(out.html).not.toContain('href="https://evil.example');
  });

  it('collapses it when the paragraph also holds template text on another line', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Description:\n{{description}}',
      variables: { description: 'a\n\nb' },
    });
    expect(bodyOf(out.text)).toBe('Description:\na b');
  });

  it('cuts a long whole-paragraph value and adds the localized "view the full message" line', async () => {
    const long = `${'word '.repeat(600)}END`; // 3,003 characters
    const en = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { messageBody: long },
      viewFullIn: 'portal',
    });
    const paragraphs = bodyOf(en.text).split('\n\n');
    expect(paragraphs[0]).toBe('Intro line.');
    expect(Array.from(paragraphs[1] ?? '').length).toBeLessThanOrEqual(2000);
    expect(paragraphs[1]?.endsWith('…')).toBe(true);
    expect(en.text).not.toContain('END');
    expect(paragraphs[2]).toBe(
      'This message has been shortened. View the full message in the portal.',
    );
    expect(paragraphs[3]).toBe('Outro line.');
    expect(en.html).toContain('View the full message in the portal.');

    const ar = await renderTemplateEmail({
      locale: 'ar',
      subject: 's',
      body,
      variables: { messageBody: long },
      viewFullIn: 'console',
    });
    expect(ar.text).toContain('تم اختصار هذه الرسالة. اطّلع على الرسالة كاملة في وحدة التحكم.');
  });

  it('cuts a long mid-sentence value too, with the note after its paragraph', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Said: {{messageBody}}\n\nBye.',
      variables: { messageBody: 'y'.repeat(2500) },
      viewFullIn: 'console',
    });
    const paragraphs = bodyOf(out.text).split('\n\n');
    expect(paragraphs[0]).toBe(`Said: ${'y'.repeat(1999)}…`);
    expect(paragraphs[1]).toBe(
      'This message has been shortened. View the full message in the console.',
    );
    expect(paragraphs[2]).toBe('Bye.');
  });

  it('uses the list wording for ticketList and a neutral line without a surface', async () => {
    const list = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: '{{ticketList}}',
      variables: { ticketList: `${'• LG-1 · x\n'.repeat(300)}` },
      viewFullIn: 'console',
    });
    expect(list.text).toContain('This list has been shortened. View all tickets in the console.');
    const neutral = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: '{{description}}',
      variables: { description: 'z'.repeat(2100) },
    });
    expect(neutral.text).toContain(
      'This message has been shortened. Open the ticket to read the full message.',
    );
  });

  it('does not add the note for a value at exactly the limit', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { messageBody: 'q'.repeat(2000) },
    });
    expect(out.text).toContain('q'.repeat(2000));
    expect(out.text).not.toContain('shortened');
  });

  it('keeps other (non-block) values on one line even when they are a whole paragraph', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Hi\n\n{{requesterName}}\n\nBye',
      variables: { requesterName: 'Ada\n\nFake paragraph' },
    });
    expect(bodyOf(out.text)).toBe('Hi\n\nAda Fake paragraph\n\nBye');
  });
});

describe('greeting', () => {
  const body = 'Hi {{name}},\n\nA ticket for {{teamName}}.';

  it('keeps "Hi {{name}}," for a person and drops it for a list or a blank name', async () => {
    const person = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { name: 'Ada', teamName: 'SOC' },
    });
    expect(bodyOf(person.text)).toBe('Hi Ada,\n\nA ticket for SOC.');

    const list = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { name: 'Ada', teamName: 'SOC' },
      greeting: false,
    });
    expect(bodyOf(list.text)).toBe('A ticket for SOC.');
    expect(list.html).not.toContain('Hi ');

    const blank = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body,
      variables: { name: '  ', teamName: 'SOC' },
    });
    expect(bodyOf(blank.text)).toBe('A ticket for SOC.');
  });

  it('only drops a short first paragraph that uses {{name}}', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'A new ticket has been routed to {{teamName}}.\n\nHi {{name}}, more.',
      variables: { teamName: 'SOC' },
      greeting: false,
    });
    expect(bodyOf(out.text)).toBe('A new ticket has been routed to SOC.\n\nHi , more.');
    const long = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: '{{name}}, your ticket was updated by the team today.',
      variables: {},
      greeting: false,
    });
    expect(bodyOf(long.text)).toBe(', your ticket was updated by the team today.');
  });
});

describe('bidi controls from client text (security review)', () => {
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const PDI = String.fromCharCode(0x2069);
  const BIDI = /[\u202A-\u202E\u2066-\u2069]/;

  it('are removed from the subject, inline values and block values (HTML and text)', async () => {
    const email = await renderTemplateEmail({
      locale: 'en',
      subject: 'P1 CRITICAL [LG-1] {{ticketSubject}} — {{orgName}}',
      body: 'Subject: {{ticketSubject}}\n\n{{description}}',
      variables: {
        ticketSubject: `Door ${RLO}gnp.exe${LRI}x${PDI}`,
        orgName: 'Hamad',
        description: `First ${RLO}line\n\nSecond${PDI}`,
      },
    });
    expect(email.subject).toBe('P1 CRITICAL [LG-1] Door gnp.exex — Hamad');
    expect(email.subject).not.toMatch(BIDI);
    expect(email.text).not.toMatch(BIDI);
    expect(email.html).not.toMatch(BIDI);
    expect(normalizeBlockText(`a${RLO}b${LRI}c${PDI}`)).toBe('abc');
  });
});
