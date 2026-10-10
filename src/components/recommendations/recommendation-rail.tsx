"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProductCard } from "@/components/ui/product-card";
import { productPath } from "@/lib/storefront-paths";
import type { ProductSummary } from "@/types";

/**
 * A recommendation rail.
 *
 * One component serves every slot — similar, cross-sell, trending, for-you —
 * because the differences are the request and the heading, not the rendering.
 * §64 asks for named components; those are thin wrappers below that fix the
 * `type` and default heading, so a page reads
 * `<CrossSellRail productId={...} />` rather than a string literal that a typo
 * could silently turn into a different rail.
 *
 * No product data is passed in. The rail fetches its own, which is what keeps
 * the "no hard-coded product arrays" rule structurally true rather than a
 * convention someone has to remember.
 *
 * Two things this component does that a plain list would not:
 *
 *   1. **Impression tracking on actual visibility**, not on mount. Reporting
 *      an impression for a rail the shopper never scrolled to would inflate
 *      every denominator in the dashboard and understate CTR.
 *   2. **Deferred fetch until near the viewport.** A product page can carry
 *      four rails; requesting all four during the initial paint would compete
 *      with the content the shopper actually came for.
 */

interface RailItem {
  productId: string;
  slug: string;
  position: number;
  explanation: string | null;
}

interface RailPayload {
  recommendationId: string;
  type: string;
  algorithmVersion: string;
  heading: string;
  personalized: boolean;
  items: RailItem[];
}

export interface RecommendationRailProps {
  type: string;
  productId?: string | null;
  categoryId?: string | null;
  /** Product ids already in the basket, so the rail does not suggest them. */
  cartProductIds?: string[];
  limit?: number;
  /** Overrides the heading the API returns. */
  heading?: string;
  /** Render as a horizontal scroll rail rather than a grid. */
  horizontal?: boolean;
  className?: string;
}

/** Products the rail could not resolve are dropped rather than shown broken. */
export function RecommendationRail({
  type,
  productId,
  categoryId,
  cartProductIds,
  limit = 8,
  heading,
  horizontal = true,
  className,
}: RecommendationRailProps) {
  const [payload, setPayload] = useState<RailPayload | null>(null);
  const [products, setProducts] = useState<Map<string, ProductSummary>>(new Map());
  const [failed, setFailed] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Guard against double-fetching under StrictMode's double effect. */
  const fetchedRef = useRef(false);
  const impressionsSentRef = useRef(false);

  const queryString = useCallback(() => {
    const params = new URLSearchParams({ type, limit: String(limit) });
    if (productId) params.set("productId", productId);
    if (categoryId) params.set("categoryId", categoryId);
    if (cartProductIds && cartProductIds.length > 0) params.set("cart", cartProductIds.join(","));
    return params.toString();
  }, [type, limit, productId, categoryId, cartProductIds]);

  const load = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const response = await fetch(`/api/recommendations?${queryString()}`, {
        // Personalized, so never let a shared cache serve one shopper's rail
        // to another.
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const body = (await response.json()) as { data?: RailPayload };
      const data = body.data;
      if (!data || data.items.length === 0) return;
      setPayload(data);

      // Hydrate the cards from the public catalog API in one request. Fetching
      // per item would be the N+1 the server side is careful to avoid.
      const slugs = data.items.map((item) => item.slug).join(",");
      const catalogResponse = await fetch(`/api/catalog/products?slugs=${encodeURIComponent(slugs)}`, {
        cache: "no-store",
      });
      if (!catalogResponse.ok) return;
      const catalog = (await catalogResponse.json()) as { data?: Array<{ slug: string } & ProductSummary> };
      const bySlug = new Map<string, ProductSummary>();
      for (const product of catalog.data ?? []) {
        bySlug.set(product.slug, product);
      }
      setProducts(bySlug);
    } catch (error) {
      // A broken rail must not surface an error state to the shopper — it
      // should simply not render. The page is still perfectly usable.
      //
      // Deliberately no server logger here: `@/lib/logger` is `server-only`,
      // and importing it into a client component compiles (tsconfig stubs the
      // module) but throws at runtime in the browser bundle.
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[recommendations] ${type} rail failed to load`, error);
      }
      setFailed(true);
    }
  }, [queryString, type]);

  // Defer the fetch until the rail is near the viewport.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const fallbackLoad = window.setTimeout(() => void load(), 0);
      return () => window.clearTimeout(fallbackLoad);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          void load();
          observer.disconnect();
          break;
        }
      },
      // Start loading slightly before the rail is visible so it is ready by
      // the time the shopper scrolls to it.
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);

  const sendImpressions = useCallback(() => {
    if (!payload || impressionsSentRef.current) return;
    impressionsSentRef.current = true;
    // Fire-and-forget. A failed impression must never block the UI, and there
    // is nothing useful the shopper could be told about it.
    void fetch("/api/recommendations/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "impression",
        recommendationId: payload.recommendationId,
        type: payload.type,
        algorithmVersion: payload.algorithmVersion,
        items: payload.items.map((item) => ({ productId: item.productId, position: item.position })),
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [payload]);

  // Report the impression only once the rail is genuinely on screen.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !payload || payload.items.length === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      sendImpressions();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          sendImpressions();
          observer.disconnect();
          break;
        }
      },
      // Requiring half the rail to be visible, so a sliver at the edge of the
      // viewport does not count as an impression.
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [payload, sendImpressions]);

  const trackClick = useCallback(
    (item: RailItem) => {
      if (!payload) return;
      void fetch("/api/recommendations/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "action",
          eventType: "CLICKED",
          recommendationId: payload.recommendationId,
          type: payload.type,
          productId: item.productId,
          position: item.position,
          algorithmVersion: payload.algorithmVersion,
        }),
        keepalive: true,
      }).catch(() => undefined);
    },
    [payload],
  );

  // Nothing to show: render nothing at all rather than an empty heading. An
  // empty rail is worse than no rail, because it reads as a bug.
  if (failed || !payload || products.size === 0) {
    return <div ref={containerRef} className={className} data-recommendation-rail={type} />;
  }

  const cards = payload.items
    .map((item) => ({ item, product: products.get(item.slug) }))
    .filter((entry): entry is { item: RailItem; product: ProductSummary } => Boolean(entry.product));

  if (cards.length === 0) {
    return <div ref={containerRef} className={className} data-recommendation-rail={type} />;
  }

  const title = heading ?? payload.heading;

  return (
    <section
      ref={containerRef}
      aria-labelledby={`rec-${type}-heading`}
      className={className}
      data-recommendation-rail={type}
      data-recommendation-id={payload.recommendationId}
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={`rec-${type}-heading`} className="font-display text-2xl font-extrabold uppercase sm:text-3xl">
          {title}
        </h2>
        {payload.personalized ? (
          <span className="shrink-0 text-xs text-muted-foreground">Based on your activity</span>
        ) : null}
      </div>

      <ul
        className={
          horizontal
            ? // Horizontal rail: touch-scrollable, with momentum on iOS and a
              // visible scrollbar affordance on desktop.
              "mt-6 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:gap-5 [scrollbar-width:thin]"
            : "mt-6 grid grid-cols-2 gap-x-3 gap-y-8 sm:gap-x-5 lg:grid-cols-4"
        }
      >
        {cards.map(({ item, product }) => (
          <li
            key={item.productId}
            className={horizontal ? "w-[45vw] shrink-0 snap-start sm:w-56" : undefined}
          >
            <ProductCard
              product={product}
              href={`${productPath(product.slug)}?${new URLSearchParams({
                recId: payload.recommendationId,
                recType: payload.type,
                recPosition: String(item.position),
                recAlgorithm: payload.algorithmVersion,
              }).toString()}`}
              onProductClick={() => trackClick(item)}
            />
            {item.explanation ? (
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{item.explanation}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Named wrappers (§64) ─────────────────────────────────────────────── */

type WrapperProps = Omit<RecommendationRailProps, "type">;

export function SimilarProductsRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="similar" heading={props.heading ?? "Similar products"} />;
}

export function RelatedProductsRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="related" heading={props.heading ?? "You may also like"} />;
}

export function FrequentlyBoughtTogetherRail(props: WrapperProps) {
  return (
    <RecommendationRail
      {...props}
      type="frequently-bought"
      heading={props.heading ?? "Frequently bought together"}
    />
  );
}

export function CustomersAlsoBoughtRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="also-bought" heading={props.heading ?? "Customers also bought"} />;
}

export function CustomersAlsoViewedRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="also-viewed" heading={props.heading ?? "Customers also viewed"} />;
}

export function TrendingProductsRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="trending" heading={props.heading ?? "Trending now"} />;
}

export function ForYouRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="for-you" heading={props.heading ?? "Recommended for you"} />;
}

export function RecentlyViewedRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="recently-viewed" heading={props.heading ?? "Recently viewed"} />;
}

export function CrossSellRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="cross-sell" heading={props.heading ?? "Goes well with this"} />;
}

export function UpsellRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="upsell" heading={props.heading ?? "Worth the upgrade"} />;
}

export function CartRecommendationsRail(props: WrapperProps) {
  return <RecommendationRail {...props} type="cart" heading={props.heading ?? "Complete your setup"} />;
}

export function PostPurchaseRecommendationsRail(props: WrapperProps) {
  return (
    <RecommendationRail
      {...props}
      type="post-purchase"
      heading={props.heading ?? "Recommended for your recent purchase"}
    />
  );
}
