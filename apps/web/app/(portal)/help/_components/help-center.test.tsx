// @vitest-environment jsdom
import type { PublishedHelpArticle, PublishedHelpArticleList } from '@loons/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import type { RealtimeClient } from '@/lib/realtime/client';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import {
  createPortalHarness,
  deferred,
  plain,
  type PortalHarness,
} from '../../tickets/_components/portal-test-utils';
import { HelpCenter, articleLangProps, matchesHelpSearch } from './help-center';

// Portal Help center (docs/PHASE5_CONTRACT.md F13; design 612–634): published articles fetched in
// the UI language, the first one open, search as you type, lang/dir per article, empty / no-match
// / error states, and live refresh on `config:updated` scope `help-center` and after a reconnect.

const api = vi.hoisted(() => ({ fetchHelpArticles: vi.fn() }));
vi.mock('@/lib/help/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

const holder = vi.hoisted(() => ({ client: null as RealtimeClient | null }));
vi.mock('@/lib/realtime/client', async (importOriginal) => ({
  ...(await importOriginal()),
  getRealtimeClient: () => holder.client,
}));

const article = (
  n: number,
  overrides: Partial<PublishedHelpArticle> = {},
): PublishedHelpArticle => ({
  id: fixtureId(2000 + n),
  key: `article-${n}`,
  language: 'en',
  title: `Article ${n}`,
  body: `Body ${n}`,
  updatedAt: '2026-09-23T12:00:00.000Z',
  ...overrides,
});

const SECURITY = article(1, {
  key: 'security-incident',
  title: 'How do I report a critical security incident?',
  body: 'Raise a ticket with type “Security Incident”.\n\nThen call the 24/7 SOC line on +974 4000 0000.',
});
const HOURS = article(2, {
  key: 'support-hours',
  title: 'What are your support hours and SLAs?',
  body: 'P1: 15 min first reply, 24/7.',
});
const CCTV = article(3, {
  key: 'cctv-footage',
  title: 'How do I request CCTV footage?',
  body: 'Choose CCTV & Video Surveillance → Footage retrieval.',
});

const list = (
  items: PublishedHelpArticle[],
  locale: 'en' | 'ar' = 'en',
): PublishedHelpArticleList => ({ locale, items });

let harness: PortalHarness;

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
beforeEach(() => {
  api.fetchHelpArticles.mockReset();
  harness = createPortalHarness();
  holder.client = harness.client;
});
afterEach(cleanup);

function renderHelp(h = harness) {
  return render(<HelpCenter />, { wrapper: h.wrapper });
}

const toggles = (listName = 'Help articles') =>
  within(screen.getByRole('list', { name: listName })).getAllByRole('button');
const titles = (listName?: string) => toggles(listName).map((b) => plain(b.textContent));
const expanded = () => toggles().map((b) => b.getAttribute('aria-expanded'));
const AR_LIST = 'مقالات المساعدة';

describe('Help center', () => {
  it('shows skeleton rows, then fetches the articles in the UI language with the first one open', async () => {
    const pending = deferred<PublishedHelpArticleList>();
    api.fetchHelpArticles.mockReturnValueOnce(pending.promise);
    renderHelp();

    expect(screen.getByRole('heading', { level: 1, name: 'Help center' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Loading articles…');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(api.fetchHelpArticles).toHaveBeenCalledWith('en', expect.anything());

    await act(async () => pending.resolve(list([SECURITY, HOURS, CCTV])));

    await waitFor(() => expect(titles()).toEqual([SECURITY.title, HOURS.title, CCTV.title]));
    // Design: the first article starts open (openArticle: 0), the others closed.
    expect(expanded()).toEqual(['true', 'false', 'false']);
    const panel = document.getElementById(toggles()[0]!.getAttribute('aria-controls')!)!;
    // Plain text with its line breaks kept (no HTML, no markdown).
    // (a phone number is wrapped in left-to-right isolates so it reads the same in Arabic text)
    expect(panel.textContent?.replace(/[⁦⁩]/g, '')).toBe(SECURITY.body);
    expect(panel.textContent).toContain('⁦+974 4000 0000⁩');
    expect(panel.querySelector('p')?.className).toContain('whitespace-pre-line');
    // Article titles are headings under the page title; the card clips overflow, so the toggles
    // draw an inset focus ring (the global outline's sides would be cut off).
    expect(screen.getByRole('heading', { level: 2, name: SECURITY.title })).toBeTruthy();
    for (const cls of ['outline-none', 'focus-visible:ring-2', 'focus-visible:ring-inset']) {
      expect(toggles()[0]!.classList.contains(cls)).toBe(true);
    }
    expect(screen.getByRole('heading', { level: 2, name: 'Still need help?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New ticket' })).toBeTruthy();
  });

  it('is a single-open accordion: opening one closes the other, clicking the open one closes it', async () => {
    api.fetchHelpArticles.mockResolvedValue(list([SECURITY, HOURS, CCTV]));
    renderHelp();
    await waitFor(() => expect(titles()).toHaveLength(3));

    fireEvent.click(toggles()[1]!);
    expect(expanded()).toEqual(['false', 'true', 'false']);
    expect(screen.getByText(HOURS.body)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Raise a ticket/)).toBeNull());

    fireEvent.click(toggles()[1]!);
    expect(expanded()).toEqual(['false', 'false', 'false']);
    // Once the reader has chosen, a refresh never re-opens the first article by itself.
    await act(async () => {
      api.fetchHelpArticles.mockResolvedValue(list([SECURITY, HOURS, CCTV]));
      harness.socket().accept();
      harness.socket().receive('config:updated', { scope: 'help-center', version: 2 });
    });
    await waitFor(() => expect(api.fetchHelpArticles).toHaveBeenCalledTimes(2));
    expect(expanded()).toEqual(['false', 'false', 'false']);
  });

  it('searches as you type over the title and the text, and says when nothing matches', async () => {
    api.fetchHelpArticles.mockResolvedValue(list([SECURITY, HOURS, CCTV]));
    renderHelp();
    await waitFor(() => expect(titles()).toHaveLength(3));
    const search = screen.getByRole('searchbox', { name: 'Search help articles' });
    expect(search.getAttribute('placeholder')).toBe('Search articles…');

    // A word of a title (any case).
    fireEvent.change(search, { target: { value: 'cctv' } });
    expect(titles()).toEqual([CCTV.title]);
    // A word only in a body.
    fireEvent.change(search, { target: { value: '  24/7 soc  ' } });
    expect(titles()).toEqual([SECURITY.title]);

    fireEvent.change(search, { target: { value: 'firewall' } });
    expect(screen.queryByRole('list', { name: 'Help articles' })).toBeNull();
    const status = screen.getByRole('status');
    expect(plain(status.textContent)).toBe('No articles match “firewall”.');
    // The query is isolated, so an English query keeps its place in an Arabic sentence.
    expect(status.textContent).toContain('⁨firewall⁩');

    fireEvent.change(search, { target: { value: '' } });
    expect(titles()).toHaveLength(3);
  });

  it('searches the localised text (Arabic articles in the Arabic UI)', () => {
    const ar = article(4, {
      language: 'ar',
      title: 'كيف أطلب تسجيلات كاميرات المراقبة؟',
      body: 'اختر فئة المراقبة بالفيديو.',
    });
    expect(matchesHelpSearch(ar, 'كاميرات')).toBe(true);
    expect(matchesHelpSearch(ar, 'بالفيديو')).toBe(true);
    expect(matchesHelpSearch(ar, 'CCTV')).toBe(false);
    expect(matchesHelpSearch(ar, '   ')).toBe(true);
  });

  it('sets lang and dir per article: an English fallback in the Arabic UI reads left to right', async () => {
    const arHarness = createPortalHarness({ locale: 'ar' });
    holder.client = arHarness.client;
    const arabic = article(5, {
      language: 'ar',
      title: 'كيف أبلغ عن حادث أمني حرج؟',
      body: 'أنشئ تذكرة من نوع «حادث أمني».',
    });
    const fallback = article(6, { language: 'en', title: 'How do I request CCTV footage?' });
    api.fetchHelpArticles.mockResolvedValue(list([arabic, fallback], 'ar'));
    renderHelp(arHarness);

    await waitFor(() => expect(titles(AR_LIST)).toHaveLength(2));
    expect(api.fetchHelpArticles).toHaveBeenCalledWith('ar', expect.anything());
    expect(screen.getByRole('heading', { level: 1, name: 'مركز المساعدة' })).toBeTruthy();

    const [arToggle, enToggle] = toggles(AR_LIST);
    const arTitle = within(arToggle!).getByText(arabic.title);
    expect([arTitle.getAttribute('lang'), arTitle.getAttribute('dir')]).toEqual(['ar', 'rtl']);
    const enTitle = within(enToggle!).getByText(fallback.title);
    expect([enTitle.getAttribute('lang'), enTitle.getAttribute('dir')]).toEqual(['en', 'ltr']);
    // The open body carries its article's language too.
    const arPanel = document.getElementById(arToggle!.getAttribute('aria-controls')!)!;
    expect([arPanel.getAttribute('lang'), arPanel.getAttribute('dir')]).toEqual(['ar', 'rtl']);
    fireEvent.click(enToggle!);
    const enPanel = document.getElementById(enToggle!.getAttribute('aria-controls')!)!;
    expect([enPanel.getAttribute('lang'), enPanel.getAttribute('dir')]).toEqual(['en', 'ltr']);
    expect(enPanel.textContent).toBe(fallback.body);

    expect(articleLangProps({ language: 'en' })).toEqual({ lang: 'en', dir: 'ltr' });
    expect(articleLangProps({ language: 'ar' })).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  it('shows article text as plain text, never as HTML', async () => {
    const html = article(7, { body: '<b>bold</b> <img src=x onerror="alert(1)">' });
    api.fetchHelpArticles.mockResolvedValue(list([html]));
    renderHelp();
    await waitFor(() => expect(titles()).toHaveLength(1));
    const panel = document.getElementById(toggles()[0]!.getAttribute('aria-controls')!)!;
    expect(panel.textContent).toBe(html.body);
    expect(panel.querySelector('b, img')).toBeNull();
  });

  it('shows the empty state when no article is published', async () => {
    api.fetchHelpArticles.mockResolvedValue(list([]));
    renderHelp();
    expect(await screen.findByRole('heading', { name: 'No articles yet' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Help articles' })).toBeNull();
    // The way out stays: open a ticket.
    expect(screen.getByRole('button', { name: 'New ticket' })).toBeTruthy();
  });

  it('offers a retry when the articles fail to load', async () => {
    // A 5xx is retried once (after ~1 s) before the error shows.
    api.fetchHelpArticles.mockRejectedValue(new ApiRequestError(500, 'INTERNAL', 'boom'));
    renderHelp();
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert.textContent).toContain('The articles couldn’t be loaded.');

    api.fetchHelpArticles.mockResolvedValue(list([SECURITY]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(titles()).toEqual([SECURITY.title]));
  });

  it('refreshes live on config:updated scope help-center: a published article appears, an unpublished one goes', async () => {
    api.fetchHelpArticles.mockResolvedValue(list([SECURITY, HOURS]));
    renderHelp();
    await waitFor(() => expect(titles()).toHaveLength(2));
    act(() => harness.socket().accept());
    expect(api.fetchHelpArticles).toHaveBeenCalledTimes(1);

    // Another scope: nothing to do with the help center.
    act(() => harness.socket().receive('config:updated', { scope: 'macros', version: 2 }));
    await act(async () => {});
    expect(api.fetchHelpArticles).toHaveBeenCalledTimes(1);

    // Admin publishes CCTV and unpublishes HOURS.
    api.fetchHelpArticles.mockResolvedValue(list([SECURITY, CCTV]));
    act(() => harness.socket().receive('config:updated', { scope: 'help-center', version: 3 }));
    await waitFor(() => expect(titles()).toEqual([SECURITY.title, CCTV.title]));
    expect(api.fetchHelpArticles).toHaveBeenCalledTimes(2);
    expect(api.fetchHelpArticles).toHaveBeenLastCalledWith('en', expect.anything());
  });

  it('refetches after a reconnect (a change announced while offline was missed)', async () => {
    api.fetchHelpArticles.mockResolvedValue(list([SECURITY]));
    renderHelp();
    await waitFor(() => expect(titles()).toHaveLength(1));
    act(() => harness.socket().accept());

    api.fetchHelpArticles.mockResolvedValue(list([SECURITY, CCTV]));
    act(() => harness.socket().transportClose());
    act(() => harness.socket().accept());
    await waitFor(() => expect(titles()).toEqual([SECURITY.title, CCTV.title]));
  });
});
