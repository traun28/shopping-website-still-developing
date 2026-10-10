"use client";

import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Accessible search combobox with live autocomplete.
 *
 * ## Why the ARIA roles are spelled out
 *
 * A search box with suggestions is a combobox, not a text field. Screen-reader
 * users need to know a listbox is open, which option is active, and how to move
 * through it. `role="combobox"` with `aria-expanded`, `aria-controls`, and
 * `aria-activedescendant` on the input, plus `role="option"` on each item, is the
 * pattern that makes this work — a bare `<ul>` under an `<input>` does not.
 *
 * ## Why the network call is debounced and abortable
 *
 * Every keystroke would otherwise fire a request, and responses arriving out of
 * order would flicker the list. The abort controller cancels the in-flight
 * request when a newer keystroke arrives, so the list always reflects the latest
 * input rather than the fastest response.
 */

export interface ComboboxSuggestion {
  type: "PRODUCT" | "BRAND" | "CATEGORY" | "SEARCH_QUERY" | "TRENDING_QUERY" | "HISTORY";
  text: string;
  href: string | null;
  imageUrl: string | null;
  meta: string | null;
  weight: number;
}

interface SuggestionResponse {
  suggestions: ComboboxSuggestion[];
  partial: boolean;
}

const TYPE_LABEL: Record<ComboboxSuggestion["type"], string> = {
  PRODUCT: "Product",
  BRAND: "Brand",
  CATEGORY: "Category",
  SEARCH_QUERY: "Search",
  TRENDING_QUERY: "Trending",
  HISTORY: "Recent",
};

const DEBOUNCE_MS = 140;

export interface SearchComboboxProps {
  initialQuery?: string;
  /** Called on submit. The parent owns navigation so server and client agree. */
  onSubmit?: (query: string) => void;
  placeholder?: string;
  /** Full-screen presentation for the mobile search sheet. */
  variant?: "inline" | "full";
  autoFocus?: boolean;
  id?: string;
  className?: string;
}

export function SearchCombobox({
  initialQuery = "",
  onSubmit,
  placeholder = "Search products, brands, categories…",
  variant = "inline",
  autoFocus = false,
  id,
  className,
}: SearchComboboxProps) {
  const router = useRouter();
  const generatedId = useId();
  const inputId = id ?? `search-combobox-${generatedId}`;
  const listboxId = `${inputId}-listbox`;

  const [query, setQuery] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<ComboboxSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Fetch suggestions, cancelling any request this one supersedes. */
  const fetchSuggestions = useCallback(async (value: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (value.trim().length < 2) {
      setSuggestions([]);
      setActiveIndex(-1);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(
        `/api/search/suggestions?q=${encodeURIComponent(value.trim())}&limit=8`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        setSuggestions([]);
        return;
      }
      const payload = (await response.json()) as { data?: SuggestionResponse };
      // Guard against a stale response landing after a newer one: only apply it
      // if this controller is still the current one.
      if (abortRef.current !== controller) return;
      setSuggestions(payload.data?.suggestions ?? []);
      setActiveIndex(-1);
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setSuggestions([]);
      setActiveIndex(-1);
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(query);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchSuggestions]);

  // Close on outside click. Keyboard Escape is handled on the input.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function submit(value: string) {
    const clean = value.trim();
    if (clean.length < 2) return;
    setOpen(false);
    if (onSubmit) onSubmit(clean);
    else router.push(`/search?q=${encodeURIComponent(clean)}`);
  }

  function choose(suggestion: ComboboxSuggestion) {
    setOpen(false);
    if (suggestion.type === "SEARCH_QUERY" || suggestion.type === "TRENDING_QUERY" || suggestion.type === "HISTORY") {
      setQuery(suggestion.text);
      submit(suggestion.text);
      return;
    }
    if (suggestion.href) router.push(suggestion.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Escape closes the list first; a second press clears the field. That is
      // the standard combobox contract and avoids destroying typed text by
      // accident.
      if (open && suggestions.length > 0) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      } else if (query) {
        event.preventDefault();
        setQuery("");
        setSuggestions([]);
        setActiveIndex(-1);
      }
      return;
    }

    if (!open || suggestions.length === 0) {
      if (event.key === "ArrowDown" && suggestions.length > 0) {
        event.preventDefault();
        setOpen(true);
        setActiveIndex(0);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(suggestions.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const active = activeIndex >= 0 ? suggestions[activeIndex] : null;
        if (active) choose(active);
        else submit(query);
        break;
      }
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  }

  const full = variant === "full";

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit(query);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Search products
        </label>
        <div
          className={cn(
            "flex items-center gap-3 rounded-pill border-[1.5px] border-clay bg-white/70 px-4 transition-colors",
            "focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-flame",
            full ? "min-h-14" : "min-h-12",
          )}
        >
          <Search className="size-4 shrink-0 text-smoke" aria-hidden />
          <input
            ref={inputRef}
            id={inputId}
            type="search"
            role="combobox"
            autoComplete="off"
            enterKeyHint="search"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
            }
            placeholder={placeholder}
            value={query}
            autoFocus={autoFocus}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(-1);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={cn(
              "w-full bg-transparent outline-none placeholder:text-smoke/70",
              full ? "text-base" : "text-sm",
            )}
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setSuggestions([]);
                setActiveIndex(-1);
                inputRef.current?.focus();
              }}
              className="min-h-8 min-w-8 shrink-0 rounded-full text-smoke hover:text-ink"
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>
      </form>

      {open && suggestions.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Search suggestions"
          className={cn(
            "absolute left-0 right-0 z-50 mt-2 max-h-[70vh] overflow-y-auto rounded-2xl border-[1.5px] border-clay bg-paper shadow-lg",
          )}
        >
          {suggestions.map((suggestion, index) => {
            const active = index === activeIndex;
            return (
              <li
                key={`${suggestion.type}-${suggestion.text}-${index}`}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={active}
              >
                <button
                  type="button"
                  // onMouseDown rather than onClick: a click on the list would
                  // blur the input and fire the outside-click close first, so the
                  // selection would never register.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(suggestion);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                    active ? "bg-cream" : "hover:bg-cream/60",
                  )}
                >
                  <span className="min-w-16 shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-smoke">
                    {TYPE_LABEL[suggestion.type]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{suggestion.text}</span>
                  {suggestion.meta ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-smoke">
                      {suggestion.meta}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {loading ? <span className="sr-only" role="status">Loading suggestions</span> : null}
    </div>
  );
}
