"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { SearchCombobox } from "@/components/search/search-combobox";
import { cn } from "@/lib/utils";

/**
 * Mobile search.
 *
 * ## Why a full-screen sheet rather than a dropdown
 *
 * On a phone, an inline suggestion list fights the on-screen keyboard for the
 * bottom half of the screen and the tap targets end up too small to hit reliably.
 * A full-screen sheet gives the keyboard room, keeps targets at least 44px, and
 * puts recent and trending searches where a thumb can reach them without
 * scrolling.
 *
 * ## Body scroll is locked while open
 *
 * Without it the page behind the sheet scrolls with the finger, which is both
 * disorienting and a common source of the sheet "drifting". The lock is removed
 * on unmount as well as on close, so navigating away cannot leave the page
 * unscrollable.
 */

interface MobileSearchProps {
  /** Recent searches persisted in the browser for anonymous visitors. */
  recent?: string[];
  trending?: string[];
}

export function MobileSearch(props: MobileSearchProps) {
  const pathname = usePathname();
  // A changed key resets the sheet when navigation happens without an effect
  // that mirrors route state into local component state.
  return <MobileSearchPanel key={pathname ?? ""} {...props} />;
}

function MobileSearchPanel({ recent = [], trending = [] }: MobileSearchProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape closes, for hardware-keyboard and switch-access users.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search products"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-ink lg:hidden"
      >
        <Search className="size-5" aria-hidden />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal
          aria-label="Search"
          className="fixed inset-0 z-[100] flex flex-col bg-paper lg:hidden"
        >
          <div className="flex items-center gap-2 border-b border-clay px-4 py-3">
            <div className="min-w-0 flex-1">
              <SearchCombobox variant="full" autoFocus placeholder="Search the catalogue" />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close search"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full hover:bg-cream"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5">
            {recent.length > 0 ? (
              <section aria-label="Recent searches" className="mb-6">
                <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                  Recent
                </h2>
                <ul className="flex flex-wrap gap-2">
                  {recent.slice(0, 8).map((item) => (
                    <li key={item}>
                      <Link
                        href={`/search?q=${encodeURIComponent(item)}`}
                        onClick={() => setOpen(false)}
                        className="flex min-h-11 items-center rounded-pill border-[1.5px] border-clay px-4 text-sm hover:border-ink"
                      >
                        {item}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {trending.length > 0 ? (
              <section aria-label="Trending searches">
                <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                  Trending
                </h2>
                <ul className="space-y-1">
                  {trending.slice(0, 8).map((item) => (
                    <li key={item}>
                      <Link
                        href={`/search?q=${encodeURIComponent(item)}`}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex min-h-12 items-center gap-3 rounded-2xl px-3 text-sm hover:bg-cream",
                        )}
                      >
                        <Search className="size-4 shrink-0 text-smoke" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{item}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {recent.length === 0 && trending.length === 0 ? (
              <p className="py-10 text-center text-sm text-smoke">
                Type at least two characters to see suggestions.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
