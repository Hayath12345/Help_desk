import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  UPLOAD_MIME_EXTENSIONS,
  createMessageSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  presignAttachmentSchema,
  requesterSearchQuerySchema,
  stripControlChars,
  toWellFormed,
  updateTicketSchema,
} from './tickets.ts';

const UUID = '00000000-0000-4000-8000-000000000001';

const ticket = (over: Record<string, unknown> = {}) => ({
  type: 'INCIDENT',
  categoryId: UUID,
  subtypeId: UUID,
  impact: 'SINGLE_USER',
  siteId: UUID,
  subject: 'Door stuck',
  description: 'The access door on level 2 does not open.',
  ...over,
});

describe('presignAttachmentSchema: the file name is cleaned (review RR-SEC-3)', () => {
  const presign = (fileName: string) =>
    presignAttachmentSchema.parse({ fileName, mimeType: 'text/plain', sizeBytes: 3 }).fileName;

  it('replaces lone surrogates and drops control characters', () => {
    expect(presign('r\udc00\ud800.txt')).toBe('r��.txt');
    expect(presign('a\u0000b\u0007c.txt')).toBe('abc.txt');
    expect(presign('  😀 notes.txt ')).toBe('😀 notes.txt');
  });

  it('still refuses empty and over-long names', () => {
    const parse = (fileName: string) =>
      presignAttachmentSchema.safeParse({ fileName, mimeType: 'text/plain', sizeBytes: 3 }).success;
    expect(parse('\u0000 ')).toBe(false);
    expect(parse('a'.repeat(256))).toBe(false);
    expect(parse('a'.repeat(255))).toBe(true);
  });
});

describe('free text: control characters (review SEC-API-2)', () => {
  it('stripControlChars drops C0 controls and DEL but keeps tabs and line breaks', () => {
    expect(stripControlChars('a\u0000b\u0001c\u0008d\u000be\u000cf\u001fg\u007fh')).toBe(
      'abcdefgh',
    );
    expect(stripControlChars('line 1\r\nline 2\tcol')).toBe('line 1\r\nline 2\tcol');
    expect(stripControlChars('تقرير — ok')).toBe('تقرير — ok');
  });

  it('ticket subject, description and asset id are cleaned before the length rules', () => {
    const parsed = createTicketSchema.parse(
      ticket({
        subject: ' \u0000a\u0000b ',
        description: 'long enough \u0000description\u0007 here',
        assetId: 'CAM\u0000-014',
      }),
    );
    expect(parsed.subject).toBe('ab');
    expect(parsed.description).toBe('long enough description here');
    expect(parsed.assetId).toBe('CAM-014');
    // Nothing but control characters is empty.
    const empty = createTicketSchema.safeParse(ticket({ subject: '\u0000\u0001' }));
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe('validation.subjectRequired');
  });

  it('message bodies, searches and PATCH asset ids are cleaned too', () => {
    expect(
      createMessageSchema.parse({ type: 'PUBLIC', body: 'hi\u0000there\n', clientTempId: UUID })
        .body,
    ).toBe('hithere');
    expect(
      createMessageSchema.safeParse({ type: 'PUBLIC', body: '\u0000', clientTempId: UUID }).success,
    ).toBe(false);
    expect(listTicketsQuerySchema.parse({ search: '\u0000abc' }).search).toBe('abc');
    expect(requesterSearchQuerySchema.parse({ search: 'ai\u0000sha' }).search).toBe('aisha');
    expect(updateTicketSchema.parse({ assetId: 'FW\u0000-01' }).assetId).toBe('FW-01');
    // Tags keep their strict format (a control character is rejected, not rewritten).
    expect(updateTicketSchema.safeParse({ tags: ['a\u0000b'] }).success).toBe(false);
  });

  it('the field schemas stay reusable on their own (web forms use `.shape`)', () => {
    expect(createTicketSchema.shape.subject.parse('  a\u0000 ')).toBe('a');
    expect(createMessageSchema.shape.body.safeParse('').success).toBe(false);
  });
});

describe('free text: lone surrogates (re-review RR-SEC-3)', () => {
  it('toWellFormed replaces unpaired surrogates with U+FFFD and keeps valid pairs', () => {
    expect(toWellFormed('x\ud800y')).toBe('x�y'); // lone high surrogate
    expect(toWellFormed('x\udc00y')).toBe('x�y'); // lone low surrogate
    expect(toWellFormed('😀 \ud800 عربي')).toBe('😀 � عربي');
    expect(toWellFormed('\udc00\ud800')).toBe('��'); // reversed halves are two lone ones
    expect(toWellFormed('plain')).toBe('plain');
    // Same result as the ES2024 method where it exists.
    const native = (String.prototype as { toWellFormed?: () => string }).toWellFormed;
    if (native) expect(toWellFormed('a\ud800b\udfffc😀')).toBe(native.call('a\ud800b\udfffc😀'));
  });

  it('every cleaned text field is well-formed (jsonb refuses a lone surrogate)', () => {
    const parsed = createTicketSchema.parse(
      ticket({
        subject: 'S \ud800 x',
        description: 'long enough \udc00description here',
        assetId: 'A\ud800',
      }),
    );
    expect(parsed.subject).toBe('S � x');
    expect(parsed.description).toBe('long enough �description here');
    expect(parsed.assetId).toBe('A�');
    expect(
      createMessageSchema.parse({ type: 'PUBLIC', body: 'hi \ud800', clientTempId: UUID }).body,
    ).toBe('hi �');
    expect(listTicketsQuerySchema.parse({ search: 'abc\ud800' }).search).toBe('abc�');
    expect(updateTicketSchema.parse({ assetId: '\ud800FW' }).assetId).toBe('�FW');
    // Control characters and lone surrogates together; a surrogate-only value is not blank.
    expect(createTicketSchema.shape.subject.parse(' \u0000\ud800 ')).toBe('�');
  });
});

describe('UPLOAD_MIME_EXTENSIONS (review SEC-ATT-2)', () => {
  it('lists lower-case extensions for every allowed MIME type', () => {
    expect(Object.keys(UPLOAD_MIME_EXTENSIONS).sort()).toEqual(
      [...ALLOWED_UPLOAD_MIME_TYPES].sort(),
    );
    for (const extensions of Object.values(UPLOAD_MIME_EXTENSIONS)) {
      expect(extensions.length).toBeGreaterThan(0);
      for (const ext of extensions) expect(ext).toMatch(/^[a-z0-9]{1,10}$/);
    }
    expect(UPLOAD_MIME_EXTENSIONS['application/pdf'][0]).toBe('pdf');
    expect(UPLOAD_MIME_EXTENSIONS['text/plain']).toContain('log');
  });
});
