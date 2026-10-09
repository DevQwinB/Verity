import Link from "next/link";
import { buttonClasses } from "./ui/button";

/** Previous / next links for a list read one page at a time. `hasNext` comes
 * from asking the backend for one row more than a page holds. */
export function Pager({
  page,
  hasNext,
  hrefFor,
}: {
  page: number;
  hasNext: boolean;
  hrefFor: (page: number) => string;
}) {
  if (page === 1 && !hasNext) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 pt-2">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className={buttonClasses("secondary")}>
          Newer
        </Link>
      ) : (
        <span />
      )}
      <span className="font-mono text-xs text-text-tertiary">Page {page}</span>
      {hasNext ? (
        <Link href={hrefFor(page + 1)} className={buttonClasses("secondary")}>
          Older
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

export const PAGE_SIZE = 25;

/** Reads ?page= as a positive integer, defaulting to 1 for anything else. */
export function parsePage(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
