'use client';

import { BookOpen, Minus, Plus } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { transitions } from '@/lib/motion';

/** A help-center FAQ article, already localised (Arabic falls back to English when empty). */
export interface HelpArticle {
  id: string;
  title: string;
  body: string;
}

export interface HelpCenterProps {
  articles: readonly HelpArticle[];
}

/** Help center (design 612–634): search, accordion list of articles, "Still need help?" card. */
export function HelpCenter({ articles }: HelpCenterProps) {
  const t = useTranslations('portal.help');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const trimmed = query.trim();
  const visible = useMemo(() => {
    const q = trimmed.toLocaleLowerCase();
    if (!q) return articles;
    return articles.filter((a) => `${a.title}\n${a.body}`.toLocaleLowerCase().includes(q));
  }, [articles, trimmed]);

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

      <Card className="gap-0 py-0">
        {articles.length === 0 ? (
          <EmptyState icon={<BookOpen />} title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : visible.length === 0 ? (
          <p className="p-5 text-ink-muted" role="status">
            {t('noMatch', { query: trimmed })}
          </p>
        ) : (
          <ul aria-label={t('articlesLabel')}>
            {visible.map((article) => (
              <ArticleRow
                key={article.id}
                article={article}
                open={openId === article.id}
                onToggle={() => setOpenId((current) => (current === article.id ? null : article.id))}
              />
            ))}
          </ul>
        )}
      </Card>

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
  article: HelpArticle;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const reduceMotion = useReducedMotion();

  return (
    <li className="border-b border-divider last:border-b-0">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex w-full cursor-pointer items-center justify-between gap-4 bg-surface px-5 py-4 text-start text-[15px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
        >
          <span>{article.title}</span>
          {open ? (
            <Minus aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          ) : (
            <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          )}
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={panelId}
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : transitions.base}
            className="overflow-hidden"
          >
            <p className="max-w-[680px] px-5 pb-[18px] leading-relaxed whitespace-pre-line text-ink-secondary">
              {article.body}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
