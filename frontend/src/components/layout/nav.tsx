"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../../lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { useWallet } from "../wallet-provider";
import { truncateMiddle } from "../../lib/format";
import { Button } from "../ui/button";

const LINKS = [
  { href: "/submissions", label: "Submissions" },
  { href: "/reexecutors", label: "Re-executors" },
  { href: "/challenges", label: "Challenges" },
  { href: "/reports", label: "Reports" },
  { href: "/taxonomy", label: "Taxonomy" },
];

export function Nav() {
  const pathname = usePathname();
  const { account, connecting, login, logout } = useWallet();

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-border-subtle bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-8">
          <Link href="/submissions" className="text-sm font-semibold tracking-tight text-text-primary">
            Verity
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => {
              const active = pathname?.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-surface-hover text-text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          {account ? (
            <div className="flex items-center gap-2">
              <span className="hidden font-mono text-xs text-text-secondary sm:inline">
                {truncateMiddle(account, 4, 4)}
              </span>
              <Button variant="secondary" onClick={logout}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={login} disabled={connecting}>
              {connecting ? "Connecting..." : "Connect wallet"}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
