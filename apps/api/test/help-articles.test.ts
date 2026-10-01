import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishedHelpArticleListSchema, type PublishedHelpArticle } from '@loons/shared';
import { acquireTestLock, createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, createWorld, type Persona, type World } from './ticket-world.ts';

// Phase 5 portal Help center (decision F13): GET /help/articles returns published, active articles
// only, in the admin's order, each in the reader's language when both its Arabic title and text
// exist (else English, with `language` saying which). Drafts and archived articles never reach
// anyone. Any signed-in user; pending / unverified accounts get 403.
//
// The help center is one global list shared with the dev database's articles: this file's
// articles have `test-` keys and sort after everything else; only they are asserted on.

describe('GET /help/articles', () => {
  let ctx: TestContext;
  let w: World;
  const tag = rand(4);
  const key = (name: string) => `test-${tag}-${name}`;

  beforeAll(async () => {
    ctx = await createTestContext();
    // The admin help-center suite reorders the same global list: one file at a time.
    ctx.fixtures.onCleanup(await acquireTestLock(ctx.redis, 'help-center'));
    w = await createWorld(ctx);
    ctx.fixtures.onCleanup(() =>
      ctx.prisma.helpArticle.deleteMany({ where: { key: { startsWith: `test-${tag}-` } } }),
    );
    const base = 100_000;
    await ctx.prisma.helpArticle.createMany({
      data: [
        // Published, both languages (Arabic body with an LRM kept as is).
        {
          key: key('both'),
          titleEn: 'Reset a camera',
          titleAr: 'إعادة ضبط الكاميرا',
          bodyEn: 'Step one.\n\nStep two.',
          bodyAr: 'الخطوة الأولى.\n\nاتصل على ‎+974 4000 0000',
          sortOrder: base + 2,
        },
        // Published, English only.
        {
          key: key('english'),
          titleEn: 'Support hours',
          bodyEn: 'We are open 24/7 for P1.',
          sortOrder: base + 1,
        },
        // Published, Arabic title but a blank Arabic text: English for Arabic readers.
        {
          key: key('half'),
          titleEn: 'Footage requests',
          titleAr: 'طلب التسجيلات',
          bodyEn: 'Ask the SOC.',
          bodyAr: '   ',
          sortOrder: base + 3,
        },
        // Never returned: a draft and an archived published article.
        {
          key: key('draft'),
          titleEn: 'Draft',
          bodyEn: 'Not yet.',
          isPublished: false,
          sortOrder: base,
        },
        {
          key: key('archived'),
          titleEn: 'Old',
          titleAr: 'قديم',
          bodyEn: 'Gone.',
          bodyAr: 'انتهى.',
          isActive: false,
          sortOrder: base + 4,
        },
      ],
    });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  async function articles(as: Persona | null, query = ''): Promise<PublishedHelpArticle[]> {
    const res = await apiAs(ctx, as).get(`/help/articles${query}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = publishedHelpArticleListSchema.parse(res.json());
    return body.items.filter((a) => a.key.startsWith(`test-${tag}-`));
  }

  it('English readers: published, active articles in the admin order', async () => {
    const items = await articles(w.clientX, '?locale=en');
    expect(items.map((a) => [a.key, a.language, a.title])).toEqual([
      [key('english'), 'en', 'Support hours'],
      [key('both'), 'en', 'Reset a camera'],
      [key('half'), 'en', 'Footage requests'],
    ]);
    expect(items[1]!.body).toBe('Step one.\n\nStep two.');
    // The default language is English.
    expect((await articles(w.clientX)).map((a) => a.language)).toEqual(['en', 'en', 'en']);
  });

  it('Arabic readers: Arabic only when both the title and the text exist', async () => {
    const items = await articles(w.clientY, '?locale=ar');
    expect(items.map((a) => [a.key, a.language, a.title])).toEqual([
      [key('english'), 'en', 'Support hours'],
      [key('both'), 'ar', 'إعادة ضبط الكاميرا'],
      [key('half'), 'en', 'Footage requests'],
    ]);
    expect(items[1]!.body).toBe('الخطوة الأولى.\n\nاتصل على ‎+974 4000 0000');
    expect(items[2]!.body).toBe('Ask the SOC.');
  });

  it('drafts and archived articles never reach anyone', async () => {
    for (const who of [w.clientX, w.agentA, w.leadA, w.admin]) {
      for (const locale of ['en', 'ar']) {
        const keys = (await articles(who, `?locale=${locale}`)).map((a) => a.key);
        expect(keys).not.toContain(key('draft'));
        expect(keys).not.toContain(key('archived'));
      }
    }
    // Publishing the draft (as the admin does) makes it appear; unpublishing hides it again.
    await ctx.prisma.helpArticle.update({
      where: { key: key('draft') },
      data: { isPublished: true },
    });
    expect((await articles(w.clientX)).map((a) => a.key)).toEqual([
      key('draft'),
      key('english'),
      key('both'),
      key('half'),
    ]);
    await ctx.prisma.helpArticle.update({
      where: { key: key('draft') },
      data: { isPublished: false },
    });
    expect((await articles(w.clientX)).map((a) => a.key)).not.toContain(key('draft'));
  });

  it('any signed-in user; pending or unverified accounts 403; no token 401; bad locale 400', async () => {
    expect((await articles(w.agentA)).length).toBe(3);
    expect((await apiAs(ctx, w.pending).get('/help/articles')).statusCode).toBe(403);
    expect((await apiAs(ctx, w.unverified).get('/help/articles')).statusCode).toBe(403);
    expect((await apiAs(ctx).get('/help/articles')).statusCode).toBe(401);
    expect((await apiAs(ctx, w.clientX).get('/help/articles?locale=fr')).statusCode).toBe(400);
  });
});
