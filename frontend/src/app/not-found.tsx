import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "../components/ui/button";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-16">
      <p className="font-mono text-xs uppercase tracking-wider text-text-tertiary">404</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Nothing at this address</h1>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">
        There is no submission, re-executor or page here. If you followed a link to a submission,
        it may belong to an earlier contract deployment that this dashboard no longer tracks.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/submissions" className={buttonClasses("primary")}>
          Browse submissions
        </Link>
        <Link href="/" className={buttonClasses("secondary")}>
          Home
        </Link>
      </div>
    </div>
  );
}
