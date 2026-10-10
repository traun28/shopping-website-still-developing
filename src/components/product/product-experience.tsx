"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WishlistButton } from "@/components/storefront/wishlist-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Price } from "@/components/ui/price";
import { QuantitySelector } from "@/components/ui/quantity-selector";
import { Rating } from "@/components/ui/rating";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";
import { addProductToCart } from "@/lib/cart/client";
import { useCart } from "@/components/cart/cart-provider";
import { notify } from "@/lib/toast";
import type { RecommendationAttribution } from "@/services/cart/types";
import { galleryImagesFor } from "@/lib/catalog/gallery";
import type { PdpProductDTO } from "@/lib/catalog/pdp-dto";
import { MAX_QUANTITY, clampQuantity } from "@/lib/catalog/quantity";
import {
  colorOptionState,
  findVariant,
  selectColor,
  selectSize,
  selectionToQuery,
  sizeOptionState,
  type Selection,
} from "@/lib/catalog/variant-selection";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ColorSelector } from "./color-selector";
import { ProductGallery } from "./product-gallery";
import { SizeGuide } from "./size-guide";
import { SizeSelector } from "./size-selector";

/** The slice of the product the interactive part needs (no long-form content). */
export type ProductExperienceProduct = Pick<
  PdpProductDTO,
  | "id"
  | "slug"
  | "name"
  | "shortDescription"
  | "productTypeLabel"
  | "price"
  | "variants"
  | "colors"
  | "sizes"
  | "purchasable"
  | "images"
  | "sizeChart"
  | "rating"
  | "isNew"
>;

const STATE_LABEL = {
  AVAILABLE: "Available to order",
  OUT_OF_STOCK: "Out of stock",
  UNAVAILABLE: "Currently unavailable",
} as const;

/**
 * The interactive product area: gallery + options + purchase controls share
 * one selection state so the price, availability, SKU and image always agree.
 * Long-form content is passed in as server-rendered `children`.
 */
export function ProductExperience({
  product,
  initialSelection,
  saved,
  categoryLabel,
  browseHref,
  children,
  recommendation = null,
}: {
  product: ProductExperienceProduct;
  initialSelection: Selection;
  saved: boolean;
  categoryLabel: string;
  /** "Browse Similar Products" target when nothing can be ordered. */
  browseHref: string;
  children?: ReactNode;
  recommendation?: RecommendationAttribution | null;
}) {
  const router = useRouter();
  const cart = useCart();
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [barVisible, setBarVisible] = useState(false);
  const ctaRef = useRef<HTMLDivElement>(null);

  const { variants } = product;
  const variant = findVariant(variants, selection);
  const price = variant?.price ?? product.price;
  const gallery = useMemo(() => galleryImagesFor(product.images, selection.color), [product.images, selection.color]);
  const galleryKey = gallery.map((image) => image.url).join("|");
  const canBuy = variant?.state === "AVAILABLE";
  const hasOptions = product.colors.length > 0 || product.sizes.length > 0;

  // Sticky mobile bar only appears once the real button has scrolled away.
  useEffect(() => {
    const node = ctaRef.current;
    if (!node || typeof IntersectionObserver === "undefined" || !product.purchasable) return;
    const observer = new IntersectionObserver(([entry]) => {
      setBarVisible(Boolean(entry) && !entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [product.purchasable]);

  function syncUrl(next: Selection) {
    const query = selectionToQuery(next);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }

  function apply(next: Selection, changed: "color" | "size", key: string) {
    setSelection(next);
    setMessage(null);
    syncUrl(next);
    const chosen = findVariant(variants, next);
    trackStorefrontEvent({
      name: changed === "color" ? STOREFRONT_EVENTS.COLOR_SELECTED : STOREFRONT_EVENTS.SIZE_SELECTED,
      consent: "analytics",
      payload: { slug: product.slug, option: key },
    });
    if (chosen) {
      trackStorefrontEvent({
        name: STOREFRONT_EVENTS.VARIANT_SELECTED,
        consent: "analytics",
        payload: { slug: product.slug, sku: chosen.sku },
      });
    }
  }

  async function onAddToCart() {
    if (!variant || !canBuy || pending) return;
    setPending(true);
    setMessage(null);
    trackStorefrontEvent({
      name: STOREFRONT_EVENTS.ADD_TO_CART_CLICKED,
      consent: "analytics",
      payload: { slug: product.slug, sku: variant.sku, quantity },
    });
    try {
      // Only ids + quantity leave the browser. The server re-checks and prices everything.
      const result = await addProductToCart({
        productId: product.id,
        variantId: variant.id,
        quantity,
        cartVersion: cart.cart?.version ?? 0,
        source: recommendation ? "CART_RECOMMENDATION" : "PRODUCT_PAGE",
        recommendation,
      });
      if (result.status === "REJECTED") {
        setMessage(result.message);
        router.refresh(); // pick up the changed price / availability
      } else if (result.result.currentUnitPricePaise !== undefined && result.result.currentUnitPricePaise !== variant.price.amountPaise) {
        notify.warning("Added at an updated price", `The current price is ${formatPrice(result.result.currentUnitPricePaise)} per item.`);
      } else {
        notify.addedToCart(product.name);
      }
    } catch {
      setMessage("We couldn't check this item right now. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const buttonLabel = !variant
    ? "Select options"
    : variant.state === "OUT_OF_STOCK"
      ? "Out of stock"
      : variant.state === "UNAVAILABLE"
        ? "Unavailable"
        : "Add to cart";

  return (
    <div className={cn("grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14", product.purchasable && "pb-24 lg:pb-0")}>
      <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <ProductGallery key={galleryKey} images={gallery} productName={product.name} productSlug={product.slug} />
      </div>

      <div className="min-w-0">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-smoke">{categoryLabel}</p>
        <h1 className="mt-2 font-display text-3xl font-extrabold uppercase leading-[0.98] [overflow-wrap:anywhere] sm:text-4xl xl:text-5xl">
          {product.name}
        </h1>
        {product.rating ? (
          <a href="#reviews" className="mt-4 inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame">
            <Rating value={product.rating.average} count={product.rating.count} size="md" />
          </a>
        ) : null}

        <div className="mt-5" aria-live="polite" aria-atomic="true" data-testid="price-block">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Price amount={price.amountPaise} compareAt={price.compareAtPaise ?? undefined} size="lg" />
            {price.discountPercent ? <Badge variant="soft">{price.discountPercent}% off</Badge> : null}
            {product.isNew ? <Badge variant="outline">New</Badge> : null}
          </div>
          {product.purchasable && variant ? (
            <p className="mt-2 text-sm text-smoke">
              <span data-testid="availability">{STATE_LABEL[variant.state]}</span>
              {" · "}
              <span className="break-all font-mono text-[11px]" data-testid="sku">
                SKU {variant.sku}
              </span>
            </p>
          ) : null}
        </div>

        {product.shortDescription ? (
          <p className="mt-5 max-w-prose text-base leading-relaxed text-smoke [overflow-wrap:anywhere]">{product.shortDescription}</p>
        ) : null}

        {product.purchasable ? (
          <div className="mt-7 flex flex-col gap-6">
            {hasOptions ? (
              <div className="flex flex-col gap-6">
                {product.colors.length > 0 ? (
                  <ColorSelector
                    colors={product.colors}
                    selected={selection.color}
                    stateOf={(key) => colorOptionState(variants, key)}
                    onSelect={(key) => apply(selectColor(variants, selection, key), "color", key)}
                  />
                ) : null}
                {product.sizes.length > 0 ? (
                  <SizeSelector
                    sizes={product.sizes}
                    selected={selection.size}
                    stateOf={(key) => sizeOptionState(variants, selection, key)}
                    onSelect={(key) => apply(selectSize(variants, selection, key), "size", key)}
                    action={<SizeGuide chart={product.sizeChart} productSlug={product.slug} />}
                  />
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center gap-4">
              <span id="quantity-label" className="font-mono text-[10px] uppercase tracking-[0.18em] text-smoke">
                Quantity
              </span>
              <QuantitySelector
                value={quantity}
                onValueChange={(next) => setQuantity(clampQuantity(next))}
                max={MAX_QUANTITY}
                disabled={!canBuy}
              />
            </div>

            <div ref={ctaRef} className="flex flex-col gap-3 sm:flex-row">
              <Button
                type="button"
                size="lg"
                className="w-full sm:flex-1"
                disabled={!canBuy}
                loading={pending}
                onClick={onAddToCart}
              >
                <ShoppingBag className="size-4" aria-hidden />
                {buttonLabel}
              </Button>
              <WishlistButton
                productId={product.id}
                productTitle={product.name}
                saved={saved}
                label="Save"
                returnTo={`/product/${product.slug}`}
                className="h-13 sm:px-6"
              />
            </div>
            <p role="alert" className={cn("text-sm text-danger", !message && "sr-only")}>
              {message}
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-4" data-testid="unavailable-state">
            <p role="status" className="rounded-card border-[1.5px] border-ink bg-cream px-4 py-3 text-sm font-medium">
              This product is currently unavailable.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link href={browseHref}>Browse Similar Products</Link>
              </Button>
              <WishlistButton
                productId={product.id}
                productTitle={product.name}
                saved={saved}
                label="Save"
                returnTo={`/product/${product.slug}`}
                className="h-13 sm:px-6"
              />
            </div>
          </div>
        )}

        {children}
      </div>

      {product.purchasable && barVisible ? (
        <div
          data-testid="sticky-purchase-bar"
          className="fixed inset-x-0 bottom-0 z-40 border-t-[1.5px] border-ink bg-paper/95 px-4 py-3 backdrop-blur lg:hidden"
        >
          <div className="mx-auto flex max-w-xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{product.name}</p>
              <p className="truncate font-mono text-xs text-smoke">
                {formatPrice(price.amountPaise)}
                {variant && (variant.color || variant.size) ? ` · ${[variant.color, variant.size].filter(Boolean).join(" / ")}` : ""}
              </p>
            </div>
            <Button type="button" size="md" disabled={!canBuy} loading={pending} onClick={onAddToCart}>
              {buttonLabel}
            </Button>
          </div>
        </div>
      ) : null}

    </div>
  );
}
