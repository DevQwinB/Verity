"use client";

import { useSyncExternalStore } from "react";
import { Sun, Moon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "./ui/button";

type Theme = "dark" | "light";

/** The theme lives on <html data-theme>, set before first paint by the
 * inline script in the root layout. This reads it from there, so the toggle
 * can never disagree with what is actually on screen. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
const currentTheme = (): Theme =>
  document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribe, currentTheme, () => "dark");

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("verity-theme", next);
    } catch {
      // ignore - per-viewer convenience only
    }
  }

  return (
    <Button
      variant="ghost"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="px-2"
    >
      {theme === "dark" ? <Sun size={18} weight="regular" /> : <Moon size={18} weight="regular" />}
    </Button>
  );
}
