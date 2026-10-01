// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/help — portal Help center data layer (docs/PHASE5_CONTRACT.md F13, F16)
//
//   useHelpArticles(locale)      GET /help/articles?locale= → { locale, items: PublishedHelpArticle[] }
//                                 (published, active, admin order; `language` per article sets lang/dir).
//   fetchHelpArticles(locale)    The fetcher.
//   helpKeys                     ['help'] prefix; ['help', locale] per UI language. Invalidated by
//                                 `config:updated` scope `help-center` and after a reconnect.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export * from './api';
export * from './keys';
export * from './queries';
