import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, lt, or, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { cartPolicy } from "@/config/cart";
import { db } from "@/db";
import { cartItems, cartMutationKeys, carts, savedItems, users, products, productVariants, wishlists, wishlistItems } from "@/db/schema";
import { withTransaction, type DbClient, type DbTx } from "@/db/utils";
import { ConflictError, ForbiddenError, InsufficientStockError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { availableQuantity } from "@/lib/catalog/inventory";
import { currenciesMatch } from "@/services/cart/totals.service";
import { quoteVariantPrices } from "@/services/catalog/pricing.service";
import { applyCartPromotions } from "@/services/promotions/promotion.service";
import type { CartDTO, CartMergeResult, CartWarning, CartWarningCode, SavedItemDTO } from "@/types/cart";
import { reconcileCartItems, reconcileSavedItems } from "./reconciliation.service";
import { recordCartEvent } from "./events.service";
import type { CartAttributionSource, CartMutationOptions, CartMutationResult, CartPrincipal, RecommendationAttribution } from "./types";

export const MAX_CART_QUANTITY = 10;

type CartRow = typeof carts.$inferSelect;
type CartItemRow = typeof cartItems.$inferSelect;

function ownerCondition(principal: CartPrincipal) {
  if (principal.userId) return and(eq(carts.userId, principal.userId), isNull(carts.sessionId));
  if (principal.guestSessionHash) return and(isNull(carts.userId), eq(carts.sessionId, principal.guestSessionHash));
  throw new ValidationError("A cart session is required.");
}

function analyticsActor(principal: CartPrincipal) {
  return {
    userId: principal.userId,
    sessionHash: principal.analyticsSessionHash ?? principal.guestSessionHash,
  };
}

function assertPrincipal(principal: CartPrincipal): void {
  if (!principal.userId && !principal.guestSessionHash) {
    throw new ValidationError("A cart session is required.");
  }
}

function cartTtlMs(principal: CartPrincipal): number {
  const policy = cartPolicy();
  return principal.userId ? policy.userTtlMs : policy.guestTtlMs;
}

async function activeCart(principal: CartPrincipal, client: DbClient = db): Promise<CartRow | null> {
  const [row] = await client
    .select()
    .from(carts)
    .where(and(ownerCondition(principal), eq(carts.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

/** Get or create one owner cart; partial unique indexes resolve concurrent first writes. */
async function ensureCart(principal: CartPrincipal, allowCreate: boolean): Promise<{ cart: CartRow | null; created: boolean }> {
  assertPrincipal(principal);
  const now = new Date();
  const owner = ownerCondition(principal);
  const current = await activeCart(principal);
  if (current) {
    if (current.expiresAt && current.expiresAt <= now) {
      await db
        .update(carts)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(and(eq(carts.id, current.id), eq(carts.status, "ACTIVE")));
    } else {
      return { cart: current, created: false };
    }
  }

  // Reopen an unexpired abandoned cart rather than discarding a returning
  // customer's work. The conditional update makes concurrent reactivation safe.
  const [abandoned] = await db
    .select()
    .from(carts)
    .where(
      and(
        owner,
        eq(carts.status, "ABANDONED"),
        or(isNull(carts.expiresAt), gt(carts.expiresAt, now)),
      ),
    )
    .orderBy(desc(carts.lastActivityAt))
    .limit(1);
  if (abandoned) {
    const [reactivated] = await db
      .update(carts)
      .set({
        status: "ACTIVE",
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + cartTtlMs(principal)),
        updatedAt: now,
      })
      .where(and(eq(carts.id, abandoned.id), eq(carts.status, "ABANDONED")))
      .returning();
    if (reactivated) return { cart: reactivated, created: false };
    const raced = await activeCart(principal);
    if (raced) return { cart: raced, created: false };
  }

  if (!allowCreate) return { cart: null, created: false };
  const values = {
    userId: principal.userId,
    sessionId: principal.userId ? null : principal.guestSessionHash,
    currency: siteConfig.commerce.currency,
    status: "ACTIVE" as const,
    version: 1,
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + cartTtlMs(principal)),
  };
  const [created] = await db.insert(carts).values(values).onConflictDoNothing().returning();
  if (created) {
    await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_CREATED" });
    return { cart: created, created: true };
  }
  const raced = await activeCart(principal);
  if (raced) return { cart: raced, created: false };
  throw new ConflictError("Your cart is being updated. Please retry.");
}

async function touchCart(principal: CartPrincipal, cart: CartRow): Promise<CartRow> {
  const now = new Date();
  const [updated] = await db
    .update(carts)
    .set({ lastActivityAt: now, expiresAt: new Date(now.getTime() + cartTtlMs(principal)), updatedAt: now })
    .where(and(eq(carts.id, cart.id), eq(carts.status, "ACTIVE"), ownerCondition(principal)))
    .returning();
  return updated ?? cart;
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

async function findMergeSource(principal: CartPrincipal): Promise<CartRow | null> {
  if (!principal.userId || !principal.guestSessionHash) return null;
  const now = new Date();
  const [guest] = await db
    .select()
    .from(carts)
    .where(
      and(
        isNull(carts.userId),
        eq(carts.sessionId, principal.guestSessionHash),
        inArray(carts.status, ["ACTIVE", "ABANDONED"]),
        or(isNull(carts.expiresAt), gt(carts.expiresAt, now)),
      ),
    )
    .orderBy(desc(carts.lastActivityAt))
    .limit(1);
  return guest ?? null;
}

interface MergeCatalogProduct {
  id: string;
  currency: string;
  status: string;
  visibility: string;
  sellerId: string | null;
  sellerStatus: string | null;
}
interface MergeCatalogVariant {
  id: string;
  productId: string;
  active: boolean;
  availability: string;
  stockQuantity: number;
  reservedQuantity: number;
}

/** Merge once, under ordered row locks, so concurrent login callbacks cannot double quantities. */
async function mergeGuestCartInto(principal: CartPrincipal, targetId: string): Promise<CartMergeResult | null> {
  const guest = await findMergeSource(principal);
  if (!guest || guest.id === targetId) return null;
  const result = await withTransaction(async (tx) => {
    const locked = await tx
      .select()
      .from(carts)
      .where(inArray(carts.id, [guest.id, targetId].sort()))
      .orderBy(asc(carts.id))
      .for("update");
    const source = locked.find((row) => row.id === guest.id);
    const target = locked.find((row) => row.id === targetId);
    if (!source || source.userId !== null || source.sessionId !== principal.guestSessionHash) return null;
    if (!target || target.userId !== principal.userId || target.status !== "ACTIVE") {
      throw new ForbiddenError("This cart could not be merged into your account.");
    }
    if (source.status === "MERGED" || !["ACTIVE", "ABANDONED"].includes(source.status)) return null;
    const now = new Date();
    if (source.expiresAt && source.expiresAt <= now) return null;

    const guestLines = await tx.select().from(cartItems).where(eq(cartItems.cartId, source.id)).orderBy(asc(cartItems.createdAt));
    const targetLines = await tx.select().from(cartItems).where(eq(cartItems.cartId, target.id)).orderBy(asc(cartItems.createdAt));
    const targetByVariant = new Map(targetLines.map((line) => [line.variantId, line]));
    const productIds = [...new Set([...guestLines, ...targetLines].map((line) => line.productId))];
    const variantIds = [...new Set([...guestLines, ...targetLines].map((line) => line.variantId))];
    const [productRows, variantRows] = await Promise.all([
      productIds.length
        ? tx
            .select({ id: products.id, currency: products.currency, status: products.status, visibility: products.visibility, sellerId: products.sellerId, sellerStatus: users.status })
            .from(products)
            .leftJoin(users, eq(users.id, products.sellerId))
            .where(inArray(products.id, productIds))
        : Promise.resolve([]),
      variantIds.length
        ? tx
            .select({ id: productVariants.id, productId: productVariants.productId, active: productVariants.isActive, availability: productVariants.availability, stockQuantity: productVariants.stockQuantity, reservedQuantity: productVariants.reservedQuantity })
            .from(productVariants)
            .where(inArray(productVariants.id, variantIds))
            .for("share")
        : Promise.resolve([]),
    ]);
    const productById = new Map<string, MergeCatalogProduct>(productRows.map((row) => [row.id, row]));
    const variantById = new Map<string, MergeCatalogVariant>(variantRows.map((row) => [row.id, row]));
    const liveVariantIds = guestLines
      .filter((line) => {
        const product = productById.get(line.productId);
        const variant = variantById.get(line.variantId);
        return Boolean(
          product &&
            variant?.productId === line.productId &&
            product.status === "ACTIVE" &&
            product.visibility !== "PRIVATE" &&
            (!product.sellerId || product.sellerStatus === "ACTIVE"),
        );
      })
      .map((line) => line.variantId);
    const prices = await quoteVariantPrices(liveVariantIds, {}, tx);
    const mergeWarnings: CartWarning[] = [];
    let mergedLines = 0;
    let combinedLines = 0;

    for (const guestLine of guestLines) {
      const product = productById.get(guestLine.productId);
      const rawVariant = variantById.get(guestLine.variantId);
      const variant = rawVariant?.productId === guestLine.productId ? rawVariant : undefined;
      const existing = targetByVariant.get(guestLine.variantId);
      const baseQuantity = existing?.quantity ?? 0;
      let desired = Math.min(MAX_CART_QUANTITY, baseQuantity + guestLine.quantity);
      if (baseQuantity + guestLine.quantity > MAX_CART_QUANTITY) {
        mergeWarnings.push(warning("QUANTITY_LIMIT", `The combined quantity was capped at ${MAX_CART_QUANTITY}.`, existing?.id ?? guestLine.id, guestLine.productId, { requestedQuantity: baseQuantity + guestLine.quantity }));
      }
      const available = variant
        ? availableQuantity({ stockQuantity: variant.stockQuantity, reservedQuantity: variant.reservedQuantity })
        : 0;
      const orderable = Boolean(
        product &&
          product.status === "ACTIVE" &&
          product.visibility !== "PRIVATE" &&
          (!product.sellerId || product.sellerStatus === "ACTIVE") &&
          variant?.active &&
          (variant.availability === "IN_STOCK" || variant.availability === "LOW_STOCK") &&
          available > 0,
      );
      if (orderable && desired > available) {
        mergeWarnings.push(warning("STOCK_REDUCED", `Only ${available} unit${available === 1 ? " is" : "s are"} available now.`, existing?.id ?? guestLine.id, guestLine.productId, { requestedQuantity: desired, availableQuantity: available }));
        desired = available;
      }
      if (!product || product.status !== "ACTIVE" || product.visibility === "PRIVATE") {
        mergeWarnings.push(warning("PRODUCT_UNAVAILABLE", "This product is no longer available to purchase.", existing?.id ?? guestLine.id, guestLine.productId));
      } else if (!variant) {
        mergeWarnings.push(warning("VARIANT_UNAVAILABLE", "This option is no longer available.", existing?.id ?? guestLine.id, guestLine.productId));
      } else if (!variant.active) {
        mergeWarnings.push(warning("VARIANT_UNAVAILABLE", "This option is no longer available.", existing?.id ?? guestLine.id, guestLine.productId));
      } else if (!orderable) {
        mergeWarnings.push(warning("OUT_OF_STOCK", "This option is currently out of stock.", existing?.id ?? guestLine.id, guestLine.productId, { availableQuantity: available }));
      }
      if (product?.sellerId && product.sellerStatus !== "ACTIVE") {
        mergeWarnings.push(warning("SELLER_UNAVAILABLE", "The seller is not currently able to fulfill this item.", existing?.id ?? guestLine.id, guestLine.productId));
      }
      if (product && (product.currency !== target.currency || guestLine.currency !== target.currency)) {
        mergeWarnings.push(warning("CURRENCY_MISMATCH", "This item uses a different currency and cannot be included in this cart.", existing?.id ?? guestLine.id, guestLine.productId));
      }
      const currentPrice = prices.get(guestLine.variantId)?.finalPaise ?? null;
      const observedPrice = existing?.unitPrice ?? guestLine.unitPrice;
      if (currentPrice !== null && currentPrice !== observedPrice) {
        mergeWarnings.push(warning("PRICE_CHANGED", "The current price differs from the last price saved in this cart.", existing?.id ?? guestLine.id, guestLine.productId, { previousUnitPricePaise: observedPrice, currentUnitPricePaise: currentPrice }));
      }

      if (existing) {
        await tx
          .update(cartItems)
          .set({
            quantity: Math.max(1, desired),
            sellerId: product?.sellerId ?? existing.sellerId,
            version: sql`${cartItems.version} + 1`,
            updatedAt: now,
          })
          .where(eq(cartItems.id, existing.id));
        combinedLines += 1;
      } else {
        const [created] = await tx
          .insert(cartItems)
          .values({
            cartId: target.id,
            productId: guestLine.productId,
            variantId: guestLine.variantId,
            sellerId: product?.sellerId ?? guestLine.sellerId,
            quantity: Math.max(1, desired),
            unitPrice: guestLine.unitPrice,
            currency: guestLine.currency,
            attributionSource: guestLine.attributionSource,
          })
          .returning();
        if (created) targetByVariant.set(guestLine.variantId, created);
        mergedLines += 1;
      }
    }

    const guestSaved = await tx.select().from(savedItems).where(eq(savedItems.cartId, source.id));
    const targetSaved = await tx.select().from(savedItems).where(eq(savedItems.cartId, target.id));
    const targetSavedByVariant = new Map(targetSaved.map((line) => [line.variantId, line]));
    for (const line of guestSaved) {
      const existing = targetSavedByVariant.get(line.variantId);
      if (existing) {
        await tx.update(savedItems).set({ quantity: Math.min(MAX_CART_QUANTITY, Math.max(existing.quantity, line.quantity)), updatedAt: now }).where(eq(savedItems.id, existing.id));
      } else {
        const [created] = await tx
          .insert(savedItems)
          .values({ cartId: target.id, productId: line.productId, variantId: line.variantId, sellerId: line.sellerId, quantity: Math.min(MAX_CART_QUANTITY, line.quantity), unitPrice: line.unitPrice, currency: line.currency })
          .returning();
        if (created) targetSavedByVariant.set(line.variantId, created);
      }
    }

    await tx.delete(cartItems).where(eq(cartItems.cartId, source.id));
    await tx.delete(savedItems).where(eq(savedItems.cartId, source.id));
    // Keep guest retries idempotent after login/merge: move their keys onto the
    // account cart. If a key already exists there, the account-scoped result wins.
    const [sourceKeys, targetKeys] = await Promise.all([
      tx.select({ id: cartMutationKeys.id, key: cartMutationKeys.key }).from(cartMutationKeys).where(eq(cartMutationKeys.cartId, source.id)),
      tx.select({ key: cartMutationKeys.key }).from(cartMutationKeys).where(eq(cartMutationKeys.cartId, target.id)),
    ]);
    const targetKeySet = new Set(targetKeys.map((entry) => entry.key));
    const duplicateKeyIds = sourceKeys.filter((entry) => targetKeySet.has(entry.key)).map((entry) => entry.id);
    const transferableKeyIds = sourceKeys.filter((entry) => !targetKeySet.has(entry.key)).map((entry) => entry.id);
    if (duplicateKeyIds.length) await tx.delete(cartMutationKeys).where(inArray(cartMutationKeys.id, duplicateKeyIds));
    if (transferableKeyIds.length) {
      await tx.update(cartMutationKeys).set({ cartId: target.id }).where(inArray(cartMutationKeys.id, transferableKeyIds));
    }
    await tx
      .update(carts)
      .set({ status: "MERGED", sessionId: null, version: sql`${carts.version} + 1`, lastActivityAt: now, updatedAt: now })
      .where(eq(carts.id, source.id));
    await tx
      .update(carts)
      .set({ version: sql`${carts.version} + 1`, lastActivityAt: now, expiresAt: new Date(now.getTime() + cartPolicy().userTtlMs), updatedAt: now })
      .where(eq(carts.id, target.id));

    return {
      merged: true,
      mergedLines,
      combinedLines,
      warnings: mergeWarnings,
      requiresCustomerAttention: mergeWarnings.length > 0,
    } satisfies CartMergeResult;
  });

  if (result?.merged) {
    await recordCartEvent({
      ...analyticsActor(principal),
      eventType: "CART_MERGED",
      warningCodes: result.warnings.map((entry) => entry.code),
      quantity: result.mergedLines + result.combinedLines,
    });
  }
  return result;
}

async function prepareCartForRead(principal: CartPrincipal): Promise<{ cart: CartRow | null; mergeResult: CartMergeResult | null }> {
  if (!principal.userId && !principal.guestSessionHash) return { cart: null, mergeResult: null };
  if (principal.userId) {
    const ensured = await ensureCart(principal, true);
    if (!ensured.cart) return { cart: null, mergeResult: null };
    const mergeResult = await mergeGuestCartInto(principal, ensured.cart.id);
    const latest = await activeCart(principal);
    return { cart: latest ?? ensured.cart, mergeResult };
  }
  const ensured = await ensureCart(principal, false);
  return { cart: ensured.cart, mergeResult: null };
}

async function prepareCartForMutation(principal: CartPrincipal): Promise<{ cart: CartRow; mergeResult: CartMergeResult | null }> {
  assertPrincipal(principal);
  const ensured = await ensureCart(principal, true);
  if (!ensured.cart) throw new ConflictError("Your cart could not be created. Please retry.");
  if (principal.userId) {
    const mergeResult = await mergeGuestCartInto(principal, ensured.cart.id);
    const latest = await activeCart(principal);
    return { cart: latest ?? ensured.cart, mergeResult };
  }
  return { cart: ensured.cart, mergeResult: null };
}

function emptyCart(mergeResult: CartMergeResult | null): CartDTO {
  return {
    id: null,
    status: "ACTIVE",
    currency: siteConfig.commerce.currency,
    version: 0,
    createdAt: null,
    lastActivityAt: null,
    expiresAt: null,
    items: [],
    itemCount: 0,
    lineCount: 0,
    totals: {
      currency: siteConfig.commerce.currency,
      listSubtotalPaise: 0,
      productDiscountPaise: 0,
      cartDiscountPaise: 0,
      subtotalPaise: 0,
      estimatedTaxPaise: 0,
      deliveryEstimatePaise: null,
      totalPaise: 0,
    },
    warnings: [],
    readyForCheckout: false,
    mergeResult,
  };
}

export async function getCartSnapshot(
  principal: CartPrincipal,
  options: { includePromotions?: boolean } = {},
): Promise<CartDTO> {
  const state = await prepareCartForRead(principal);
  if (!state.cart) return emptyCart(state.mergeResult);
  const touched = await touchCart(principal, state.cart);
  const reconciled = await reconcileCartItems(touched.id, touched.currency);
  const snapshot: CartDTO = {
    id: touched.id,
    status: "ACTIVE",
    currency: touched.currency,
    version: touched.version,
    createdAt: touched.createdAt.toISOString(),
    lastActivityAt: touched.lastActivityAt.toISOString(),
    expiresAt: touched.expiresAt?.toISOString() ?? null,
    items: reconciled.items,
    itemCount: reconciled.items.reduce((sum, item) => sum + item.quantity, 0),
    lineCount: reconciled.items.length,
    totals: reconciled.totals,
    warnings: reconciled.warnings,
    readyForCheckout: reconciled.readyForCheckout,
    mergeResult: state.mergeResult,
  };
  if (options.includePromotions === false || snapshot.items.length === 0) return snapshot;
  return (await applyCartPromotions(snapshot, { userId: principal.userId })).cart;
}

export async function getSavedItemSnapshot(principal: CartPrincipal): Promise<{ items: SavedItemDTO[]; warnings: CartWarning[] }> {
  const snapshot = await getCartSnapshot(principal);
  if (!snapshot.id) return { items: [], warnings: [] };
  return reconcileSavedItems(snapshot.id, snapshot.currency);
}

interface LiveCandidate {
  productId: string;
  variantId: string;
  sellerId: string | null;
  currency: string;
  sellerStatus: string | null;
  name: string;
  availableQuantity: number;
  unitPricePaise: number;
}

async function requireLiveCandidate(
  client: DbClient,
  productId: string,
  variantId: string,
  cartCurrency: string,
  requestedQuantity: number,
): Promise<LiveCandidate> {
  const [row] = await client
    .select({
      productId: products.id,
      productStatus: products.status,
      visibility: products.visibility,
      currency: products.currency,
      name: products.name,
      sellerId: products.sellerId,
      sellerStatus: users.status,
      variantId: productVariants.id,
      variantActive: productVariants.isActive,
      availability: productVariants.availability,
      stockQuantity: productVariants.stockQuantity,
      reservedQuantity: productVariants.reservedQuantity,
    })
    .from(products)
    .innerJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.id, variantId)))
    .leftJoin(users, eq(users.id, products.sellerId))
    .where(eq(products.id, productId))
    .limit(1)
    // Hold the inventory/variant snapshot until the cart transaction commits;
    // an inventory writer cannot change availability midway through validation.
    .for("share", { of: productVariants });
  if (!row) throw new NotFoundError("That product option could not be found.");
  if (row.productStatus !== "ACTIVE" || row.visibility === "PRIVATE") {
    throw new ConflictError("That product is no longer available.", "PRODUCT_UNAVAILABLE");
  }
  if (row.sellerId && row.sellerStatus !== "ACTIVE") {
    throw new ConflictError("This seller is not currently able to fulfill the item.", "SELLER_UNAVAILABLE");
  }
  if (!currenciesMatch(cartCurrency, row.currency)) {
    throw new ConflictError("This product uses a different currency from your cart.", "CURRENCY_MISMATCH");
  }
  if (!row.variantActive) throw new ConflictError("That product option is no longer available.", "VARIANT_UNAVAILABLE");
  const available = availableQuantity({ stockQuantity: row.stockQuantity, reservedQuantity: row.reservedQuantity });
  if (row.availability !== "IN_STOCK" && row.availability !== "LOW_STOCK") {
    throw new InsufficientStockError("That product option is currently unavailable.");
  }
  if (available <= 0) throw new InsufficientStockError("That product option is out of stock.");
  if (requestedQuantity > available) {
    throw new InsufficientStockError(`Only ${available} unit${available === 1 ? " is" : "s are"} available.`);
  }
  const price = (await quoteVariantPrices([variantId], {}, client)).get(variantId);
  if (!price || price.finalPaise < 0) throw new ConflictError("The current price for this item could not be confirmed.", "PRICE_UNAVAILABLE");
  return {
    productId,
    variantId,
    sellerId: row.sellerId,
    sellerStatus: row.sellerStatus,
    currency: row.currency,
    name: row.name,
    availableQuantity: available,
    unitPricePaise: price.finalPaise,
  };
}

function payloadDigest(operation: string, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, payload })).digest("hex");
}

async function mutateCart(
  principal: CartPrincipal,
  options: CartMutationOptions,
  operation: string,
  payload: unknown,
  work: (tx: DbTx, cart: CartRow) => Promise<Record<string, unknown>>,
): Promise<CartMutationResult> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(options.idempotencyKey)) throw new ValidationError("A valid Idempotency-Key is required.");
  const { cart } = await prepareCartForMutation(principal);
  const expectedHash = payloadDigest(operation, payload);
  const now = new Date();
  return withTransaction(async (tx) => {
    const [lockedCart] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.id, cart.id), eq(carts.status, "ACTIVE"), ownerCondition(principal)))
      .for("update")
      .limit(1);
    if (!lockedCart) throw new ForbiddenError("This cart could not be changed.");

    const [existingKey] = await tx
      .select()
      .from(cartMutationKeys)
      .where(and(eq(cartMutationKeys.cartId, lockedCart.id), eq(cartMutationKeys.key, options.idempotencyKey)))
      .for("update")
      .limit(1);
    if (existingKey && existingKey.expiresAt > now) {
      if (existingKey.operation !== operation || existingKey.payloadHash !== expectedHash) {
        throw new ConflictError("This idempotency key was already used for a different cart change.", "IDEMPOTENCY_KEY_REUSED");
      }
      return { ...(existingKey.response as unknown as CartMutationResult), replayed: true };
    }
    if (existingKey) await tx.delete(cartMutationKeys).where(eq(cartMutationKeys.id, existingKey.id));

    if (options.expectedCartVersion !== undefined && options.expectedCartVersion !== lockedCart.version) {
      throw new ConflictError("Your cart changed in another request. Refresh it and try again.", "CART_VERSION_CONFLICT");
    }

    const result = await work(tx, lockedCart);
    const policy = cartPolicy();
    const [updatedCart] = await tx
      .update(carts)
      .set({
        version: sql`${carts.version} + 1`,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + (principal.userId ? policy.userTtlMs : policy.guestTtlMs)),
        updatedAt: now,
      })
      .where(eq(carts.id, lockedCart.id))
      .returning({ version: carts.version });
    if (!updatedCart) throw new ConflictError("Your cart changed in another request. Refresh it and try again.");
    const response = { ...result, version: updatedCart.version } as CartMutationResult;
    await tx.insert(cartMutationKeys).values({
      cartId: lockedCart.id,
      key: options.idempotencyKey,
      operation,
      payloadHash: expectedHash,
      response: response as unknown as Record<string, unknown>,
      expiresAt: new Date(now.getTime() + policy.idempotencyTtlMs),
    });
    return { ...response, replayed: false };
  });
}

function eventRecommendation(recommendation?: RecommendationAttribution | null) {
  return recommendation ?? null;
}

function mutationWarningForPrice(itemId: string, productId: string, observed: number, current: number): CartWarning | null {
  return observed === current
    ? null
    : warning("PRICE_CHANGED", "The current price differs from the last price saved in this cart.", itemId, productId, {
        previousUnitPricePaise: observed,
        currentUnitPricePaise: current,
      });
}

export async function addCartItem(
  principal: CartPrincipal,
  input: { productId: string; variantId: string; quantity: number; source: CartAttributionSource; recommendation?: RecommendationAttribution | null },
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_CART_QUANTITY) {
    throw new ValidationError(`Quantity must be between 1 and ${MAX_CART_QUANTITY}.`);
  }
  const result = await mutateCart(principal, options, "ADD_ITEM", input, async (tx, cart) => {
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, input.variantId)))
      .for("update")
      .limit(1);
    if (existing && existing.productId !== input.productId) throw new ConflictError("This product option no longer matches the selected product.");
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    if (quantity > MAX_CART_QUANTITY) throw new ValidationError(`A maximum of ${MAX_CART_QUANTITY} units is allowed per item.`);
    const candidate = await requireLiveCandidate(tx, input.productId, input.variantId, cart.currency, quantity);
    const now = new Date();
    let item: CartItemRow;
    if (existing) {
      [item] = await tx
        .update(cartItems)
        .set({ quantity, sellerId: candidate.sellerId, attributionSource: input.source, version: sql`${cartItems.version} + 1`, updatedAt: now })
        .where(eq(cartItems.id, existing.id))
        .returning();
    } else {
      [item] = await tx
        .insert(cartItems)
        .values({
          cartId: cart.id,
          productId: input.productId,
          variantId: input.variantId,
          sellerId: candidate.sellerId,
          quantity,
          unitPrice: candidate.unitPricePaise,
          currency: cart.currency,
          attributionSource: input.source,
        })
        .returning();
    }
    if (!item) throw new ConflictError("The item could not be added. Please retry.");
    const observed = existing?.unitPrice ?? candidate.unitPricePaise;
    const priceWarning = mutationWarningForPrice(item.id, input.productId, observed, candidate.unitPricePaise);
    return {
      itemId: item.id,
      productId: input.productId,
      variantId: input.variantId,
      quantity: item.quantity,
      priceChanged: Boolean(priceWarning),
      previousObservedUnitPricePaise: existing?.unitPrice ?? undefined,
      currentUnitPricePaise: candidate.unitPricePaise,
      warnings: priceWarning ? [priceWarning] : [],
    };
  });
  if (!result.replayed) {
    const principalActor = analyticsActor(principal);
    await recordCartEvent({
      ...principalActor,
      eventType: "CART_ITEM_ADDED",
      productId: input.productId,
      variantId: input.variantId,
      source: input.source,
      quantity: result.quantity,
      recommendation: eventRecommendation(input.recommendation),
    });
  }
  return result;
}

export async function updateCartItem(
  principal: CartPrincipal,
  input: { itemId: string; quantity: number },
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_CART_QUANTITY) {
    throw new ValidationError(`Quantity must be between 1 and ${MAX_CART_QUANTITY}.`);
  }
  const result = await mutateCart(principal, options, "UPDATE_ITEM", input, async (tx, cart) => {
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.id, input.itemId), eq(cartItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!existing) throw new NotFoundError("That item is no longer in your cart.");
    const candidate = await requireLiveCandidate(tx, existing.productId, existing.variantId, cart.currency, input.quantity);
    const [updated] = await tx
      .update(cartItems)
      .set({ quantity: input.quantity, sellerId: candidate.sellerId, version: sql`${cartItems.version} + 1`, updatedAt: new Date() })
      .where(eq(cartItems.id, existing.id))
      .returning();
    if (!updated) throw new ConflictError("That item changed in another request.");
    const priceWarning = mutationWarningForPrice(existing.id, existing.productId, existing.unitPrice, candidate.unitPricePaise);
    return {
      itemId: updated.id,
      productId: existing.productId,
      variantId: existing.variantId,
      quantity: updated.quantity,
      priceChanged: Boolean(priceWarning),
      previousObservedUnitPricePaise: existing.unitPrice,
      currentUnitPricePaise: candidate.unitPricePaise,
      warnings: priceWarning ? [priceWarning] : [],
    };
  });
  if (!result.replayed) {
    await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_UPDATED", productId: result.productId, variantId: result.variantId, quantity: result.quantity });
  }
  return result;
}

export async function acceptCurrentCartPrice(
  principal: CartPrincipal,
  itemId: string,
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  const result = await mutateCart(principal, options, "ACCEPT_CURRENT_PRICE", { itemId }, async (tx, cart) => {
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!existing) throw new NotFoundError("That item is no longer in your cart.");
    const candidate = await requireLiveCandidate(tx, existing.productId, existing.variantId, cart.currency, existing.quantity);
    const previousPrice = existing.unitPrice;
    const [updated] = await tx
      .update(cartItems)
      .set({ unitPrice: candidate.unitPricePaise, sellerId: candidate.sellerId, version: sql`${cartItems.version} + 1`, updatedAt: new Date() })
      .where(eq(cartItems.id, existing.id))
      .returning();
    if (!updated) throw new ConflictError("That item changed in another request.");
    return {
      itemId: updated.id,
      productId: existing.productId,
      variantId: existing.variantId,
      quantity: updated.quantity,
      priceChanged: false,
      previousObservedUnitPricePaise: previousPrice,
      currentUnitPricePaise: candidate.unitPricePaise,
      warnings: [],
    };
  });
  if (!result.replayed) await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_UPDATED", productId: result.productId, variantId: result.variantId, source: "PRODUCT_PAGE", quantity: result.quantity });
  return result;
}

export async function removeCartItem(
  principal: CartPrincipal,
  itemId: string,
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  const result = await mutateCart(principal, options, "REMOVE_ITEM", { itemId }, async (tx, cart) => {
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!existing) throw new NotFoundError("That item is no longer in your cart.");
    await tx.delete(cartItems).where(eq(cartItems.id, existing.id));
    return { itemId: existing.id, productId: existing.productId, variantId: existing.variantId, quantity: existing.quantity };
  });
  if (!result.replayed) await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_REMOVED", productId: result.productId, variantId: result.variantId, quantity: result.quantity });
  return result;
}

export async function saveCartItemForLater(
  principal: CartPrincipal,
  itemId: string,
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  const result = await mutateCart(principal, options, "SAVE_FOR_LATER", { itemId }, async (tx, cart) => {
    const [item] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!item) throw new NotFoundError("That item is no longer in your cart.");
    const now = new Date();
    const [saved] = await tx
      .insert(savedItems)
      .values({ cartId: cart.id, productId: item.productId, variantId: item.variantId, sellerId: item.sellerId, quantity: item.quantity, unitPrice: item.unitPrice, currency: item.currency })
      .onConflictDoUpdate({
        target: [savedItems.cartId, savedItems.variantId],
        set: {
          quantity: sql`least(${MAX_CART_QUANTITY}, ${savedItems.quantity} + ${item.quantity})`,
          sellerId: item.sellerId,
          unitPrice: item.unitPrice,
          currency: item.currency,
          updatedAt: now,
        },
      })
      .returning();
    await tx.delete(cartItems).where(eq(cartItems.id, item.id));
    return { itemId: saved?.id, productId: item.productId, variantId: item.variantId, quantity: saved?.quantity ?? item.quantity };
  });
  if (!result.replayed) await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_SAVED", productId: result.productId, variantId: result.variantId, quantity: result.quantity });
  return result;
}

export async function restoreSavedItem(
  principal: CartPrincipal,
  savedItemId: string,
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  const result = await mutateCart(principal, options, "RESTORE_SAVED_ITEM", { savedItemId }, async (tx, cart) => {
    const [saved] = await tx
      .select()
      .from(savedItems)
      .where(and(eq(savedItems.id, savedItemId), eq(savedItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!saved) throw new NotFoundError("That saved item could not be found.");
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, saved.variantId)))
      .for("update")
      .limit(1);
    const quantity = (existing?.quantity ?? 0) + saved.quantity;
    if (quantity > MAX_CART_QUANTITY) throw new ValidationError(`A maximum of ${MAX_CART_QUANTITY} units is allowed per item.`);
    const candidate = await requireLiveCandidate(tx, saved.productId, saved.variantId, cart.currency, quantity);
    const now = new Date();
    let item: CartItemRow;
    if (existing) {
      [item] = await tx
        .update(cartItems)
        .set({ quantity, sellerId: candidate.sellerId, attributionSource: "SAVED_FOR_LATER", version: sql`${cartItems.version} + 1`, updatedAt: now })
        .where(eq(cartItems.id, existing.id))
        .returning();
    } else {
      [item] = await tx
        .insert(cartItems)
        .values({ cartId: cart.id, productId: saved.productId, variantId: saved.variantId, sellerId: candidate.sellerId, quantity: saved.quantity, unitPrice: saved.unitPrice, currency: saved.currency, attributionSource: "SAVED_FOR_LATER" })
        .returning();
    }
    await tx.delete(savedItems).where(eq(savedItems.id, saved.id));
    if (!item) throw new ConflictError("That saved item could not be restored.");
    const observed = existing?.unitPrice ?? saved.unitPrice;
    const priceWarning = mutationWarningForPrice(item.id, saved.productId, observed, candidate.unitPricePaise);
    return {
      itemId: item.id,
      productId: saved.productId,
      variantId: saved.variantId,
      quantity: item.quantity,
      priceChanged: Boolean(priceWarning),
      previousObservedUnitPricePaise: observed,
      currentUnitPricePaise: candidate.unitPricePaise,
      warnings: priceWarning ? [priceWarning] : [],
    };
  });
  if (!result.replayed) await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_RESTORED", productId: result.productId, variantId: result.variantId, quantity: result.quantity, source: "SAVED_FOR_LATER" });
  return result;
}

export async function removeSavedItem(
  principal: CartPrincipal,
  savedItemId: string,
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  const result = await mutateCart(principal, options, "REMOVE_SAVED_ITEM", { savedItemId }, async (tx, cart) => {
    const [saved] = await tx
      .select({ id: savedItems.id, productId: savedItems.productId, variantId: savedItems.variantId, quantity: savedItems.quantity })
      .from(savedItems)
      .where(and(eq(savedItems.id, savedItemId), eq(savedItems.cartId, cart.id)))
      .for("update")
      .limit(1);
    if (!saved) throw new NotFoundError("That saved item could not be found.");
    await tx.delete(savedItems).where(eq(savedItems.id, saved.id));
    return { itemId: saved.id, quantity: saved.quantity };
  });
  if (!result.replayed) await recordCartEvent({ ...analyticsActor(principal), eventType: "CART_ITEM_REMOVED", productId: result.productId, variantId: result.variantId, source: "SAVED_FOR_LATER", quantity: result.quantity });
  return result;
}

export async function moveWishlistItemToCart(
  principal: CartPrincipal,
  input: { wishlistItemId: string; variantId: string; quantity: number; recommendation?: RecommendationAttribution | null },
  options: CartMutationOptions,
): Promise<CartMutationResult> {
  if (!principal.userId) throw new UnauthorizedError("Sign in to move a wishlist item to your cart.");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_CART_QUANTITY) {
    throw new ValidationError(`Quantity must be between 1 and ${MAX_CART_QUANTITY}.`);
  }
  const result = await mutateCart(principal, options, "WISHLIST_TO_CART", input, async (tx, cart) => {
    const [wishItem] = await tx
      .select({ id: wishlistItems.id, productId: wishlistItems.productId })
      .from(wishlistItems)
      .innerJoin(wishlists, eq(wishlists.id, wishlistItems.wishlistId))
      .where(and(eq(wishlistItems.id, input.wishlistItemId), eq(wishlists.userId, principal.userId!)))
      .for("update")
      .limit(1);
    if (!wishItem) throw new NotFoundError("That wishlist item could not be found.");
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, input.variantId)))
      .for("update")
      .limit(1);
    if (existing && existing.productId !== wishItem.productId) throw new ConflictError("The selected option does not belong to this wishlist product.");
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    if (quantity > MAX_CART_QUANTITY) throw new ValidationError(`A maximum of ${MAX_CART_QUANTITY} units is allowed per item.`);
    const candidate = await requireLiveCandidate(tx, wishItem.productId, input.variantId, cart.currency, quantity);
    const now = new Date();
    let item: CartItemRow;
    if (existing) {
      [item] = await tx
        .update(cartItems)
        .set({ quantity, sellerId: candidate.sellerId, attributionSource: "WISHLIST", version: sql`${cartItems.version} + 1`, updatedAt: now })
        .where(eq(cartItems.id, existing.id))
        .returning();
    } else {
      [item] = await tx
        .insert(cartItems)
        .values({ cartId: cart.id, productId: wishItem.productId, variantId: input.variantId, sellerId: candidate.sellerId, quantity: input.quantity, unitPrice: candidate.unitPricePaise, currency: cart.currency, attributionSource: "WISHLIST" })
        .returning();
    }
    await tx.delete(wishlistItems).where(eq(wishlistItems.id, wishItem.id));
    if (!item) throw new ConflictError("The wishlist item could not be moved.");
    const observed = existing?.unitPrice ?? candidate.unitPricePaise;
    const priceWarning = mutationWarningForPrice(item.id, wishItem.productId, observed, candidate.unitPricePaise);
    return {
      itemId: item.id,
      productId: wishItem.productId,
      variantId: input.variantId,
      quantity: item.quantity,
      priceChanged: Boolean(priceWarning),
      previousObservedUnitPricePaise: existing?.unitPrice ?? undefined,
      currentUnitPricePaise: candidate.unitPricePaise,
      warnings: priceWarning ? [priceWarning] : [],
    };
  });
  if (!result.replayed) {
    await recordCartEvent({
      ...analyticsActor(principal),
      eventType: "WISHLIST_TO_CART",
      productId: result.productId,
      variantId: input.variantId,
      source: "WISHLIST",
      quantity: result.quantity,
      recommendation: eventRecommendation(input.recommendation),
    });
  }
  return result;
}

/** Explicit login hook. GET /api/cart also calls this safely. */
export async function mergeGuestCart(principal: CartPrincipal): Promise<CartMergeResult> {
  if (!principal.userId) throw new UnauthorizedError("Sign in to merge a guest cart.");
  const ensured = await ensureCart(principal, true);
  if (!ensured.cart) throw new ConflictError("Your cart could not be loaded.");
  return (await mergeGuestCartInto(principal, ensured.cart.id)) ?? {
    merged: false,
    mergedLines: 0,
    combinedLines: 0,
    warnings: [],
    requiresCustomerAttention: false,
  };
}

/** Safe maintenance operation; no user-visible promotion or marketing side-effect. */
export async function markAbandonedCarts(now = new Date(), limit = 500): Promise<number> {
  const threshold = new Date(now.getTime() - cartPolicy().abandonmentMs);
  const stale = await db
    .select({ id: carts.id, userId: carts.userId, sessionId: carts.sessionId })
    .from(carts)
    .where(and(eq(carts.status, "ACTIVE"), lt(carts.lastActivityAt, threshold)))
    .orderBy(asc(carts.lastActivityAt))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 5000));
  if (stale.length === 0) return 0;
  const ids = stale.map((row) => row.id);
  const changed = await db
    .update(carts)
    .set({ status: "ABANDONED", updatedAt: now })
    .where(and(
      inArray(carts.id, ids),
      eq(carts.status, "ACTIVE"),
      lt(carts.lastActivityAt, threshold),
      or(isNull(carts.expiresAt), gt(carts.expiresAt, now)),
    ))
    .returning({ id: carts.id, userId: carts.userId, sessionId: carts.sessionId });
  await Promise.all(
    changed.map((row) =>
      recordCartEvent({
        userId: row.userId,
        sessionHash: row.sessionId,
        eventType: "CART_ABANDONED",
      }),
    ),
  );
  return changed.length;
}


/** Expire carts whose configured sliding retention window has elapsed. */
export async function markExpiredCarts(now = new Date(), limit = 1000): Promise<number> {
  const stale = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(
      inArray(carts.status, ["ACTIVE", "ABANDONED"]),
      lte(carts.expiresAt, now),
    ))
    .orderBy(asc(carts.expiresAt))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 5000));
  if (stale.length === 0) return 0;
  const changed = await db
    .update(carts)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(inArray(carts.id, stale.map((row) => row.id)), inArray(carts.status, ["ACTIVE", "ABANDONED"]), lte(carts.expiresAt, now)))
    .returning({ id: carts.id, userId: carts.userId, sessionId: carts.sessionId });
  await Promise.all(changed.map((row) => recordCartEvent({ userId: row.userId, sessionHash: row.sessionId, eventType: "CART_EXPIRED" })));
  return changed.length;
}

/** Remove only data past the explicit cart-retention deadline; FK cascades clear lines and idempotency records. */
export async function purgeExpiredCarts(now = new Date(), limit = 1000): Promise<number> {
  const expired = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.status, "EXPIRED"), lte(carts.expiresAt, now)))
    .orderBy(asc(carts.expiresAt))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 5000));
  if (expired.length === 0) return 0;
  const removed = await db.delete(carts).where(inArray(carts.id, expired.map((row) => row.id))).returning({ id: carts.id });
  return removed.length;
}

/** Idempotency payloads contain no customer data; expire them independently in bounded batches. */
export async function purgeExpiredCartMutationKeys(now = new Date(), limit = 2000): Promise<number> {
  const expired = await db
    .select({ id: cartMutationKeys.id })
    .from(cartMutationKeys)
    .where(lte(cartMutationKeys.expiresAt, now))
    .orderBy(asc(cartMutationKeys.expiresAt))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 10_000));
  if (expired.length === 0) return 0;
  const removed = await db.delete(cartMutationKeys).where(inArray(cartMutationKeys.id, expired.map((row) => row.id))).returning({ id: cartMutationKeys.id });
  return removed.length;
}
