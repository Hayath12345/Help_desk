import type { Route } from 'next';
import Link from 'next/link';

/** Dashed card under the sign-in card that switches between the client and staff logins. */
export function SwitchCard({
  kicker,
  text,
  href,
  action,
}: {
  kicker: string;
  text: string;
  href: Route;
  action: string;
}) {
  return (
    <aside className="flex w-full max-w-[400px] items-center justify-between gap-4 rounded-2xl border border-dashed border-line-dashed px-5 py-[18px]">
      <div className="flex flex-col gap-0.5">
        {/* Letter-spacing breaks Arabic letter joining, so the kicker drops it in RTL. */}
        <p className="kicker rtl:tracking-normal">{kicker}</p>
        <p className="font-medium text-ink">{text}</p>
      </div>
      <Link
        href={href}
        className="inline-flex shrink-0 items-center rounded-md border border-line-input bg-surface px-3.5 py-2 font-medium whitespace-nowrap text-ink hover:bg-surface-sunken hover:text-ink"
      >
        {action}
      </Link>
    </aside>
  );
}
