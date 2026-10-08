/** Shown while a page's live data is being read. Shaped like the pages it
 * stands in for — a heading, then rows — so nothing jumps when they arrive. */
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-3">
        <div className="h-7 w-56 animate-pulse rounded-md bg-surface-hover" />
        <div className="h-4 w-full max-w-md animate-pulse rounded-md bg-surface-raised" />
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="h-[74px] animate-pulse rounded-lg border border-border-subtle bg-surface-raised"
            style={{ animationDelay: `${row * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
