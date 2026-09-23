import { describe, expect, it, vi } from 'vitest';
import { escapeHtml, interpolate, templateVariables } from './interpolate.ts';

describe('interpolate', () => {
  it('replaces placeholders, with or without inner spaces', () => {
    expect(interpolate('Hi {{name}}, ticket {{ ticketNumber }}.', { name: 'Ada', ticketNumber: 'LG-4817' })).toBe(
      'Hi Ada, ticket LG-4817.',
    );
  });

  it('stringifies numbers and booleans and repeats placeholders', () => {
    expect(interpolate('{{n}} + {{n}} = {{sum}} ({{ok}})', { n: 2, sum: 4, ok: true })).toBe('2 + 2 = 4 (true)');
  });

  it('replaces unknown / null placeholders with an empty string and reports them', () => {
    const onMissing = vi.fn();
    expect(interpolate('[{{a}}][{{b}}][{{c}}]', { a: null, b: undefined }, { onMissing })).toBe('[][][]');
    expect(onMissing.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('never reads inherited properties', () => {
    expect(interpolate('{{constructor}}{{toString}}{{__proto__}}', {})).toBe('');
  });

  it('supports dotted names and leaves non-placeholders alone', () => {
    expect(interpolate('{{ticket.id}} {single} {{ bad name }}', { 'ticket.id': 'x' })).toBe(
      'x {single} {{ bad name }}',
    );
  });

  it('does not escape by default (plain-text output)', () => {
    expect(interpolate('Hi {{name}} & co', { name: '<b>Ada</b>' })).toBe('Hi <b>Ada</b> & co');
  });

  it('escapes both template text and values in HTML mode', () => {
    const out = interpolate('<p>Hi {{name}} & "friends"</p>', { name: `<script>alert('x')</script>` }, {
      escapeHtml: true,
    });
    expect(out).toBe(
      '&lt;p&gt;Hi &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;friends&quot;&lt;/p&gt;',
    );
    expect(out).not.toContain('<');
  });

  it('does not re-interpolate placeholders that appear inside values', () => {
    expect(interpolate('{{a}}', { a: '{{b}}', b: 'nope' })).toBe('{{b}}');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('مرحبا plain')).toBe('مرحبا plain');
  });
});

describe('templateVariables', () => {
  it('lists distinct placeholder names in order', () => {
    expect(templateVariables('{{b}} {{a}} {{ b }} {{c.d}}')).toEqual(['b', 'a', 'c.d']);
  });
});
