"use client";

import Image from "next/image";
import Link from "next/link";
import { ShoppingBag, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { QuantitySelector } from "@/components/ui/quantity-selector";
import { ComingSoonDialog } from "@/components/layout/coming-soon-dialog";
import { storefrontContent } from "@/content/storefront";
import { siteConfig } from "@/config/site";
import { formatPrice } from "@/lib/format";
import { cartMutation, CartClientError } from "@/lib/cart/client";
import { trackStorefrontEvent, STOREFRONT_EVENTS } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useCart } from "@/components/cart/cart-provider";

/** Live cart entry point with a compact, responsive mini-cart drawer. */
export function CartButton({ count = null, className }: { count?: number | null; className?: string }) {
  const cartLive = siteConfig.features.cart;
  const { cart, loading, refresh } = useCart();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleCount = typeof count === "number" ? count : cart?.itemCount ?? null;
  const showCount = cartLive && visibleCount !== null;
  const label = showCount ? `Cart, ${visibleCount} ${visibleCount === 1 ? "item" : "items"}` : "Cart";

  async function mutateLine(itemId: string, method: "PATCH" | "DELETE", body: Record<string, unknown>) {
    if (!cart || pendingId) return;
    setPendingId(itemId);
    setError(null);
    try {
      await cartMutation(`/api/cart/items/${itemId}`, {
        method,
        body: { ...body, cartVersion: cart.version },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof CartClientError ? cause.message : "Your cart could not be updated. Please try again.");
      await refresh();
    } finally {
      setPendingId(null);
    }
  }

  const trigger = (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => trackStorefrontEvent({ name: STOREFRONT_EVENTS.CART_OPENED, consent: "analytics" })}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper",
        "transition-all duration-300 hover:bg-ink hover:text-paper",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
        className,
      )}
    >
      <ShoppingBag className="size-4" aria-hidden />
      {showCount ? (
        <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-pill bg-flame px-1 font-mono text-[9px] font-semibold text-on-accent">
          {visibleCount}
        </span>
      ) : null}
    </button>
  );

  if (!cartLive) {
    return <ComingSoonDialog feature={storefrontContent.cart.feature} description={storefrontContent.cart.description} trigger={trigger} />;
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent side="right" className="overflow-y-auto p-6 pt-14 sm:p-8 sm:pt-14">
        <div className="flex items-start justify-between gap-4 border-b border-clay pb-5">
          <div>
            <DrawerTitle>Mini cart</DrawerTitle>
            <DrawerDescription className="mt-1">Saved items and current catalog prices. Checkout is not open yet.</DrawerDescription>
          </div>
        </div>
        {loading && !cart ? (
          <p className="py-10 text-sm text-smoke" role="status">Loading your cart…</p>
        ) : !cart?.items.length ? (
          <div className="py-10 text-center">
            <ShoppingBag className="mx-auto size-8 text-smoke" aria-hidden />
            <p className="mt-4 font-display text-lg font-bold uppercase">Your cart is empty</p>
            <p className="mt-1 text-sm text-smoke">Add a design to keep it here.</p>
            <Button asChild variant="outline" className="mt-5">
              <Link href="/shop" onClick={() => setOpen(false)}>Explore designs</Link>
            </Button>
          </div>
        ) : (
          <>
            {error ? <p role="alert" className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</p> : null}
            <ul className="divide-y divide-clay">
              {cart.items.slice(0, 4).map((item) => {
                const quantityLocked = item.warnings.some((warning) => ["PRODUCT_UNAVAILABLE", "VARIANT_UNAVAILABLE", "SELLER_UNAVAILABLE", "CURRENCY_MISMATCH", "OUT_OF_STOCK"].includes(warning.code));
                return (
                  <li key={item.id} className="flex gap-3 py-4">
                    <div className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-clay bg-sand">
                      {item.imageUrl ? <Image src={item.imageUrl} alt="" fill sizes="64px" className="object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-semibold">{item.productName}</p>
                          <p className="mt-0.5 truncate text-xs text-smoke">{item.variantName}</p>
                        </div>
                        <p className="shrink-0 font-mono text-sm font-semibold">
                          {item.unitPricePaise === null ? "—" : formatPrice(item.unitPricePaise * item.quantity, { currency: item.currency })}
                        </p>
                      </div>
                      {item.warnings.length ? <p className="mt-1 text-xs font-medium text-warning">{item.warnings[0]?.message}</p> : null}
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide text-smoke">Qty</span>
                          <QuantitySelector
                            id={`mini-cart-quantity-${item.id}`}
                            value={item.quantity}
                            max={Math.max(1, Math.min(10, item.availableQuantity || 10))}
                            disabled={Boolean(pendingId) || quantityLocked}
                            onValueChange={(quantity) => void mutateLine(item.id, "PATCH", { quantity })}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${item.productName} from cart`}
                          disabled={Boolean(pendingId)}
                          loading={pendingId === item.id}
                          onClick={() => void mutateLine(item.id, "DELETE", {})}
                        >
                          <Trash2 className="size-3.5" aria-hidden /> Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {cart.items.length > 4 ? <p className="text-xs text-smoke">And {cart.items.length - 4} more line items</p> : null}
            <div className="mt-4 border-t border-clay pt-4">
              <div className="flex justify-between text-sm"><span>Current subtotal</span><strong>{formatPrice(cart.totals.subtotalPaise, { currency: cart.currency })}</strong></div>
              <p className="mt-2 text-xs leading-relaxed text-smoke">Delivery is not included. You can keep editing your cart; payment and checkout are not available.</p>
              <Button asChild className="mt-5 w-full">
                <Link href="/cart" onClick={() => setOpen(false)}>View cart</Link>
              </Button>
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

export function CartButtonSlot({ children }: { children?: ReactNode }) {
  return children ?? <CartButton />;
}
