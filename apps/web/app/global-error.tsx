'use client';

import { fontVariables } from './fonts';
import './globals.css';

/**
 * Last-resort boundary for errors in the root layout. It replaces the whole document, so no
 * providers (next-intl, theme) are available: the copy is bilingual and the logo is inlined.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en" dir="ltr" className={fontVariables}>
      <body>
        <title>Loons Help Desk</title>
        <main className="flex min-h-dvh flex-col items-center justify-center gap-7 bg-page px-5 py-10">
          <span className="inline-flex items-center gap-2.5 text-lg font-semibold whitespace-nowrap text-ink">
            <span aria-hidden="true" className="inline-block size-6 shrink-0 rounded-sm bg-ink" />
            Loons Help Desk
          </span>
          <div
            role="alert"
            className="flex w-full max-w-[420px] flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-7 text-center shadow-card"
          >
            <h1 className="text-[22px] font-semibold text-ink">Something went wrong</h1>
            <p className="text-balance text-ink-muted">
              An unexpected error occurred. Try again, or come back in a moment.
            </p>
            <div lang="ar" dir="rtl" className="flex flex-col gap-1.5 border-t border-divider pt-3">
              <p className="text-lg font-semibold text-ink">حدث خطأ ما</p>
              <p className="text-balance text-ink-muted">
                حدث خطأ غير متوقع. حاول مرة أخرى، أو عد بعد قليل.
              </p>
            </div>
            {error.digest ? (
              <p className="font-mono text-xs text-ink-muted">Reference / المرجع: {error.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={() => retry()}
              className="mt-2 inline-flex h-9 cursor-pointer items-center rounded-md bg-brand px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-brand-hover"
            >
              Try again · <span lang="ar">حاول مرة أخرى</span>
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
