"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, ShoppingBag, Trash2 } from "lucide-react";
import { CartRecommendationsRail } from "@/components/recommendations/recommendation-rail";
import { Button } from "@/components/ui/button";
import { EmptyCart } from "@/components/ui/empty-state";
import { QuantitySelector } from "@/components/ui/quantity-selector";
import { useCart } from "@/components/cart/cart-provider";
import { cartMutation, CartClientError } from "@/lib/cart/client";
import { formatPrice } from "@/lib/format";
import { notify } from "@/lib/toast";
import { productPath } from "@/lib/storefront-paths";
import type { CartLineDTO } from "@/types/cart";

function LinePrice({ item }: { item: CartLineDTO }) {
  if (item.unitPricePaise === null || item.lineSubtotalPaise === null) {
    return <span className="font-mono text-sm text-smoke">Price unavailable</span>;
  }
  return (
    <span className="font-mono text-sm font-semibold">
      {formatPrice(item.lineSubtotalPaise, { currency: item.currency })}
    </span>
  );
}

export function CartPageClient() {
  const { cart, loading, refresh } = useCart();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = cart;

  async function mutate(itemId: string, path: string, method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
    if (!current || pendingId) return;
    setPendingId(itemId);
    setError(null);
    try {
      await cartMutation(path, { method, body: { ...body, cartVersion: current.version } });
      await refresh();
    } catch (cause) {
      setError(cause instanceof CartClientError ? cause.message : "Your cart could not be updated. Please try again.");
      await refresh();
    } finally {
      setPendingId(null);
    }
  }

  if (loading && !current) {
    return (
      <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-8" aria-busy="true" aria-label="Loading cart">
        <div className="h-8 w-48 animate-pulse rounded bg-sand" />
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="h-48 animate-pulse rounded-card bg-sand" />
          <div className="h-64 animate-pulse rounded-card bg-sand" />
        </div>
      </section>
    );
  }

  if (!current || current.items.length === 0) {
    return (
      <section className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-8">
        <div className="mb-8 flex items-center gap-3">
          <ShoppingBag className="size-6 text-flame" aria-hidden />
          <h1 className="font-display text-3xl font-extrabold uppercase">Your cart</h1>
        </div>
        <EmptyCart />
        <SavedForLaterList />
      </section>
    );
  }

  const productIds = [...new Set(current.items.map((item) => item.productId))];

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-8 lg:py-14">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-smoke">Your saved selection</p>
          <h1 className="mt-2 font-display text-3xl font-extrabold uppercase sm:text-4xl">Your cart</h1>
          <p className="mt-2 text-sm text-smoke">{current.itemCount} {current.itemCount === 1 ? "item" : "items"} · Prices and availability are checked live.</p>
        </div>
        <Link href="/shop" className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] underline decoration-flame decoration-2 underline-offset-4 hover:text-flame">
          Continue shopping <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </header>

      {error ? <p role="alert" className="mb-5 rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p> : null}
      {current.warnings.length ? (
        <div className="mb-6 flex gap-3 rounded-card border border-warning/40 bg-warning/10 p-4" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="text-sm font-semibold">Review these cart updates</p>
            <ul className="mt-1 space-y-1 text-sm text-smoke">
              {current.warnings.map((warning, index) => <li key={`${warning.itemId ?? warning.code}-${index}`}>{warning.message}</li>)}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <ul className="space-y-4">
            {current.items.map((item) => {
              const isPending = pendingId === item.id;
              const priceChanged = item.warnings.some((entry) => entry.code === "PRICE_CHANGED");
              const stockReduced = item.warnings.find((entry) => entry.code === "STOCK_REDUCED");
              const cannotEditQuantity = item.warnings.some((entry) => ["PRODUCT_UNAVAILABLE", "VARIANT_UNAVAILABLE", "SELLER_UNAVAILABLE", "CURRENCY_MISMATCH", "OUT_OF_STOCK"].includes(entry.code));
              return (
                <li key={item.id} className="rounded-card border-[1.5px] border-clay bg-paper p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row">
                    <div className="relative aspect-square w-full shrink-0 overflow-hidden rounded-xl border border-clay bg-sand sm:size-32">
                      {item.imageUrl ? (
                        <Image src={item.imageUrl} alt={item.productName} fill sizes="(max-width:640px) 100vw, 128px" className="object-cover" />
                      ) : <ShoppingBag className="absolute inset-0 m-auto size-7 text-smoke" aria-hidden />}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          {item.slug ? <Link href={productPath(item.slug)} className="font-display text-lg font-bold leading-tight hover:underline">{item.productName}</Link> : <p className="font-display text-lg font-bold">{item.productName}</p>}
                          <p className="mt-1 text-sm text-smoke">{item.variantName}{item.size ? ` · ${item.size}` : ""}{item.color ? ` · ${item.color}` : ""}</p>
                          {item.sellerName ? <p className="mt-1 text-xs text-smoke">Sold by {item.sellerName}</p> : null}
                        </div>
                        <LinePrice item={item} />
                      </div>

                      {item.warnings.length ? (
                        <div className="mt-3 space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
                          {item.warnings.map((warning, index) => <p className="text-xs leading-relaxed" key={`${warning.code}-${index}`}>{warning.message}</p>)}
                          {priceChanged ? (
                            <Button size="sm" variant="outline" loading={isPending} disabled={Boolean(pendingId)} onClick={() => void mutate(item.id, `/api/cart/items/${item.id}/accept-price`, "POST", {})}>
                              Accept current price
                            </Button>
                          ) : null}
                          {stockReduced && item.availableQuantity > 0 ? (
                            <Button size="sm" variant="outline" loading={isPending} disabled={Boolean(pendingId)} onClick={() => void mutate(item.id, `/api/cart/items/${item.id}`, "PATCH", { quantity: item.availableQuantity })}>
                              Update to {item.availableQuantity} available
                            </Button>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="mt-auto flex flex-wrap items-center justify-between gap-4 pt-5">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-smoke">Qty</span>
                          <QuantitySelector
                            value={item.quantity}
                            max={Math.max(1, Math.min(10, item.availableQuantity || 10))}
                            disabled={Boolean(pendingId) || cannotEditQuantity}
                            onValueChange={(quantity) => void mutate(item.id, `/api/cart/items/${item.id}`, "PATCH", { quantity })}
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Button variant="ghost" size="sm" disabled={Boolean(pendingId)} loading={isPending} onClick={() => void mutate(item.id, `/api/cart/items/${item.id}/save-for-later`, "POST", {})}>
                            Save for later
                          </Button>
                          <Button variant="outline-danger" size="sm" disabled={Boolean(pendingId)} loading={isPending} onClick={() => void mutate(item.id, `/api/cart/items/${item.id}`, "DELETE", {})}>
                            <Trash2 className="size-3.5" aria-hidden /> Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <SavedForLaterList />
        </div>

        <aside className="rounded-card border-[1.5px] border-ink bg-cream p-5 sm:p-6 lg:sticky lg:top-24">
          <h2 className="font-display text-xl font-bold uppercase">Cart summary</h2>
          <div className="mt-5 space-y-3 border-b border-clay pb-5 text-sm">
            <div className="flex justify-between gap-4"><span>Current subtotal</span><span className="font-mono font-semibold">{formatPrice(current.totals.subtotalPaise, { currency: current.currency })}</span></div>
            {current.totals.productDiscountPaise > 0 ? <div className="flex justify-between gap-4 text-success"><span>Product savings</span><span className="font-mono">−{formatPrice(current.totals.productDiscountPaise, { currency: current.currency })}</span></div> : null}
            {current.totals.estimatedTaxPaise > 0 ? <div className="flex justify-between gap-4"><span>Catalog tax estimate</span><span className="font-mono">{formatPrice(current.totals.estimatedTaxPaise, { currency: current.currency })}</span></div> : null}
            <div className="flex justify-between gap-4 text-smoke"><span>Delivery</span><span>Not configured</span></div>
          </div>
          <div className="mt-4 flex items-baseline justify-between gap-3">
            <span className="font-semibold">Estimated total</span>
            <span className="font-mono text-lg font-bold">{formatPrice(current.totals.totalPaise, { currency: current.currency })}</span>
          </div>
          <p className="mt-1 text-right text-[10px] leading-relaxed text-smoke">Before delivery. Final tax and delivery are confirmed later.</p>
          <Button asChild size="lg" className="mt-6 w-full" aria-describedby="checkout-notice">
            <Link href="/checkout"><ArrowRight className="size-4" aria-hidden /> Continue to checkout</Link>
          </Button>
          <p id="checkout-notice" className="mt-3 text-center text-xs leading-relaxed text-smoke">Checkout preparation only. Delivery and destination tax are not configured; payment, stock reservation and order creation are not part of this step.</p>
          <Link href="/account/wishlist" className="mt-4 block text-center text-xs font-semibold underline decoration-flame decoration-2 underline-offset-4">Open your wishlist</Link>
        </aside>
      </div>

      <CartRecommendationsRail cartProductIds={productIds} className="mt-14" />
    </section>
  );
}

function SavedForLaterList() {
  const { cart, refresh } = useCart();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [items, setItems] = useState<import("@/types/cart").SavedItemDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/cart/saved-items", { credentials: "same-origin", cache: "no-store" });
      const body = (await response.json()) as { ok?: boolean; data?: { items: import("@/types/cart").SavedItemDTO[] } };
      if (response.ok && body.ok && body.data) setItems(body.data.items);
    } catch {
      setMessage("Saved items could not be loaded.");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Cart id changes after guest merge/login; reload the distinct saved collection.
  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [cart?.id, load]);

  async function action(id: string, restore: boolean) {
    if (!cart || pendingId) return;
    setPendingId(id);
    setMessage(null);
    try {
      await cartMutation(restore ? `/api/cart/saved-items/${id}/restore` : `/api/cart/saved-items/${id}`, {
        method: restore ? "POST" : "DELETE",
        body: { cartVersion: cart.version },
      });
      await Promise.all([load(), refresh()]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Saved item could not be updated.");
      await refresh();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="mt-8" aria-labelledby="saved-for-later-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="saved-for-later-title" className="font-display text-xl font-bold uppercase">Saved for later</h2>
        {loaded && items.length ? <span className="font-mono text-xs text-smoke">{items.length} {items.length === 1 ? "item" : "items"}</span> : null}
      </div>
      {message ? <p role="alert" className="mt-3 text-sm text-danger">{message}</p> : null}
      {loaded && items.length === 0 ? <p className="mt-3 rounded-card border border-dashed border-clay p-4 text-sm text-smoke">Items you save from your cart will appear here. This is separate from your wishlist.</p> : null}
      {!loaded ? <p className="mt-3 text-sm text-smoke">Loading saved items…</p> : null}
      {items.length ? (
        <ul className="mt-4 divide-y divide-clay rounded-card border border-clay bg-paper px-4">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{item.productName}</p>
                <p className="mt-0.5 text-xs text-smoke">{item.variantName} · Qty {item.quantity}</p>
                {item.warnings.map((warning) => <p key={warning.code} className="mt-1 text-xs text-warning">{warning.message}</p>)}
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{item.unitPricePaise === null ? "—" : formatPrice(item.unitPricePaise, { currency: item.currency })}</span>
                <Button size="sm" variant="outline" disabled={Boolean(pendingId)} loading={pendingId === item.id} onClick={() => void action(item.id, true)}>Move to cart</Button>
                <Button size="sm" variant="ghost" disabled={Boolean(pendingId)} onClick={() => void action(item.id, false)}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
