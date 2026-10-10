"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProductCard } from "@/components/ui/product-card";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchCombobox } from "@/components/search/search-combobox";
import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/format";
import type { ProductSummary } from "@/types";

/**
 * The search results surface.
 *
 * ## State lives in the URL
 *
 * Every filter, the sort, the query, and the cursor are URL parameters. That is
 * not a stylistic choice — it is what makes a search shareable, bookmarkable,
 * and correct under browser back/forward. Keeping filters in React state alone
 * would produce a page that looks right and reloads wrong.
 *
 * ## Data comes from the API
 *
 * Results, facets, and the corrected-query hint all come from `/api/search`.
 * Nothing here filters or sorts in the browser: a client-side sort of one page
 * would reorder twenty items and call it a sorted result set.
 */

interface FacetValue {
  value: string;
  label: string;
  count: number;
  id?: string;
  selected: boolean;
}

interface FacetGroup {
  key: string;
  label: string;
  multi: boolean;
  values: FacetValue[];
}

interface PriceBucket {
  label: string;
  minPaise: number | null;
  maxPaise: number | null;
  count: number;
}

interface SearchHit {
  productId: string;
  slug: string;
  name: string;
  brandName: string | null;
  categoryPath: string | null;
  pricePaise: number;
  compareAtPaise: number | null;
  ratingAverage: number | null;
  ratingCount: number;
  inStock: boolean;
  imageUrl: string | null;
  imageAlt: string | null;
  score: number;
  position: number;
  fuzzy: boolean;
}

interface Suggestion {
  type: string;
  text: string;
  href: string | null;
  meta: string | null;
}

interface SearchPayload {
  query: string;
  correctedQuery: string | null;
  results: SearchHit[];
  facets: { groups: FacetGroup[]; price: { minPaise: number; maxPaise: number; buckets: PriceBucket[] } | null; total: number };
  suggestions: Suggestion[];
  nextCursor: string | null;
  metadata: {
    wasCorrected: boolean;
    intent: string;
    tookMs: number;
    total: number;
    totalIsEstimate: boolean;
    sort: string;
    degraded: boolean;
    degradeReason: string | null;
    searchLogId: string | null;
  };
}

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "popularity", label: "Popularity" },
  { value: "newest", label: "Newest" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "rating", label: "Rating" },
  { value: "discount", label: "Discount" },
  { value: "best-selling", label: "Best selling" },
];

export function SearchResults() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const query = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "relevance";
  const cursor = searchParams.get("cursor");

  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const searchLogIdRef = useRef<string | null>(null);

  /** The full query string, rebuilt from the current URL parameters. */
  const queryString = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    return params.toString();
  }, [searchParams]);

  const load = useCallback(async () => {
    if (query.trim().length < 2) {
      setPayload(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/search?${queryString}`, { signal: controller.signal });
      if (abortRef.current !== controller) return;

      if (!response.ok) {
        setError("Search is unavailable right now. Please try again.");
        return;
      }
      const json = (await response.json()) as { data?: SearchPayload };
      if (!json.data) return;
      setPayload(json.data);
      searchLogIdRef.current = json.data.metadata.searchLogId ?? null;
    } catch (fetchError) {
      if ((fetchError as Error).name === "AbortError") return;
      setError("Search is unavailable right now. Please try again.");
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }, [query, queryString]);

  useEffect(() => {
    // Start API work as a scheduled task so this effect only coordinates
    // lifecycle; loading state is updated outside the synchronous effect pass.
    const requestStart = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(requestStart);
      abortRef.current?.abort();
    };
  }, [load]);

  /** Rewrite the URL, which is the single source of truth for search state. */
  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, options: { resetCursor?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      if (options.resetCursor !== false) params.delete("cursor");
      const next = params.toString();
      // `push` rather than `replace`: each filter change should be a step the
      // back button can undo, which is what shoppers expect.
      router.push(next ? `/search?${next}` : "/search");
    },
    [router, searchParams],
  );

  function toggleFacet(axis: string, value: string) {
    updateParams((params) => {
      const key = axis === "brand" ? "brand" : axis === "category" ? "category" : `attr.${axis}`;
      const current = (params.get(key) ?? "").split(",").filter(Boolean);
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
      if (next.length) params.set(key, next.join(","));
      else params.delete(key);
    });
  }

  function setPriceBucket(bucket: PriceBucket) {
    updateParams((params) => {
      if (bucket.minPaise === null) params.delete("minPrice");
      else params.set("minPrice", String(Math.round(bucket.minPaise / 100)));
      if (bucket.maxPaise === null) params.delete("maxPrice");
      else params.set("maxPrice", String(Math.round(bucket.maxPaise / 100)));
    });
  }

  function clearAllFilters() {
    updateParams((params) => {
      for (const key of [...params.keys()]) {
        if (key === "q" || key === "sort") continue;
        params.delete(key);
      }
    });
  }

  /** Record a click so the ranking can be evaluated. Fire-and-forget. */
  function recordClick(hit: SearchHit) {
    const searchLogId = searchLogIdRef.current;
    if (!searchLogId) return;
    void fetch("/api/search/click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        searchLogId,
        productId: hit.productId,
        position: hit.position,
        eventType: "CLICK",
      }),
    }).catch(() => undefined);
  }

  const activeFilterCount = useMemo(() => {
    let count = 0;
    for (const [key, value] of new URLSearchParams(searchParams.toString()).entries()) {
      if (key === "q" || key === "sort" || key === "cursor") continue;
      if (!value) continue;
      count += key.startsWith("attr.") || key === "brand" || key === "category"
        ? value.split(",").filter(Boolean).length
        : 1;
    }
    return count;
  }, [searchParams]);

  const products: ProductSummary[] = (payload?.results ?? []).map((hit) => ({
    id: hit.productId,
    slug: hit.slug,
    title: hit.name,
    category: hit.categoryPath ?? "",
    pricePaise: hit.pricePaise,
    compareAtPaise: hit.compareAtPaise ?? undefined,
    image: hit.imageUrl ?? "",
    imageAlt: hit.imageAlt ?? hit.name,
    rating: hit.ratingAverage ? { value: hit.ratingAverage, count: hit.ratingCount } : undefined,
    availability: hit.inStock ? "in_stock" : "sold_out",
    badge:
      hit.compareAtPaise && hit.compareAtPaise > hit.pricePaise ? "SALE" : undefined,
  }));

  return (
    <div className="space-y-6">
      <SearchCombobox initialQuery={query} />

      {payload?.metadata.wasCorrected && payload.correctedQuery ? (
        <p className="rounded-2xl border-[1.5px] border-clay bg-cream px-4 py-3 text-sm" role="status">
          Showing results for <span className="font-semibold">“{payload.correctedQuery}”</span>
          {" "}instead of “{payload.query}”.{" "}
          <button
            type="button"
            className="underline hover:no-underline"
            onClick={() =>
              updateParams((params) => {
                params.set("q", payload.query);
              })
            }
          >
            Search for “{payload.query}” anyway
          </button>
        </p>
      ) : null}

      {payload?.metadata.degraded ? (
        <p className="rounded-2xl border-[1.5px] border-flame/40 bg-flame/5 px-4 py-3 text-sm" role="alert">
          Search is running in a limited mode: {payload.metadata.degradeReason ?? "the index is unavailable"}.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-smoke" aria-live="polite">
          {loading
            ? "Searching…"
            : payload
              ? `${payload.metadata.totalIsEstimate ? "About " : ""}${payload.metadata.total.toLocaleString("en-IN")} result${payload.metadata.total === 1 ? "" : "s"} in ${payload.metadata.tookMs} ms`
              : ""}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            className="flex min-h-11 items-center gap-2 rounded-pill border-[1.5px] border-clay px-4 text-sm hover:border-ink lg:hidden"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            Filters
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-ink px-2 text-[10px] text-paper">{activeFilterCount}</span>
            ) : null}
          </button>

          <label className="flex min-h-11 items-center gap-2 rounded-pill border-[1.5px] border-clay px-4 text-sm">
            <span className="sr-only sm:not-sr-only sm:text-xs sm:uppercase sm:tracking-[0.12em] sm:text-smoke">
              Sort
            </span>
            <select
              value={sort}
              onChange={(event) =>
                updateParams((params) => {
                  if (event.target.value === "relevance") params.delete("sort");
                  else params.set("sort", event.target.value);
                })
              }
              className="bg-transparent text-sm outline-none"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {activeFilterCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {payload?.facets.groups.flatMap((group) =>
            group.values
              .filter((value) => value.selected)
              .map((value) => (
                <button
                  key={`${group.key}:${value.value}`}
                  type="button"
                  onClick={() => toggleFacet(group.key, value.value)}
                  className="flex min-h-9 items-center gap-1 rounded-pill border-[1.5px] border-clay px-3 text-xs hover:border-ink"
                >
                  {group.label}: {value.label}
                  <X className="size-3" aria-hidden />
                  <span className="sr-only">Remove filter</span>
                </button>
              )),
          )}
          <button
            type="button"
            onClick={clearAllFilters}
            className="min-h-9 rounded-pill px-3 text-xs uppercase tracking-[0.12em] text-smoke underline hover:text-ink"
          >
            Clear all
          </button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside
          className={cn(
            "space-y-6 lg:block",
            filtersOpen ? "block" : "hidden",
          )}
          aria-label="Filters"
        >
          {payload?.facets.groups.map((group) => (
            <fieldset key={group.key}>
              <legend className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                {group.label}
              </legend>
              <ul className="space-y-1">
                {group.values.slice(0, 10).map((value) => (
                  <li key={value.value}>
                    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={value.selected}
                        onChange={() => toggleFacet(group.key, value.value)}
                        className="size-4 accent-ink"
                      />
                      <span className="min-w-0 flex-1 truncate">{value.label}</span>
                      <span className="text-xs text-smoke">{value.count}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ))}

          {payload?.facets.price && payload.facets.price.buckets.length > 0 ? (
            <fieldset>
              <legend className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                Price
              </legend>
              <ul className="space-y-1">
                {payload.facets.price.buckets.map((bucket) => (
                  <li key={bucket.label}>
                    <button
                      type="button"
                      onClick={() => setPriceBucket(bucket)}
                      className="flex min-h-9 w-full items-center justify-between gap-2 text-sm hover:underline"
                    >
                      <span>{bucket.label}</span>
                      <span className="text-xs text-smoke">{bucket.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
        </aside>

        <div>
          {loading && !payload ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : error ? (
            <EmptyState title="Search unavailable" description={error} />
          ) : products.length === 0 ? (
            <div className="space-y-6 py-8">
              <EmptyState
                title="No products matched"
                description={
                  activeFilterCount > 0
                    ? "Try removing a filter or two — the combination you picked has nothing in it."
                    : "Nothing in the catalogue matches that search."
                }
              />
              {payload?.suggestions && payload.suggestions.length > 0 ? (
                <section aria-label="Suggestions">
                  <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                    Try one of these
                  </h2>
                  <ul className="flex flex-wrap gap-2">
                    {payload.suggestions.map((suggestion, index) => (
                      <li key={`${suggestion.text}-${index}`}>
                        {suggestion.href ? (
                          <Link
                            href={suggestion.href}
                            className="flex min-h-10 items-center rounded-pill border-[1.5px] border-clay px-3 text-sm hover:border-ink"
                          >
                            {suggestion.text}
                            {suggestion.meta ? (
                              <span className="ml-2 text-xs text-smoke">{suggestion.meta}</span>
                            ) : null}
                          </Link>
                        ) : (
                          <span className="flex min-h-10 items-center rounded-pill border-[1.5px] border-clay px-3 text-sm">
                            {suggestion.text}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {products.map((product, index) => (
                  <li key={product.id} onClick={() => recordClick(payload!.results[index]!)}>
                    <ProductCard product={product} priority={index < 4} />
                  </li>
                ))}
              </ul>

              {payload?.nextCursor ? (
                <div className="mt-8 flex justify-center">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() =>
                      updateParams(
                        (params) => params.set("cursor", payload.nextCursor!),
                        { resetCursor: false },
                      )
                    }
                    className="min-h-12 rounded-pill border-[1.5px] border-ink px-6 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {payload && payload.results.length > 0 ? (
        <p className="text-center text-xs text-smoke">
          Showing {payload.results.length} of {payload.metadata.total.toLocaleString("en-IN")}
          {" · "}sorted by {SORT_OPTIONS.find((option) => option.value === sort)?.label ?? sort}
          {" · "}prices from {formatPrice(payload.facets.price?.minPaise ?? 0)}
        </p>
      ) : null}
    </div>
  );
}
