import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { images, products, productVariants, users, wishlistItems, wishlists } from "@/db/schema";
import { withTransaction, type DbClient } from "@/db/utils";
import { NotFoundError } from "@/lib/errors";
import { isSafeImageSrc } from "@/lib/safe-url";
import { availableQuantity } from "@/lib/catalog/inventory";
import { quoteProductPrices, quoteVariantPrices } from "@/services/catalog/pricing.service";
import { applyEventToInterest, recordBehavioralEvent } from "@/services/recommendations/events.service";
import { logger } from "@/lib/logger";

/** Wishlist is a product-level collection; the optional variant is only a preferred option. */
export interface WishlistVariant {
  id: string;
  name: string;
  size: string | null;
  color: string | null;
  pricePaise: number | null;
  currency: string;
  availableQuantity: number;
  purchasable: boolean;
}

export interface WishlistEntry {
  itemId: string;
  addedAt: Date;
  productId: string;
  productName: string;
  productSlug: string;
  productStatus: string;
  imageUrl: string | null;
  minPricePaise: number | null;
  compareAtPaise: number | null;
  currency: string;
  preferredVariantId: string | null;
  variants: WishlistVariant[];
  availability: "AVAILABLE" | "LOW_STOCK" | "UNAVAILABLE" | "ARCHIVED";
}

/** Ensure the user's default wishlist container exists; returns its id. */
export async function ensureWishlist(userId: string, client: DbClient = db): Promise<string> {
  const [existing] = await client.select().from(wishlists).where(eq(wishlists.userId, userId)).limit(1);
  if (existing) return existing.id;
  const [created] = await client
    .insert(wishlists)
    .values({ userId, name: "Saved items" })
    .onConflictDoNothing({ target: [wishlists.userId, wishlists.name] })
    .returning();
  if (created) return created.id;
  const [fallback] = await client.select().from(wishlists).where(eq(wishlists.userId, userId)).limit(1);
  if (!fallback) throw new NotFoundError("Wishlist unavailable.");
  return fallback.id;
}

async function wishlistEvent(userId: string, productId: string, eventType: "WISHLIST_ADD" | "WISHLIST_REMOVE"): Promise<void> {
  try {
    const [product] = await db
      .select({ categoryId: products.categoryId, brandId: products.brandId, productType: products.productType, basePrice: products.basePrice })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    await recordBehavioralEvent({ eventType, userId, productId, source: "wishlist" });
    await applyEventToInterest({
      userId,
      eventType,
      productId,
      categoryId: product?.categoryId,
      brandId: product?.brandId,
      productType: product?.productType,
      pricePaise: product?.basePrice,
    });
  } catch (error) {
    logger.warn("wishlist analytics event processing failed", {
      eventType,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/** Add (idempotent). Returns true when newly added, false if present. */
export async function addToWishlist(userId: string, productId: string): Promise<boolean> {
  const [product] = await db
    .select({ id: products.id, status: products.status, visibility: products.visibility, sellerId: products.sellerId, sellerStatus: users.status })
    .from(products)
    .leftJoin(users, eq(users.id, products.sellerId))
    .where(eq(products.id, productId))
    .limit(1);
  if (!product || product.status !== "ACTIVE" || product.visibility === "PRIVATE" || (product.sellerId && product.sellerStatus !== "ACTIVE")) {
    throw new NotFoundError("That product isn't available anymore.");
  }

  const inserted = await withTransaction(async (tx) => {
    const wishlistId = await ensureWishlist(userId, tx);
    const rows = await tx
      .insert(wishlistItems)
      .values({ wishlistId, productId })
      .onConflictDoNothing({ target: [wishlistItems.wishlistId, wishlistItems.productId] })
      .returning({ id: wishlistItems.id });
    return rows.length > 0;
  });
  if (inserted) await wishlistEvent(userId, productId, "WISHLIST_ADD");
  return inserted;
}

/** Toggle convenience for existing server actions. */
export async function toggleWishlist(userId: string, productId: string): Promise<{ saved: boolean }> {
  const wishlistId = await ensureWishlist(userId);
  const [existing] = await db
    .select({ id: wishlistItems.id })
    .from(wishlistItems)
    .where(and(eq(wishlistItems.wishlistId, wishlistId), eq(wishlistItems.productId, productId)))
    .limit(1);

  if (existing) {
    const removed = await db
      .delete(wishlistItems)
      .where(and(eq(wishlistItems.id, existing.id), eq(wishlistItems.wishlistId, wishlistId)))
      .returning({ productId: wishlistItems.productId });
    if (removed[0]) await wishlistEvent(userId, removed[0].productId, "WISHLIST_REMOVE");
    return { saved: false };
  }
  await addToWishlist(userId, productId);
  return { saved: true };
}

export async function removeFromWishlist(userId: string, itemId: string): Promise<void> {
  const wishlistId = await ensureWishlist(userId);
  const removed = await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.id, itemId), eq(wishlistItems.wishlistId, wishlistId)))
    .returning({ productId: wishlistItems.productId });
  if (removed[0]) await wishlistEvent(userId, removed[0].productId, "WISHLIST_REMOVE");
}

export async function removeProductFromWishlist(userId: string, productId: string): Promise<void> {
  const wishlistId = await ensureWishlist(userId);
  const removed = await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.wishlistId, wishlistId), eq(wishlistItems.productId, productId)))
    .returning({ productId: wishlistItems.productId });
  if (removed[0]) await wishlistEvent(userId, removed[0].productId, "WISHLIST_REMOVE");
}

export async function listWishlist(userId: string): Promise<WishlistEntry[]> {
  const wishlistId = await ensureWishlist(userId);
  const rows = await db
    .select({
      itemId: wishlistItems.id,
      addedAt: wishlistItems.createdAt,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      productStatus: products.status,
      visibility: products.visibility,
      currency: products.currency,
      basePrice: products.basePrice,
      categoryId: products.categoryId,
      brandId: products.brandId,
      productType: products.productType,
      sellerId: products.sellerId,
      sellerStatus: users.status,
      lowStockThreshold: products.lowStockThreshold,
      preferredVariantId: wishlistItems.variantId,
    })
    .from(wishlistItems)
    .innerJoin(products, eq(products.id, wishlistItems.productId))
    .leftJoin(users, eq(users.id, products.sellerId))
    .where(eq(wishlistItems.wishlistId, wishlistId))
    .orderBy(desc(wishlistItems.createdAt));
  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((row) => row.productId))];
  const variantRows = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      name: productVariants.name,
      size: productVariants.size,
      color: productVariants.color,
      imageId: productVariants.imageId,
      active: productVariants.isActive,
      availability: productVariants.availability,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
    })
    .from(productVariants)
    .where(inArray(productVariants.productId, productIds))
    .orderBy(asc(productVariants.position), asc(productVariants.createdAt));
  const activeVariantIds = variantRows.filter((variant) => variant.active).map((variant) => variant.id);
  const [variantPrices, productPrices] = await Promise.all([
    quoteVariantPrices(activeVariantIds),
    quoteProductPrices(productIds),
  ]);
  const variantsByProduct = new Map<string, WishlistVariant[]>();
  for (const variant of variantRows) {
    if (!variant.active) continue;
    const row = rows.find((entry) => entry.productId === variant.productId);
    const currentPrice = variantPrices.get(variant.id);
    const available = availableQuantity({ stockQuantity: variant.stockQuantity, reservedQuantity: variant.reservedQuantity });
    const productCanSell = Boolean(row && row.productStatus === "ACTIVE" && row.visibility !== "PRIVATE" && (!row.sellerId || row.sellerStatus === "ACTIVE"));
    const purchasable = Boolean(productCanSell && available > 0 && (variant.availability === "IN_STOCK" || variant.availability === "LOW_STOCK") && currentPrice);
    const item = variantsByProduct.get(variant.productId) ?? [];
    item.push({
      id: variant.id,
      name: variant.name,
      size: variant.size,
      color: variant.color,
      pricePaise: productCanSell ? currentPrice?.finalPaise ?? null : null,
      currency: row?.currency ?? "INR",
      availableQuantity: available,
      purchasable,
    });
    variantsByProduct.set(variant.productId, item);
  }

  const imageIds = [...new Set(variantRows.flatMap((variant) => (variant.imageId ? [variant.imageId] : [])))];
  const imageRows = productIds.length
    ? await db
        .select({ id: images.id, productId: images.productId, url: images.url, role: images.role, sortOrder: images.sortOrder })
        .from(images)
        .where(and(inArray(images.productId, productIds), eq(images.type, "PRODUCT")))
        .orderBy(sql`case ${images.role} when 'PRIMARY' then 0 when 'GALLERY' then 1 else 2 end`, asc(images.sortOrder))
    : [];
  const variantImages = imageIds.length ? await db.select({ id: images.id, url: images.url }).from(images).where(inArray(images.id, imageIds)) : [];
  const imageByProduct = new Map<string, string>();
  for (const image of imageRows) {
    if (image.productId && !imageByProduct.has(image.productId) && isSafeImageSrc(image.url)) imageByProduct.set(image.productId, image.url);
  }
  const imageById = new Map(variantImages.filter((image) => isSafeImageSrc(image.url)).map((image) => [image.id, image.url]));
  const variantById = new Map(variantRows.map((variant) => [variant.id, variant]));

  return rows.map((row) => {
    const productSellable = row.productStatus === "ACTIVE" && row.visibility !== "PRIVATE" && (!row.sellerId || row.sellerStatus === "ACTIVE");
    const variants = variantsByProduct.get(row.productId) ?? [];
    const livePrices = variants.flatMap((variant) => (variant.pricePaise !== null ? [variant.pricePaise] : []));
    const productPrice = productPrices.get(row.productId);
    const minPrice = livePrices.length ? Math.min(...livePrices) : productSellable ? productPrice?.finalPaise ?? null : null;
    const preferred = row.preferredVariantId ? variantById.get(row.preferredVariantId) : undefined;
    const compareAt = preferred
      ? variantPrices.get(preferred.id)?.compareAtPaise ?? null
      : productPrice?.compareAtPaise ?? null;
    const anyAvailable = variants.filter((variant) => variant.purchasable);
    const hasLowStock = anyAvailable.some((variant) => variant.availableQuantity <= Math.max(1, row.lowStockThreshold));
    const availability: WishlistEntry["availability"] = !productSellable
      ? "ARCHIVED"
      : anyAvailable.length === 0
        ? "UNAVAILABLE"
        : hasLowStock
          ? "LOW_STOCK"
          : "AVAILABLE";
    return {
      itemId: row.itemId,
      addedAt: row.addedAt,
      productId: row.productId,
      productName: row.productName,
      productSlug: row.productSlug,
      productStatus: row.productStatus,
      imageUrl: (preferred?.imageId ? imageById.get(preferred.imageId) : undefined) ?? imageByProduct.get(row.productId) ?? null,
      minPricePaise: minPrice,
      compareAtPaise: compareAt,
      currency: row.currency,
      preferredVariantId: row.preferredVariantId,
      variants,
      availability,
    };
  });
}

/** Read-only ids. Does not create a wishlist row for visitors who have never saved. */
export async function listWishlistProductIds(userId: string): Promise<string[]> {
  const [wishlist] = await db
    .select({ id: wishlists.id })
    .from(wishlists)
    .where(eq(wishlists.userId, userId))
    .limit(1);
  if (!wishlist) return [];

  const rows = await db
    .select({ productId: wishlistItems.productId })
    .from(wishlistItems)
    .where(eq(wishlistItems.wishlistId, wishlist.id));
  return rows.map((row) => row.productId);
}

export async function wishlistCount(userId: string): Promise<number> {
  const wishlistId = await ensureWishlist(userId);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.wishlistId, wishlistId));
  return Number(row?.n ?? 0);
}
