"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCart } from "@/components/cart/cart-provider";
import { cartMutation, CartClientError } from "@/lib/cart/client";
import { notify } from "@/lib/toast";
import type { WishlistVariant } from "@/services/wishlist.service";

export function WishlistMoveButton({
  itemId,
  productName,
  variants,
  preferredVariantId,
}: {
  itemId: string;
  productName: string;
  variants: WishlistVariant[];
  preferredVariantId: string | null;
}) {
  const { cart, refresh } = useCart();
  const router = useRouter();
  const first = useMemo(
    () => variants.find((variant) => variant.id === preferredVariantId) ?? variants.find((variant) => variant.purchasable) ?? variants[0],
    [preferredVariantId, variants],
  );
  const [variantId, setVariantId] = useState(first?.id ?? "");
  const [pending, setPending] = useState(false);
  const selected = variants.find((variant) => variant.id === variantId);

  async function move() {
    if (!selected?.purchasable || pending) return;
    setPending(true);
    try {
      await cartMutation(`/api/wishlist/${itemId}/move-to-cart`, {
        body: { variantId: selected.id, quantity: 1, cartVersion: cart?.version ?? 0 },
      });
      await refresh();
      notify.addedToCart(productName);
      router.refresh();
    } catch (error) {
      notify.error(error instanceof CartClientError ? error.message : "This item could not be moved to your cart.");
      await refresh();
    } finally {
      setPending(false);
    }
  }

  if (variants.length === 0) {
    return <p className="text-xs text-smoke">No active options are available.</p>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`wishlist-variant-${itemId}`}>Choose an option</label>
      <select
        id={`wishlist-variant-${itemId}`}
        value={variantId}
        onChange={(event) => setVariantId(event.target.value)}
        disabled={pending}
        className="min-h-9 max-w-full rounded-pill border border-clay bg-paper px-3 text-xs focus-visible:outline-2 focus-visible:outline-flame"
      >
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.name}{variant.pricePaise !== null ? ` · ${new Intl.NumberFormat("en-IN", { style: "currency", currency: variant.currency, maximumFractionDigits: 0 }).format(variant.pricePaise / 100)}` : " · Price unavailable"}{variant.purchasable ? "" : " · Unavailable"}
          </option>
        ))}
      </select>
      <Button size="sm" variant="primary" disabled={!selected?.purchasable || pending} loading={pending} onClick={() => void move()}>
        <ShoppingBag className="size-3.5" aria-hidden /> Move to cart
      </Button>
    </div>
  );
}
