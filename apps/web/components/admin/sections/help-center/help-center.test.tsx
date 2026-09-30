// @vitest-environment jsdom
import type { HelpArticleAdminDto } from '@loons/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { clone, renderComms, stubBrowserApis } from '../email-templates/comms-test-utils';
import HelpCenterSection from '.';

// Help center (E15): the article table (order, drafts, archived behind the switch, keyboard
// reorder with the expected order, E3), the article sheet (key from the English title, E4;
// English | العربية switch; published switch; live preview), create / edit with expectedUpdatedAt
// (E19) / archive / restore, and the 409s — against an in-memory /admin/help-center.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const api = vi.hoisted(() => ({
  calls: [] as Call[],
  articles: [] as HelpArticleAdminDto[],
  failNext: null as ApiRequestError | null,
  tick: 0,
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      return { items: clone(api.articles) };
    }),
    request: vi.fn(
      async (path: string, init: { method: string; json?: Record<string, unknown> }) => {
        api.calls.push({ method: init.method, path, body: init.json });
        if (api.failNext) {
          const error = api.failNext;
          api.failNext = null;
          throw error;
        }
        api.tick += 1;
        const updatedAt = new Date(Date.UTC(2026, 8, 29, 12, api.tick)).toISOString();
        const [, , , target, action] = path.split('/');
        if (init.method === 'POST' && target === 'reorder') {
          const ids = init.json!.ids as string[];
          api.articles = [
            ...ids.map((x) => api.articles.find((a) => a.id === x)!),
            ...api.articles.filter((a) => !ids.includes(a.id)),
          ];
          return undefined;
        }
        if (init.method === 'POST' && target === undefined) {
          const body = init.json as Record<string, unknown>;
          const item: HelpArticleAdminDto = {
            id: id(900 + api.tick),
            key: (body.key as string | undefined) ?? 'generated-key',
            titleEn: body.titleEn as string,
            titleAr: body.titleAr as string,
            bodyEn: body.bodyEn as string,
            bodyAr: body.bodyAr as string,
            isPublished: body.isPublished as boolean,
            isActive: true,
            sortOrder: 99,
            createdAt: updatedAt,
            updatedAt,
          };
          api.articles.push(item);
          return { item: clone(item) };
        }
        const index = api.articles.findIndex((a) => a.id === target);
        const current = api.articles[index]!;
        const { expectedUpdatedAt: _expected, ...changes } = init.json ?? {};
        const next =
          action === 'archive'
            ? { ...current, isActive: false, updatedAt }
            : action === 'restore'
              ? { ...current, isActive: true, updatedAt }
              : { ...current, ...changes, updatedAt };
        api.articles[index] = next;
        return { item: clone(next) };
      },
    ),
  },
}));

function article(n: number, overrides: Partial<HelpArticleAdminDto> = {}): HelpArticleAdminDto {
  return {
    id: id(n),
    key: `article-${n}`,
    titleEn: `Question ${n}?`,
    titleAr: `سؤال ${n}؟`,
    bodyEn: `Answer ${n}.\nSecond line.`,
    bodyAr: `الجواب ${n}.`,
    sortOrder: n,
    isPublished: true,
    isActive: true,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: `2026-09-2${n}T10:00:00.000Z`,
    ...overrides,
  };
}

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.tick = 0;
  api.articles = [
    article(1),
    article(2, { isPublished: false, titleAr: '' }),
    article(3),
    article(4, { isActive: false, titleEn: 'Old question?' }),
  ];
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const writes = () => api.calls.filter((c) => c.method !== 'GET');

function renderSection(locale: 'en' | 'ar' = 'en') {
  return renderComms(<HelpCenterSection role="SUPER_ADMIN" userId="u1" />, { locale });
}

async function table() {
  const found = await screen.findByRole('table', { name: /Help-center articles|مقالات/ });
  await within(found).findAllByRole('button', { name: /Question 1|سؤال 1/ });
  return found;
}

async function openRow(name: string) {
  const row = await within(await table()).findByRole('button', { name });
  act(() => row.focus());
  fireEvent.click(row);
  return screen.findByRole('dialog');
}

function rowNames(container: HTMLElement) {
  return within(container)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-row-open]')?.textContent);
}

describe('HelpCenterSection', () => {
  it('lists the active articles in order, drafts marked, archived ones behind the switch', async () => {
    renderSection();
    const list = await table();
    expect(rowNames(list)).toEqual(['Question 1?', 'Question 2?', 'Question 3?']);
    const draft = within(list)
      .getByRole('button', { name: 'Question 2?' })
      .closest('[role="row"]') as HTMLElement;
    expect(within(draft).getByText('Draft')).toBeTruthy();
    expect(within(list).getAllByText('Published')).toHaveLength(2);
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const old = await within(list).findByRole('button', { name: 'Old question?' });
    expect(within(old.closest('[role="row"]') as HTMLElement).getByText('Archived')).toBeTruthy();
    expect(screen.getByText('Only Super Admins can open this section.')).toBeTruthy();
  });

  it('creates a draft with a key from the English title and a live preview', async () => {
    renderSection();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const sheet = await screen.findByRole('dialog', { name: 'New article' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Title/ }), {
      target: { value: 'How do I reset a camera?' },
    });
    await waitFor(() =>
      expect((within(sheet).getByRole('textbox', { name: 'Key' }) as HTMLInputElement).value).toBe(
        'how-do-i-reset-a-camera',
      ),
    );
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Article text/ }), {
      target: { value: 'Hold the reset button.\nWait 10 seconds.' },
    });
    const preview = within(sheet).getByTestId('article-preview');
    expect(preview.textContent).toContain('How do I reset a camera?');
    expect(preview.textContent).toContain('Wait 10 seconds.');
    expect(within(sheet).getByText('Draft — clients can’t see this article yet.')).toBeTruthy();

    // Arabic tab: nothing written yet, so Arabic readers get the English article.
    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    expect(
      within(sheet).getByText(
        'No Arabic text yet: clients who use Arabic see the English article.',
      ),
    ).toBeTruthy();
    const titleAr = within(sheet).getByRole('textbox', { name: /Title/ });
    expect(titleAr.getAttribute('dir')).toBe('rtl');
    fireEvent.change(titleAr, { target: { value: 'كيف أعيد ضبط الكاميرا؟' } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Article text/ }), {
      target: { value: 'اضغط زر إعادة الضبط.' },
    });
    expect(within(sheet).getByTestId('article-preview').getAttribute('dir')).toBe('rtl');

    fireEvent.click(within(sheet).getByRole('switch', { name: 'Published' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST',
      path: '/admin/help-center',
      body: {
        key: 'how-do-i-reset-a-camera',
        titleEn: 'How do I reset a camera?',
        titleAr: 'كيف أعيد ضبط الكاميرا؟',
        bodyEn: 'Hold the reset button.\nWait 10 seconds.',
        bodyAr: 'اضغط زر إعادة الضبط.',
        isPublished: true,
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('How do I reset a camera? created');
  });

  it('checks the form first and shows the language that has the error', async () => {
    renderSection();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const sheet = await screen.findByRole('dialog', { name: 'New article' });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'العربية' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(within(sheet).getByRole('textbox', { name: /Title/ }).getAttribute('lang')).toBe('en'),
    );
    expect(within(sheet).getAllByText('This field is required.').length).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });

  it('shows a taken key on the key field (409 duplicate), archived articles named', async () => {
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'dup', undefined, {
      reason: 'duplicate',
      fields: ['key'],
      existingId: id(4),
      existingIsActive: false,
    });
    renderSection();
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const sheet = await screen.findByRole('dialog', { name: 'New article' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Title/ }), {
      target: { value: 'Brand new' },
    });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Article text/ }), {
      target: { value: 'Text' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(
      await within(sheet).findByText(
        'This key is already used by an archived article. Restore that one, or choose another key.',
      ),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('saves only the changed fields with expectedUpdatedAt; publishing says so', async () => {
    renderSection();
    const sheet = await openRow('Question 2?');
    expect((within(sheet).getByRole('textbox', { name: 'Key' }) as HTMLInputElement).readOnly).toBe(
      true,
    );
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Published' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'PATCH',
      path: `/admin/help-center/${id(2)}`,
      body: { isPublished: true, expectedUpdatedAt: '2026-09-22T10:00:00.000Z' },
    });
    expect(toast.success).toHaveBeenCalledWith('“Question 2?” published');

    const again = await openRow('Question 3?');
    fireEvent.change(within(again).getByRole('textbox', { name: /Article text/ }), {
      target: { value: 'New answer.' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]?.body).toEqual({
      bodyEn: 'New answer.',
      expectedUpdatedAt: '2026-09-23T10:00:00.000Z',
    });
    expect(toast.success).toHaveBeenLastCalledWith('Changes saved');
  });

  it('a stale save offers a reload that starts from the latest version', async () => {
    renderSection();
    const sheet = await openRow('Question 1?');
    api.articles[0] = article(1, {
      titleEn: 'Their title?',
      updatedAt: '2026-09-29T09:00:00.000Z',
    });
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'stale', undefined, { reason: 'stale' });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Title/ }), {
      target: { value: 'My title?' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Someone else changed this — reload')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        (within(sheet).getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value,
      ).toBe('Their title?'),
    );
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Title/ }), {
      target: { value: 'Mine?' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(writes().at(-1)?.body).toEqual({
        titleEn: 'Mine?',
        expectedUpdatedAt: '2026-09-29T09:00:00.000Z',
      }),
    );
  });

  it('archives after confirming, and restores an archived article', async () => {
    renderSection();
    const sheet = await openRow('Question 3?');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Archive Question 3??' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: `/admin/help-center/${id(3)}/archive`,
      body: { expectedUpdatedAt: '2026-09-23T10:00:00.000Z' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Question 3? archived');

    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const restoreSheet = await openRow('Old question?');
    expect(within(restoreSheet).getByText(/This item is archived/)).toBeTruthy();
    fireEvent.click(within(restoreSheet).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]?.path).toBe(`/admin/help-center/${id(4)}/restore`);
    expect(toast.success).toHaveBeenLastCalledWith('Old question? restored');
  });

  it('reorders by keyboard: one request with the expected order', async () => {
    renderSection();
    const list = await table();
    fireEvent.click(within(list).getByRole('button', { name: 'Move Question 1? down' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST',
      path: '/admin/help-center/reorder',
      body: { ids: [id(2), id(1), id(3)], expectedIds: [id(1), id(2), id(3)] },
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('New order saved'));
    expect(rowNames(list)).toEqual(['Question 2?', 'Question 1?', 'Question 3?']);
  });

  it('when the order changed meanwhile, says so and shows the current order', async () => {
    renderSection();
    const list = await table();
    // Someone else moved Question 3 to the top.
    api.articles = [api.articles[2]!, api.articles[0]!, api.articles[1]!, api.articles[3]!];
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'order', undefined, {
      reason: 'order_changed',
    });
    fireEvent.click(within(list).getByRole('button', { name: 'Move Question 1? down' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Someone else changed the order meanwhile. The list was reloaded — try again.',
      ),
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(rowNames(list)).toEqual(['Question 3?', 'Question 1?', 'Question 2?']),
    );
  });

  it('works in Arabic: Arabic titles (English when missing), right-to-left', async () => {
    renderSection('ar');
    const list = await table();
    expect(screen.getByRole('table', { name: 'مقالات مركز المساعدة' })).toBe(list);
    expect(rowNames(list)).toEqual(['سؤال 1؟', 'Question 2?', 'سؤال 3؟']);
    expect(screen.getByRole('button', { name: 'إنشاء جديد' })).toBeTruthy();
    expect(within(list).getAllByText('منشورة')).toHaveLength(2);
    const sheet = await openRow('سؤال 1؟');
    expect(within(sheet).getByRole('button', { name: 'حفظ' })).toBeTruthy();
  });
});
