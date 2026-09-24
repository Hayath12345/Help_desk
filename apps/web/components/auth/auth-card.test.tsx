import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthCardHeader } from './auth-card';

describe('AuthCardHeader', () => {
  it('keeps the design line-height on the title (no leading-* override, DES-1)', () => {
    const html = renderToStaticMarkup(<AuthCardHeader title="Sign in" titleId="t" />);
    const h1 = /<h1[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(h1).toContain('text-[22px]');
    expect(h1).not.toMatch(/(^|\s)leading-/);
  });
});
