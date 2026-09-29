import { describe, expect, it } from 'vitest';
import { linkify } from './linkify';

describe('linkify', () => {
  it('links http(s) and www URLs, trimming sentence punctuation', () => {
    expect(linkify('See https://example.com/a?b=1, then www.loons.qa.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ', then ' },
      { kind: 'link', text: 'www.loons.qa', href: 'https://www.loons.qa/' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('keeps balanced parentheses and drops unbalanced ones', () => {
    expect(linkify('(see https://en.wikipedia.org/wiki/Foo_(bar))')[1]).toEqual({
      kind: 'link',
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    });
  });

  it('handles Arabic punctuation after a URL', () => {
    expect(linkify('راجع https://loons.qa/help، شكرًا')[1]).toMatchObject({
      text: 'https://loons.qa/help',
    });
  });

  it('never links other schemes or odd hosts', () => {
    expect(linkify('javascript:alert(1) data:text/html,x mailto:a@b.c')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) data:text/html,x mailto:a@b.c' },
    ]);
    expect(linkify('http://intranet/path')).toEqual([
      { kind: 'text', text: 'http://intranet/path' },
    ]);
    expect(linkify('')).toEqual([]);
  });
});
