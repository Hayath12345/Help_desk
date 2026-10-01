import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logo } from '@/components/common/logo';
import { Input } from '@/components/ui/input';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import { ConsoleSearchBox } from './console-search';
import { LanguageToggle } from './language-toggle';
import { PresenceToggle } from './presence-toggle';
import { UserMenu } from './user-menu';

// Server actions and the API token cache can't load outside Next; the components only pass them on.
vi.mock('@/app/actions/locale', () => ({ setLocaleAction: vi.fn() }));
vi.mock('@/app/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({ clearApiToken: vi.fn() }));

// Radix menus portal their content only after mounting; render the menu parts inline instead.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Div = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Div,
    DropdownMenuLabel: Div,
    DropdownMenuItem: Div,
  };
});

// Lets a test render the presence switch in either state (localStorage is browser-only).
const presence = vi.hoisted(() => ({ value: 'online' as 'online' | 'away' }));
vi.mock('@/hooks/use-local-storage-state', () => ({
  useLocalStorageState: () => [presence.value, vi.fn()],
}));

const messages = {
  en: { common: enCommon, console: enConsole },
  ar: { common: arCommon, console: arConsole },
} as const;

function render(ui: React.ReactElement, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

// ── Minimal markup queries (tests run in the node environment, without a DOM) ──

interface Element {
  tag: string;
  attrs: Record<string, string>;
  /** Text content with tags stripped and React's entity escaping undone. */
  text: string;
}

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Every element in `html`, in document order. */
function elements(html: string): Element[] {
  const out: Element[] = [];
  for (const open of html.matchAll(/<([a-z][a-z0-9-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const [whole, tag = '', rawAttrs = ''] = open;
    const attrs: Record<string, string> = {};
    for (const [, name = '', value = ''] of rawAttrs.matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) {
      attrs[name] = decode(value);
    }
    // Inner markup up to the matching close tag (same-name nesting counted).
    const start = (open.index ?? 0) + whole.length;
    let depth = 1;
    let end = start;
    const scan = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'g');
    scan.lastIndex = start;
    for (let m = scan.exec(html); m; m = scan.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    out.push({ tag, attrs, text: decode(html.slice(start, end).replace(/<[^>]+>/g, '')) });
  }
  return out;
}

function find(html: string, predicate: (el: Element) => boolean): Element {
  const found = elements(html).find(predicate);
  if (!found) throw new Error(`no matching element in ${html}`);
  return found;
}

const classes = (el: Element) => (el.attrs.class ?? '').split(/\s+/);

describe('LanguageToggle (A11Y-5)', () => {
  it.each([
    ['en', 'العربية', 'ar', 'Switch language'],
    ['ar', 'English', 'en', 'تغيير اللغة'],
  ] as const)(
    'in %s its accessible name is the visible language name',
    (locale, label, lang, hint) => {
      const html = render(<LanguageToggle />, locale);
      const button = find(html, (el) => el.tag === 'button');
      // Label in name: no aria-label replacing the visible text; the hint is the description.
      expect(button.attrs['aria-label']).toBeUndefined();
      expect(button.text).toBe(label);
      expect(button.attrs.title).toBe(hint);
      expect(find(html, (el) => el.tag === 'span').attrs.lang).toBe(lang);
    },
  );

  it('never uses the disabled attribute (it would drop keyboard focus while switching)', () => {
    const button = find(render(<LanguageToggle />), (el) => el.tag === 'button');
    expect(button.attrs).not.toHaveProperty('disabled');
    expect(classes(button)).toEqual(
      expect.arrayContaining(['aria-disabled:cursor-progress', 'aria-disabled:opacity-60']),
    );
    expect(classes(button).filter((name) => name.startsWith('disabled:'))).toEqual([]);
  });
});

describe('PresenceToggle (A11Y-4, A11Y-2)', () => {
  beforeEach(() => {
    presence.value = 'online';
  });

  it.each([
    ['en', 'Online', 'Away'],
    ['ar', 'متصل', 'غير متاح'],
  ] as const)('keeps the switch named %j in both states', (locale, onlineLabel, awayLabel) => {
    const isSwitch = (el: Element) => el.attrs.role === 'switch';
    const on = find(render(<PresenceToggle />, locale), isSwitch);
    expect(on.attrs['aria-label']).toBe(onlineLabel);
    expect(on.attrs['aria-checked']).toBe('true');
    expect(on.text).toBe(onlineLabel);

    presence.value = 'away';
    const off = find(render(<PresenceToggle />, locale), isSwitch);
    expect(off.attrs['aria-label']).toBe(onlineLabel);
    expect(off.attrs['aria-checked']).toBe('false');
    expect(off.text).toBe(awayLabel);
  });

  it('colours both pills with AA text tokens', () => {
    expect(classes(find(render(<PresenceToggle />), (el) => el.tag === 'button'))).toContain(
      'text-success',
    );
    presence.value = 'away';
    const away = classes(find(render(<PresenceToggle />), (el) => el.tag === 'button'));
    expect(away).toContain('text-ink-muted-on-sunken');
    expect(away).not.toContain('text-ink-muted');
  });

  it('is sized like the design (5px padding) but never shorter than 28px when only the dot shows', () => {
    expect(classes(find(render(<PresenceToggle />), (el) => el.tag === 'button'))).toEqual(
      expect.arrayContaining(['py-[5px]', 'min-h-7']),
    );
  });
});

describe('UserMenu (RTL-2)', () => {
  it('isolates the email as LTR so it truncates at its end, aligned to the menu start in RTL', () => {
    const email = 'mohammed.abdulrahman@hamadmedical.gov.qa';
    const html = render(<UserMenu name="Dr. Aisha Al-Kuwari" email={email} initials="AA" />, 'ar');
    const span = find(html, (el) => el.tag === 'span' && el.text === email);
    expect(span.attrs.dir).toBe('ltr');
    expect(classes(span)).toEqual(expect.arrayContaining(['truncate', 'max-w-full', 'self-start']));
  });
});

describe('Toaster (I18N-1)', () => {
  it.each([
    ['en', 'Notifications'],
    ['ar', 'الإشعارات'],
  ] as const)('names the toast region in %s', (locale, label) => {
    const section = find(render(<Toaster />, locale), (el) => el.tag === 'section');
    expect(section.attrs['aria-label']).toBe(`${label} alt+T`);
  });
});

describe('TabsContent (A11Y-3)', () => {
  it('keeps a visible focus outline on the focusable panel', () => {
    const panel = find(
      render(
        <Tabs defaultValue="a">
          <TabsContent value="a">Panel</TabsContent>
        </Tabs>,
      ),
      (el) => el.attrs.role === 'tabpanel',
    );
    expect(panel.attrs.tabindex).toBe('0');
    expect(classes(panel)).not.toContain('outline-none');
    expect(classes(panel)).toEqual(
      expect.arrayContaining(['focus-visible:outline-2', 'focus-visible:outline-brand']),
    );
  });
});

describe('placeholder and search contrast (A11Y-1)', () => {
  it('gives text-field placeholders the 4.5:1 ink-muted colour', () => {
    for (const html of [
      render(<Input placeholder="Search articles…" />),
      render(<Textarea placeholder="Describe…" />),
    ]) {
      const field = find(html, (el) => el.tag === 'input' || el.tag === 'textarea');
      expect(classes(field)).toContain('placeholder:text-ink-muted');
      expect(field.attrs.class).not.toContain('ink-subtle');
    }
  });

  it('shows the logo suffix (the portal’s “Support”) at ink-muted, never ink-subtle', () => {
    const html = render(<Logo suffix="Support" compact />);
    const suffix = find(html, (el) => el.tag === 'span' && classes(el).includes('font-normal'));
    expect(classes(suffix)).toContain('text-ink-muted');
    expect(html).not.toContain('ink-subtle');
  });

  it('keeps the console search placeholder and glyph at ink-muted', () => {
    const html = render(<ConsoleSearchBox />);
    expect(html).not.toContain('ink-subtle');
    expect(classes(find(html, (el) => el.tag === 'input'))).toContain('placeholder:text-ink-muted');
  });
});
