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
export const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1;

/**
 * Reads ?page= as a positive integer, defaulting to 1 for anything else.
 * Rejects non-base-10 strings, leading zeros, exponents, signs, and page numbers
 * whose backend offset would exceed Number.MAX_SAFE_INTEGER.
 */
export function parsePage(raw: string | string[] | undefined): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || !/^[1-9]\d*$/.test(str)) return 1;
  const n = Number(str);
  return Number.isSafeInteger(n) && (n - 1) * PAGE_SIZE <= Number.MAX_SAFE_INTEGER ? n : 1;
}
