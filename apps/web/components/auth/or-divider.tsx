/** "or" with a hairline on each side. */
export function OrDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-xs text-ink-subtle">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}
