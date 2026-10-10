"use client";

import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { Rating } from "@/components/ui/rating";
import { WishlistButton } from "@/components/storefront/wishlist-button";
import { productPath } from "@/lib/storefront-paths";
import type { ProductSummary } from "@/types";

/**
 * Quick view. Wishlist uses the real account action. Variant selection lives
 * on the product page, so the CTA links there rather than guessing an option.
 */
export function QuickViewDialog({
  product,
  trigger,
  saved = false,
}: {
  product: ProductSummary;
  trigger: ReactNode;
  saved?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <div className="grid max-h-[80vh] grid-cols-1 overflow-y-auto sm:grid-cols-2 sm:overflow-visible">
          <div className="relative bg-sand p-4">
            <ProductImage
              src={product.image}
              alt={product.title}
              ratio="4:5"
              sizes="(max-width: 640px) 90vw, 320px"
              priority
              className="mx-auto max-w-xs sm:max-w-none"
            />
          </div>

          <div className="flex flex-col gap-4 p-6 sm:max-h-[80vh] sm:overflow-y-auto">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-smoke">{product.category}</p>
              <DialogTitle className="mt-2 text-2xl">{product.title}</DialogTitle>
              {product.rating ? <Rating value={product.rating.value} count={product.rating.count} size="md" className="mt-2" /> : null}
            </div>

            {product.blurb ? (
              <DialogDescription className="text-sm leading-relaxed">{product.blurb}</DialogDescription>
            ) : null}

            <div className="flex items-center gap-3">
              <Price amount={product.pricePaise} compareAt={product.compareAtPaise} size="lg" />
            </div>

            <div className="mt-1 flex flex-col gap-2.5">
              <Button asChild variant="primary" size="lg" className="w-full">
                <Link href={productPath(product.slug)}>
                  <ShoppingBag className="size-4" aria-hidden />
                  Choose options
                </Link>
              </Button>
              <WishlistButton
                productId={product.id}
                productTitle={product.title}
                saved={saved}
                label="Save to wishlist"
                className="w-full"
              />
              <Button asChild variant="outline" size="md" className="w-full">
                <Link href={productPath(product.slug)}>View product</Link>
              </Button>
            </div>

            <ul className="mt-2 space-y-2 border-t border-clay pt-4 text-xs text-smoke">
              <li>Printed after you order — not kept as finished stock.</li>
              <li>Checkout and delivery tracking are not open yet.</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
