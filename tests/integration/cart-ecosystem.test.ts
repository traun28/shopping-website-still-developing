// @vitest-environment node
/** Part 14 — cart ownership, pricing, retries, saved items, wishlist move and merge. */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const prefix = `cart${randomBytes(5).toString("hex")}`;
const guestHash = (seed: string) => createHash("sha256").update(`${prefix}:${seed}`).digest("hex");

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let eq: typeof import("drizzle-orm").eq;
let and: typeof import("drizzle-orm").and;
let cartService: typeof import("@/services/cart/cart.service");
let wishlistService: typeof import("@/services/wishlist.service");
let customerId: string;
let productId: string;
let variantId: string;
let secondProductId: string;
let secondVariantId: string;
const cartIds = new Set<string>();

const guest = { userId: null, guestSessionHash: guestHash("guest-1"), analyticsSessionHash: guestHash("analytics-1") };
const account = () => ({ userId: customerId, guestSessionHash: null, analyticsSessionHash: guestHash("account-analytics") });

async function createProduct(key: string, stock = 3, reserved = 1) {
  const [product] = await db
    .insert(schema.products)
    .values({
      name: `${prefix} ${key}`,
      slug: `${prefix}-${key}`,
      productType: "OTHER",
      status: "ACTIVE",
      visibility: "PUBLIC",
      basePrice: 10_000,
      currency: "INR",
      publishedAt: new Date(),
    })
    .returning({ id: schema.products.id });
  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      productId: product!.id,
      sku: `${prefix}-${key}`.toUpperCase(),
      name: "Standard",
      price: 10_000,
      stockQuantity: stock,
      reservedQuantity: reserved,
      availability: stock - reserved > 0 ? "IN_STOCK" : "OUT_OF_STOCK",
      isActive: true,
    })
    .returning({ id: schema.productVariants.id });
  return { productId: product!.id, variantId: variant!.id };
}

describe.skipIf(!enabled)("persistent cart ecosystem (PostgreSQL)", () => {
  beforeAll(async () => {
    const [dbModule, schemaModule, drizzle, cart, wishlist] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
      import("@/services/cart/cart.service"),
      import("@/services/wishlist.service"),
    ]);
    db = dbModule.db;
    schema = schemaModule;
    eq = drizzle.eq;
    and = drizzle.and;
    cartService = cart;
    wishlistService = wishlist;
    const [user] = await db
      .insert(schema.users)
      .values({ name: `${prefix} Customer`, email: `${prefix}@example.test`, role: "CUSTOMER" })
      .returning({ id: schema.users.id });
    customerId = user!.id;
    ({ productId, variantId } = await createProduct("shirt"));
    ({ productId: secondProductId, variantId: secondVariantId } = await createProduct("mug", 5, 0));
  });

  afterAll(async () => {
    if (!db || !schema) return;
    const { carts, products, users, userInterestSignals, analyticsEvents, wishlists } = schema;
    if (cartIds.size) await db.delete(carts).where((await import("drizzle-orm")).inArray(carts.id, [...cartIds])).catch(() => undefined);
    await db.delete(wishlists).where(eq(wishlists.userId, customerId)).catch(() => undefined);
    await db.delete(products).where((await import("drizzle-orm")).inArray(products.id, [productId, secondProductId])).catch(() => undefined);
    await db.delete(userInterestSignals).where(eq(userInterestSignals.userId, customerId)).catch(() => undefined);
    await db.delete(analyticsEvents).where(eq(analyticsEvents.userId, customerId)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, customerId)).catch(() => undefined);
  });

  it("validates live stock, persists server quotes, and replays an idempotent add", async () => {
    const first = await cartService.addCartItem(guest, {
      productId,
      variantId,
      quantity: 1,
      source: "PRODUCT_PAGE",
    }, { idempotencyKey: `${prefix}-add-001` });
    expect(first.replayed).toBe(false);
    expect(first.quantity).toBe(1);
    expect(first.currentUnitPricePaise).toBe(10_000);

    const cart = await cartService.getCartSnapshot(guest);
    expect(cart.id).toBeTruthy();
    cartIds.add(cart.id!);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.unitPricePaise).toBe(10_000);
    expect(cart.totals.subtotalPaise).toBe(10_000);

    const replay = await cartService.addCartItem(guest, {
      productId,
      variantId,
      quantity: 1,
      source: "PRODUCT_PAGE",
    }, { idempotencyKey: `${prefix}-add-001` });
    expect(replay.replayed).toBe(true);
    expect((await cartService.getCartSnapshot(guest)).itemCount).toBe(1);

    await expect(cartService.addCartItem(guest, {
      productId,
      variantId,
      quantity: 2,
      source: "PRODUCT_PAGE",
    }, { idempotencyKey: `${prefix}-add-001` })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("serializes cart versions and refuses quantity above live available inventory", async () => {
    const snapshot = await cartService.getCartSnapshot(guest);
    const line = snapshot.items[0]!;
    const updated = await cartService.updateCartItem(guest, { itemId: line.id, quantity: 2 }, {
      idempotencyKey: `${prefix}-update-01`,
      expectedCartVersion: snapshot.version,
    });
    expect(updated.version).toBe(snapshot.version + 1);
    expect(updated.quantity).toBe(2);

    await expect(cartService.updateCartItem(guest, { itemId: line.id, quantity: 3 }, {
      idempotencyKey: `${prefix}-update-02`,
      expectedCartVersion: updated.version,
    })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    await expect(cartService.updateCartItem(guest, { itemId: line.id, quantity: 1 }, {
      idempotencyKey: `${prefix}-update-03`,
      expectedCartVersion: snapshot.version,
    })).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
  });

  it("surfaces live price changes and requires explicit acceptance", async () => {
    const snapshot = await cartService.getCartSnapshot(guest);
    await db.update(schema.productVariants).set({ price: 12_500 }).where(eq(schema.productVariants.id, variantId));
    const repriced = await cartService.getCartSnapshot(guest);
    expect(repriced.items[0]?.warnings.map((entry) => entry.code)).toContain("PRICE_CHANGED");
    expect(repriced.items[0]?.unitPricePaise).toBe(12_500);
    expect(repriced.totals.subtotalPaise).toBe(25_000);

    const accepted = await cartService.acceptCurrentCartPrice(guest, snapshot.items[0]!.id, {
      idempotencyKey: `${prefix}-price-accept`,
      expectedCartVersion: repriced.version,
    });
    expect(accepted.currentUnitPricePaise).toBe(12_500);
    expect((await cartService.getCartSnapshot(guest)).warnings).toHaveLength(0);
  });

  it("keeps Save for Later distinct, restores with live validation, and removes lines", async () => {
    const snapshot = await cartService.getCartSnapshot(guest);
    const line = snapshot.items[0]!;
    const saved = await cartService.saveCartItemForLater(guest, line.id, {
      idempotencyKey: `${prefix}-save-later`,
      expectedCartVersion: snapshot.version,
    });
    expect(saved.itemId).toBeTruthy();
    let empty = await cartService.getCartSnapshot(guest);
    expect(empty.items).toHaveLength(0);
    cartIds.add(empty.id!);
    const savedSnapshot = await cartService.getSavedItemSnapshot(guest);
    expect(savedSnapshot.items).toHaveLength(1);
    expect(savedSnapshot.items[0]?.id).toBe(saved.itemId);

    const restored = await cartService.restoreSavedItem(guest, saved.itemId!, {
      idempotencyKey: `${prefix}-restore-later`,
      expectedCartVersion: empty.version,
    });
    expect(restored.quantity).toBe(2);
    const cart = await cartService.getCartSnapshot(guest);
    expect(cart.items).toHaveLength(1);
    expect((await cartService.getSavedItemSnapshot(guest)).items).toHaveLength(0);

    const removed = await cartService.removeCartItem(guest, cart.items[0]!.id, {
      idempotencyKey: `${prefix}-remove-line`,
      expectedCartVersion: cart.version,
    });
    expect(removed.itemId).toBe(cart.items[0]?.id);
    expect((await cartService.getCartSnapshot(guest)).items).toHaveLength(0);
  });

  it("merges a guest cart into the signed-in cart once and preserves wishlist identity", async () => {
    const accountPrincipal = { ...account(), guestSessionHash: guest.guestSessionHash };
    const guestLine = await cartService.addCartItem(guest, {
      productId: secondProductId,
      variantId: secondVariantId,
      quantity: 2,
      source: "PRODUCT_CARD",
    }, { idempotencyKey: `${prefix}-merge-add` });
    expect(guestLine.itemId).toBeTruthy();
    const guestSnapshot = await cartService.getCartSnapshot(guest);
    cartIds.add(guestSnapshot.id!);

    const accountBefore = await cartService.getCartSnapshot(account());
    if (accountBefore.id) cartIds.add(accountBefore.id);
    const merged = await cartService.getCartSnapshot(accountPrincipal);
    expect(merged.mergeResult?.merged).toBe(true);
    expect(merged.items.some((item) => item.variantId === secondVariantId && item.quantity === 2)).toBe(true);
    const postMergeRetry = await cartService.addCartItem(accountPrincipal, {
      productId: secondProductId,
      variantId: secondVariantId,
      quantity: 2,
      source: "PRODUCT_CARD",
    }, { idempotencyKey: `${prefix}-merge-add` });
    expect(postMergeRetry.replayed).toBe(true);
    expect((await cartService.getCartSnapshot(account())).items.find((item) => item.variantId === secondVariantId)?.quantity).toBe(2);
    expect((await cartService.mergeGuestCart(accountPrincipal)).merged).toBe(false);

    const [added] = await Promise.all([
      wishlistService.addToWishlist(customerId, secondProductId),
    ]);
    expect(added).toBe(true);
    const wishlist = await wishlistService.listWishlist(customerId);
    expect(wishlist[0]?.productId).toBe(secondProductId);
    expect(wishlist[0]?.variants.some((variant) => variant.id === secondVariantId)).toBe(true);

    const wishlistCart = await cartService.getCartSnapshot(account());
    const moved = await cartService.moveWishlistItemToCart(account(), {
      wishlistItemId: wishlist[0]!.itemId,
      variantId: secondVariantId,
      quantity: 1,
    }, {
      idempotencyKey: `${prefix}-wishlist-move`,
      expectedCartVersion: wishlistCart.version,
    });
    expect(moved.quantity).toBe(3);
    expect((await wishlistService.listWishlist(customerId))).toHaveLength(0);
    const afterMove = await cartService.getCartSnapshot(account());
    expect(afterMove.items.find((item) => item.variantId === secondVariantId)?.quantity).toBe(3);
    expect(afterMove.items.find((item) => item.variantId === secondVariantId)?.attributionSource).toBe("WISHLIST");
  });

  it("runs bounded abandonment and expiry maintenance without sending marketing side-effects", async () => {
    const now = new Date();
    const [stale] = await db.insert(schema.carts).values({
      sessionId: guestHash("abandonment-test"),
      status: "ACTIVE",
      lastActivityAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    }).returning({ id: schema.carts.id });
    const [expired] = await db.insert(schema.carts).values({
      sessionId: guestHash("expiry-test"),
      status: "ACTIVE",
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() - 1000),
    }).returning({ id: schema.carts.id });
    cartIds.add(stale!.id);
    cartIds.add(expired!.id);

    expect(await cartService.markAbandonedCarts(now, 10)).toBe(1);
    expect(await cartService.markExpiredCarts(now, 10)).toBe(1);
    expect(await cartService.purgeExpiredCarts(now, 10)).toBe(1);
    const remaining = await db.select({ id: schema.carts.id }).from(schema.carts).where(eq(schema.carts.id, expired!.id));
    expect(remaining).toHaveLength(0);
  });

  it("scopes item mutations to the resolved owner, not a client-supplied item id", async () => {
    const otherGuest = { userId: null, guestSessionHash: guestHash("foreign-guest"), analyticsSessionHash: null };
    await cartService.addCartItem(otherGuest, {
      productId: secondProductId,
      variantId: secondVariantId,
      quantity: 1,
      source: "PRODUCT_CARD",
    }, { idempotencyKey: `${prefix}-foreign-add` });
    const foreign = await cartService.getCartSnapshot(otherGuest);
    cartIds.add(foreign.id!);
    const owner = { ...account(), guestSessionHash: guestHash("other-guest") };
    const snapshot = await cartService.getCartSnapshot(owner);
    cartIds.add(snapshot.id!);
    await expect(cartService.removeCartItem(owner, foreign.items[0]!.id, {
      idempotencyKey: `${prefix}-foreign-remove`,
      expectedCartVersion: snapshot.version,
    })).rejects.toMatchObject({ status: 404 });
  });
});
