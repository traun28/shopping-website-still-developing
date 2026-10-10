import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cartItems, images, products, productVariants, savedItems, users } from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { availableQuantity } from "@/lib/catalog/inventory";
import { isSafeImageSrc } from "@/lib/safe-url";
import { quoteVariantPrices } from "@/services/catalog/pricing.service";
import type { CartLineDTO, CartWarning, CartWarningCode, SavedItemDTO } from "@/types/cart";
import { calculateCartTotals } from "./totals.service";

interface StoredLine {
  id: string;
  productId: string;
  variantId: string;
  sellerId: string | null;
  quantity: number;
  unitPrice: number;
  currency: string;
  version: number;
  attributionSource: string | null;
  createdAt: Date;
}

interface ReconciledStoredLine {
  item: CartLineDTO;
  savedAt: string;
}

function warning(
  code: CartWarningCode,
  message: string,
  itemId: string,
  productId: string,
  extra: Partial<CartWarning> = {},
): CartWarning {
  return { code, message, itemId, productId, ...extra };
}

async function primaryImages(productIds: readonly string[], variantImageIds: readonly string[], client: DbClient) {
  const productSet = [...new Set(productIds)];
  const imageSet = [...new Set(variantImageIds)];
  const rows = productSet.length
    ? await client
        .select({ id: images.id, productId: images.productId, variantId: images.variantId, url: images.url, role: images.role, sortOrder: images.sortOrder })
        .from(images)
        .where(and(inArray(images.productId, productSet), eq(images.type, "PRODUCT")))
        .orderBy(sql`case ${images.role} when 'PRIMARY' then 0 when 'GALLERY' then 1 else 2 end`, asc(images.sortOrder))
    : [];
  const byProduct = new Map<string, string>();
  for (const row of rows) {
    if (!row.productId || !isSafeImageSrc(row.url) || byProduct.has(row.productId)) continue;
    byProduct.set(row.productId, row.url);
  }

  const variantRows = imageSet.length
    ? await client
        .select({ id: images.id, url: images.url })
        .from(images)
        .where(inArray(images.id, imageSet))
    : [];
  const byVariantImage = new Map(variantRows.filter((row) => isSafeImageSrc(row.url)).map((row) => [row.id, row.url]));
  return { byProduct, byVariantImage };
}

/**
 * Single live reconciliation path for active cart and Save for Later lines.
 * The stored `unitPrice` is only an observed-price snapshot. Current price,
 * rules, seller status and inventory are re-read before this DTO is returned.
 */
async function reconcileStoredLines(
  stored: readonly StoredLine[],
  cartCurrency: string,
  client: DbClient,
): Promise<ReconciledStoredLine[]> {
  if (stored.length === 0) return [];
  const productIds = [...new Set(stored.map((line) => line.productId))];
  const variantIds = [...new Set(stored.map((line) => line.variantId))];
  const [productRows, variantRows] = await Promise.all([
    client
      .select({
        productId: products.id,
        productName: products.name,
        slug: products.slug,
        productStatus: products.status,
        visibility: products.visibility,
        productCurrency: products.currency,
        productSellerId: products.sellerId,
        sellerName: users.name,
        sellerStatus: users.status,
      })
      .from(products)
      .leftJoin(users, eq(users.id, products.sellerId))
      .where(inArray(products.id, productIds)),
    client
      .select({
        variantId: productVariants.id,
        productId: productVariants.productId,
        variantName: productVariants.name,
        size: productVariants.size,
        color: productVariants.color,
        variantImageId: productVariants.imageId,
        variantActive: productVariants.isActive,
        availability: productVariants.availability,
        stockQuantity: productVariants.stockQuantity,
        reservedQuantity: productVariants.reservedQuantity,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds)),
  ]);
  const productById = new Map(productRows.map((row) => [row.productId, row]));
  const variantById = new Map(variantRows.map((row) => [row.variantId, row]));
  const productIdsWithImage = productRows.map((row) => row.productId);
  const variantImageIds = variantRows.flatMap((row) => (row.variantImageId ? [row.variantImageId] : []));
  const imageData = await primaryImages(productIdsWithImage, variantImageIds, client);

  const priceVariantIds = stored
    .filter((line) => {
      const product = productById.get(line.productId);
      const variant = variantById.get(line.variantId);
      return Boolean(
        product &&
          variant?.productId === line.productId &&
          product.productStatus === "ACTIVE" &&
          product.visibility !== "PRIVATE" &&
          (!product.productSellerId || product.sellerStatus === "ACTIVE"),
      );
    })
    .map((line) => line.variantId);
  // Pricing is required to reconcile the cart. Fail closed if this service fails.
  const prices = await quoteVariantPrices(priceVariantIds, {}, client);

  const output: ReconciledStoredLine[] = [];
  for (const line of stored) {
    const product = productById.get(line.productId);
    const rawVariant = variantById.get(line.variantId);
    const variant = rawVariant?.productId === line.productId ? rawVariant : undefined;
    const row = product && variant ? { ...product, ...variant } : product ? { ...product, variantId: null as string | null, variantName: null as string | null, size: null as string | null, color: null as string | null, variantImageId: null as string | null, variantActive: null as boolean | null, availability: null as "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "PREORDER" | null, stockQuantity: null as number | null, reservedQuantity: null as number | null } : undefined;
    const productId = row?.productId ?? line.productId;
    const itemWarnings: CartWarning[] = [];
    const productAvailable = Boolean(
      row?.productId && row.productStatus === "ACTIVE" && row.visibility !== "PRIVATE",
    );
    const sellerAvailable = !row?.productSellerId || row.sellerStatus === "ACTIVE";
    const variantExists = Boolean(variant);
    const variantActive = variant?.variantActive === true;
    const available =
      variant?.stockQuantity === null || variant?.stockQuantity === undefined
        ? 0
        : availableQuantity({ stockQuantity: variant.stockQuantity, reservedQuantity: variant.reservedQuantity ?? 0 });
    const variantOrderable =
      variantActive &&
      (variant?.availability === "IN_STOCK" || variant?.availability === "LOW_STOCK") &&
      available > 0;
    const pricing = variant?.variantId ? prices.get(variant.variantId) : undefined;
    const lineCurrency = row?.productCurrency ?? line.currency;
    const currencyOkay = line.currency === cartCurrency && lineCurrency === cartCurrency;
    let currentPrice = pricing?.finalPaise ?? null;
    if (!currencyOkay) currentPrice = null;

    if (!productAvailable) {
      itemWarnings.push(warning("PRODUCT_UNAVAILABLE", "This product is no longer available to purchase.", line.id, productId));
    }
    if (productAvailable && !variantExists) {
      itemWarnings.push(warning("VARIANT_UNAVAILABLE", "This option is no longer available.", line.id, productId));
    } else if (productAvailable && variantExists && !variantActive) {
      itemWarnings.push(warning("VARIANT_UNAVAILABLE", "This option is no longer available.", line.id, productId));
    } else if (productAvailable && variantExists && !variantOrderable) {
      itemWarnings.push(warning("OUT_OF_STOCK", "This option is currently out of stock.", line.id, productId, { availableQuantity: available }));
    }
    if (productAvailable && variantOrderable && line.quantity > available) {
      itemWarnings.push(
        warning("STOCK_REDUCED", `Only ${available} unit${available === 1 ? " is" : "s are"} available now.`, line.id, productId, {
          availableQuantity: available,
          requestedQuantity: line.quantity,
        }),
      );
    }
    if (!sellerAvailable) {
      itemWarnings.push(warning("SELLER_UNAVAILABLE", "The seller is not currently able to fulfill this item.", line.id, productId));
      currentPrice = null;
    }
    if (!currencyOkay) {
      itemWarnings.push(warning("CURRENCY_MISMATCH", "This item uses a different currency and cannot be included in this cart.", line.id, productId));
    }
    if (line.quantity > 10) {
      itemWarnings.push(warning("QUANTITY_LIMIT", "This item exceeds the current per-line purchase limit.", line.id, productId, { requestedQuantity: line.quantity }));
    }
    if (currentPrice !== null && currentPrice !== line.unitPrice) {
      itemWarnings.push(
        warning("PRICE_CHANGED", "The current price differs from the last price saved in this cart.", line.id, productId, {
          previousUnitPricePaise: line.unitPrice,
          currentUnitPricePaise: currentPrice,
        }),
      );
    }

    const listPrice = currencyOkay && productAvailable && sellerAvailable ? pricing?.originalPaise ?? null : null;
    const compareAt = currencyOkay && productAvailable && sellerAvailable ? pricing?.compareAtPaise ?? null : null;
    const validPrice = currentPrice !== null && productAvailable && sellerAvailable;
    const lineSubtotal = validPrice ? currentPrice! * line.quantity : null;
    const lineDiscount = validPrice && listPrice !== null ? Math.max(0, listPrice - currentPrice!) * line.quantity : 0;
    const taxPaise = validPrice ? (pricing?.taxPaise ?? 0) * line.quantity : 0;
    const purchasable = itemWarnings.length === 0;

    output.push({
      item: {
        id: line.id,
        productId,
        variantId: line.variantId,
        slug: row?.slug ?? "",
        productName: row?.productName ?? "Unavailable product",
        variantName: row?.variantName ?? "Unavailable option",
        size: row?.size ?? null,
        color: row?.color ?? null,
        imageUrl:
          (row?.variantImageId ? imageData.byVariantImage.get(row.variantImageId) : undefined) ??
          (row?.productId ? imageData.byProduct.get(row.productId) : undefined) ??
          null,
        sellerId: row?.productSellerId ?? line.sellerId,
        sellerName: row?.sellerName ?? null,
        quantity: line.quantity,
        currency: currencyOkay ? cartCurrency : line.currency,
        observedUnitPricePaise: line.unitPrice,
        unitPricePaise: validPrice ? currentPrice : null,
        compareAtPaise: compareAt,
        listUnitPricePaise: listPrice,
        lineSubtotalPaise: lineSubtotal,
        lineDiscountPaise: lineDiscount,
        estimatedTaxPaise: taxPaise,
        availableQuantity: available,
        purchasable,
        attributionSource: line.attributionSource,
        version: line.version,
        warnings: itemWarnings,
      },
      savedAt: line.createdAt.toISOString(),
    });
  }
  return output;
}

export async function reconcileCartItems(
  cartId: string,
  currency: string,
  client: DbClient = db,
): Promise<{ items: CartLineDTO[]; warnings: CartWarning[]; totals: ReturnType<typeof calculateCartTotals>; readyForCheckout: boolean }> {
  const stored = await client
    .select({
      id: cartItems.id,
      productId: cartItems.productId,
      variantId: cartItems.variantId,
      sellerId: cartItems.sellerId,
      quantity: cartItems.quantity,
      unitPrice: cartItems.unitPrice,
      currency: cartItems.currency,
      version: cartItems.version,
      attributionSource: cartItems.attributionSource,
      createdAt: cartItems.createdAt,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.createdAt));
  const resolved = await reconcileStoredLines(stored, currency, client);
  const items = resolved.map(({ item }) => item);
  const warnings = items.flatMap((item) => item.warnings);
  const totals = calculateCartTotals(
    items.map((item) => ({
      quantity: item.quantity,
      currentUnitPricePaise: item.unitPricePaise,
      listUnitPricePaise: item.listUnitPricePaise,
      estimatedTaxPerUnitPaise: item.quantity > 0 ? Math.trunc(item.estimatedTaxPaise / item.quantity) : 0,
    })),
    currency,
  );
  return { items, warnings, totals, readyForCheckout: items.length > 0 && warnings.length === 0 };
}

export async function reconcileSavedItems(
  cartId: string,
  currency: string,
  client: DbClient = db,
): Promise<{ items: SavedItemDTO[]; warnings: CartWarning[] }> {
  const stored = await client
    .select({
      id: savedItems.id,
      productId: savedItems.productId,
      variantId: savedItems.variantId,
      sellerId: savedItems.sellerId,
      quantity: savedItems.quantity,
      unitPrice: savedItems.unitPrice,
      currency: savedItems.currency,
      version: sql<number>`1`,
      attributionSource: sql<string | null>`null`,
      createdAt: savedItems.createdAt,
    })
    .from(savedItems)
    .where(eq(savedItems.cartId, cartId))
    .orderBy(asc(savedItems.createdAt));
  const resolved = await reconcileStoredLines(stored, currency, client);
  return {
    items: resolved.map(({ item, savedAt }) => ({ ...item, savedAt })),
    warnings: resolved.flatMap(({ item }) => item.warnings),
  };
}
