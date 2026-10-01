'use client';

import type { Locale, PublishedHelpArticle } from '@loons/shared';
import { BookOpen, Minus, Plus } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, SkeletonRows } from '@/components/common/skeletons';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { isolate, isolatePhoneNumbers } from '@/lib/format';
import { useHelpArticles } from '@/lib/help/queries';
import { transitions } from '@/lib/motion';

/** The language an article is shown in (`language` from the API) as HTML `lang` / `dir`. */
export function articleLangProps(article: Pick<PublishedHelpArticle, 'language'>): {
  lang: Locale;
  dir: 'ltr' | 'rtl';
} {
  return { lang: article.language, dir: article.language === 'ar' ? 'rtl' : 'ltr' };
}

/** Case-insensitive match of the search over what the reader sees: the title and the text. */
export function matchesHelpSearch(
  article: Pick<PublishedHelpArticle, 'title' | 'body'>,
  query: string,
): boolean {
  const q = query.trim().toLocaleLowerCase();
  return !q || `${article.title}\n${article.body}`.toLocaleLowerCase().includes(q);
}

/**
 * Help center (design 612–634; docs/PHASE5_CONTRACT.md F13): the published articles in the UI
 * language (GET /help/articles, `['help', locale]`), searched as you type, in a single-open
 * accordion whose first article is open until the reader toggles one (design `openArticle: 0`),
 * and the "Still need help?" card. Each article carries its own `lang` / `dir` — an English
 * fallback inside the Arabic UI reads left to right. Bodies are plain text (line breaks kept, no
 * HTML). Live: `config:updated` with scope `help-center` and a reconnect refetch the articles
 * (lib/realtime/config-scopes.ts), so an article published in admin appears without a reload.
 */
export function HelpCenter() {
  const t = useTranslations('portal.help');
  const locale = useLocale() as Locale;
  const articlesQuery = useHelpArticles(locale);
  const [query, setQuery] = useState('');
  // undefined: nobody has toggled an article yet, so the first one is open.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);

  const articles = articlesQuery.data?.items;
  const trimmed = query.trim();
  const visible = useMemo(
    () => (articles ?? []).filter((article) => matchesHelpSearch(article, trimmed)),
    [articles, trimmed],
  );
  const openArticleId = openId === undefined ? (articles?.[0]?.id ?? null) : openId;

  let body: React.ReactNode;
  if (!articles) {
    body = articlesQuery.isError ? (
      <div role="alert">
        <EmptyState
          title={t('loadFailed')}
          action={
            <Button
              type="button"
              variant="outline"
              aria-disabled={articlesQuery.isFetching || undefined}
              onClick={() => {
                if (!articlesQuery.isFetching) void articlesQuery.refetch();
              }}
            >
              {t('retry')}
            </Button>
          }
        />
      </div>
    ) : (
      <LoadingRegion label={t('loading')}>
        <SkeletonRows rows={4} rowClassName="py-5" />
      </LoadingRegion>
    );
  } else if (articles.length === 0) {
    body = (
      <EmptyState icon={<BookOpen />} title={t('emptyTitle')} description={t('emptyDescription')} />
    );
  } else if (visible.length === 0) {
    body = (
      <p className="p-5 text-ink-muted" role="status">
        {t('noMatch', { query: isolate(trimmed) })}
      </p>
    );
  } else {
    body = (
      <ul aria-label={t('articlesLabel')}>
        {visible.map((article) => (
          <ArticleRow
            key={article.id}
            article={article}
            open={openArticleId === article.id}
            onToggle={() => setOpenId(openArticleId === article.id ? null : article.id)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader title={t('title')} />

      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchLabel')}
        // Design 615: 11px 14px padding, 10px radius, 14px text → 42px.
        className="h-auto rounded-lg px-3.5 py-[11px]"
      />

      <Card className="gap-0 py-0">{body}</Card>

      <Card className="flex-row flex-wrap items-center justify-between gap-4 px-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px] font-semibold text-ink">{t('stillNeedTitle')}</h2>
          <p className="text-ink-muted">{t('stillNeedDescription')}</p>
        </div>
        <NewTicketButton />
      </Card>
    </div>
  );
}

function ArticleRow({
  article,
  open,
  onToggle,
}: {
  article: PublishedHelpArticle;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const reduceMotion = useReducedMotion();
  // The article's own language (an English fallback in the Arabic UI is lang="en" dir="ltr"); the
  // row keeps the page's direction, so every +/− sits on the same side.
  const language = articleLangProps(article);

  return (
    <li data-article={article.key} className="border-b border-divider last:border-b-0">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          // The card clips overflow: an inset ring instead of the global outline (whose sides
          // would be cut off), like the portal's ticket rows.
          className="flex w-full cursor-pointer items-center justify-between gap-4 bg-surface px-5 py-4 text-start text-[15px] font-medium text-ink transition-colors duration-150 outline-none hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2"
        >
          <span {...language} className="min-w-0 [overflow-wrap:anywhere]">
            {article.title}
          </span>
          {open ? (
            <Minus aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          ) : (
            <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          )}
        </button>
      </h2>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            key="panel"
            {...language}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            // `MotionConfig reducedMotion="user"` keeps height animations: turn them off here.
            transition={reduceMotion ? { duration: 0 } : transitions.base}
            className="overflow-hidden"
          >
            <p className="max-w-[680px] px-5 pb-[18px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-line text-ink-secondary">
              {isolatePhoneNumbers(article.body)}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
