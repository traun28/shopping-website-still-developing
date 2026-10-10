"use client";

import Link from "next/link";
import { Eye, ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { QuickViewDialog } from "@/components/cards/quick-view-dialog";
import { Rating } from "@/components/ui/rating";
import { WishlistButton } from "@/components/storefront/wishlist-button";
import { productPath } from "@/lib/storefront-paths";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProductBadge as ProductBadgeKind, ProductSummary } from "@/types";

const badgeMap: Record<ProductBadgeKind, { variant: "new" | "bestseller" | "sale" | "limited" | "sold-out"; label: string }> = {
  NEW: { variant: "new", label: "New" },
  BESTSELLER: { variant: "bestseller", label: "Bestseller" },
  SALE: { variant: "sale", label: "Sale" },
  LIMITED: { variant: "limited", label: "Limited" },
  LOW_STOCK: { variant: "limited", label: "Low stock" },
  SOLD_OUT: { variant: "sold-out", label: "Unavailable" },
};

const availabilityLabel: Record<NonNullable<ProductSummary["availability"]>, string | null> = {
  in_stock: null,
  low_stock: "Low stock",
  sold_out: "Unavailable",
  coming_soon: "Coming soon",
};

function discountPercent(pricePaise: number, compareAtPaise?: number): number | null {
  if (!compareAtPaise || compareAtPaise <= pricePaise) return null;
  return Math.round(((compareAtPaise - pricePaise) / compareAtPaise) * 100);
}

export interface ProductCardProps {
  product: ProductSummary;
  /** Defaults to the public product path. Pass null to render without a link. */
  href?: string | null;
  layout?: "grid" | "list";
  priority?: boolean;
  saved?: boolean;
  onProductClick?: () => void;
}

/**
 * The one product card. Used on the homepage, category, collection,
 * search and recommendation surfaces.
 */
export function ProductCard({ product, href, layout = "grid", priority, saved = false, onProductClick }: ProductCardProps) {
  const destination = href === null ? null : (href ?? productPath(product.slug));
  const soldOut = product.availability === "sold_out";
  const discount = discountPercent(product.pricePaise, product.compareAtPaise);
  const availabilityNote = product.availability ? availabilityLabel[product.availability] : null;
  const imageAlt = product.imageAlt || product.title;

  const image = (
    <ProductImage
      src={product.image}
      hoverSrc={product.hoverImage}
      alt={imageAlt}
      priority={priority}
      imageClassName={soldOut ? "opacity-60 saturate-50" : undefined}
      sizes={
        layout === "list"
          ? "(max-width: 640px) 40vw, 220px"
          : "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
      }
    />
  );

  const media = (
    <div className="relative">
      {destination ? (
        <Link
          href={destination}
          data-track="PRODUCT_CLICK"
          data-track-id={product.slug}
          data-track-label={product.title}
          onClick={onProductClick}
          className="block rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
        >
          {image}
        </Link>
      ) : (
        image
      )}

      <div className="absolute left-3 top-3 z-20 flex flex-col items-start gap-1.5">
        {product.badge ? <Badge variant={badgeMap[product.badge].variant}>{badgeMap[product.badge].label}</Badge> : null}
        {discount ? (
          <Badge variant="sale">
            <span aria-hidden>−{discount}%</span>
            <span className="sr-only">{discount} percent less than the compare-at price</span>
          </Badge>
        ) : null}
      </div>

      <div className="absolute right-3 top-3 z-20 flex flex-col gap-2">
        <WishlistButton productId={product.id} productTitle={product.title} saved={saved} />
        <QuickViewDialog
          product={product}
          saved={saved}
          trigger={
            <button
              type="button"
              aria-label={`Quick view ${product.title}`}
              className="flex size-10 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
            >
              <Eye className="size-4" aria-hidden />
            </button>
          }
        />
      </div>

      {!soldOut && destination ? (
        <div className="absolute inset-x-3 bottom-3 z-20">
          <Link
            href={destination}
            onClick={onProductClick}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-pill border-[1.5px] border-ink bg-ink px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-paper transition-colors hover:border-flame hover:bg-flame hover:text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          >
            <ShoppingBag className="size-3.5" aria-hidden />
            Choose options · {formatPrice(product.pricePaise)}
          </Link>
        </div>
      ) : null}
    </div>
  );

  const title = <span className="mt-1 block font-display text-base font-bold leading-tight">{product.title}</span>;

  const body = (
    <div className={cn("flex flex-col gap-1.5 px-1 pt-3", layout === "list" && "pt-0")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-smoke">{product.category}</p>
          {destination ? (
            <h3>
              <Link
                href={destination}
                data-track="PRODUCT_CLICK"
                data-track-id={product.slug}
                data-track-label={product.title}
                onClick={onProductClick}
                className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
              >
                {title}
              </Link>
            </h3>
          ) : (
            <h3>{title}</h3>
          )}
        </div>
        {!soldOut ? (
          <Price amount={product.pricePaise} compareAt={product.compareAtPaise} className="shrink-0 pt-0.5" />
        ) : (
          <span className="font-mono text-xs text-smoke">Currently unavailable</span>
        )}
      </div>
      {product.rating ? <Rating value={product.rating.value} count={product.rating.count} /> : null}
      {availabilityNote && !soldOut ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-warning">{availabilityNote}</p>
      ) : null}
      {layout === "list" && product.blurb ? (
        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-smoke">{product.blurb}</p>
      ) : null}
    </div>
  );

  return (
    <article className={cn("group", layout === "list" && "grid grid-cols-[7.5rem_1fr] items-start gap-4 sm:grid-cols-[13rem_1fr] sm:gap-6")}>
      {media}
      {body}
    </article>
  );
}
