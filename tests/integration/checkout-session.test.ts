// @vitest-environment node
/** Part 15 — checkout ownership, snapshots, revalidation, expiry and fail-closed service integrations. */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const prefix = `checkout${randomBytes(5).toString("hex")}`;
const guestHash = (seed: string) => createHash("sha256").update(`${prefix}:${seed}`).digest("hex");

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let eq: typeof import("drizzle-orm").eq;
let inArray: typeof import("drizzle-orm").inArray;
let cartService: typeof import("@/services/cart/cart.service");
let checkoutService: typeof import("@/services/checkout/checkout.service");
let productId: string;
let variantId: string;
const checkoutIds = new Set<string>();
const cartIds = new Set<string>();

const guest = {
  userId: null,
  guestSessionHash: guestHash("owner"),
  analyticsSessionHash: guestHash("analytics"),
};
const foreignGuest = {
  userId: null,
  guestSessionHash: guestHash("foreign"),
  analyticsSessionHash: null,
};

async function createProduct() {
  const [product] = await db.insert(schema.products).values({
    name: `${prefix} print shirt`,
    slug: `${prefix}-print-shirt`,
    productType: "OTHER",
    status: "ACTIVE",
    visibility: "PUBLIC",
    basePrice: 10_000,
    currency: "INR",
    publishedAt: new Date(),
  }).returning({ id: schema.products.id });
  const [variant] = await db.insert(schema.productVariants).values({
    productId: product!.id,
    sku: `${prefix}-shirt`.toUpperCase(),
    name: "Standard",
    price: 10_000,
    stockQuantity: 5,
    reservedQuantity: 0,
    availability: "IN_STOCK",
    isActive: true,
  }).returning({ id: schema.productVariants.id });
  return { productId: product!.id, variantId: variant!.id };
}

describe.skipIf(!enabled)("checkout preparation engine (PostgreSQL)", () => {
  beforeAll(async () => {
    const [dbModule, schemaModule, drizzle, cart, checkout] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
      import("@/services/cart/cart.service"),
      import("@/services/checkout/checkout.service"),
    ]);
    db = dbModule.db;
    schema = schemaModule;
    eq = drizzle.eq;
    inArray = drizzle.inArray;
    cartService = cart;
    checkoutService = checkout;
    ({ productId, variantId } = await createProduct());
    const added = await cartService.addCartItem(guest, {
      productId,
      variantId,
      quantity: 1,
      source: "PRODUCT_PAGE",
    }, { idempotencyKey: `${prefix}-cart-add` });
    expect(added.itemId).toBeTruthy();
    const cartSnapshot = await cartService.getCartSnapshot(guest);
    expect(cartSnapshot.id).toBeTruthy();
    cartIds.add(cartSnapshot.id!);
  });

  afterAll(async () => {
    if (!db || !schema) return;
    if (checkoutIds.size) await db.delete(schema.checkoutSessions).where(inArray(schema.checkoutSessions.id, [...checkoutIds])).catch(() => undefined);
    if (cartIds.size) await db.delete(schema.carts).where(inArray(schema.carts.id, [...cartIds])).catch(() => undefined);
    if (productId) await db.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined);
  });

  it("creates an owner-scoped session, replays creation idempotently and refuses another guest", async () => {
    const key = `${prefix}-start-001`;
    const created = await checkoutService.createOrResumeCheckoutSession(guest, key);
    checkoutIds.add(created.id);
    expect(created.status).toBe("NEEDS_ATTENTION");
    expect(created.isReady).toBe(false);
    expect(created.inventoryReserved).toBe(false);
    expect(created.paymentState).toBe("NOT_STARTED");
    expect(created.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SHIPPING_ADDRESS_REQUIRED",
      "CONTACT_REQUIRED",
      "DELIVERY_UNAVAILABLE",
      "TAX_NOT_CONFIGURED",
    ]));
    expect(created.delivery.options).toHaveLength(0);
    expect(created.totals.shippingPaise).toBeNull();
    expect(created.totals.totalEstimatePaise).toBeNull();

    const replay = await checkoutService.createOrResumeCheckoutSession(guest, key);
    expect(replay.id).toBe(created.id);

    await expect(checkoutService.getCheckoutSessionSummary(foreignGuest, created.id))
      .rejects.toMatchObject({ code: "CHECKOUT_ACCESS_DENIED" });
  });

  it("persists guest contact and inline address snapshots without creating an account address", async () => {
    const created = await checkoutService.createOrResumeCheckoutSession(guest, `${prefix}-start-contact`);
    checkoutIds.add(created.id);

    const contact = await checkoutService.updateCheckoutContact(guest, created.id, {
      name: "Guest Customer",
      email: `${prefix}@example.test`,
      phone: "+91 98765 43210",
    }, {
      expectedVersion: created.version,
      idempotencyKey: `${prefix}-contact-01`,
    });
    expect(contact.contact?.email).toBe(`${prefix}@example.test`);
    expect(contact.issues.map((issue) => issue.code)).not.toContain("CONTACT_REQUIRED");

    const address = await checkoutService.updateCheckoutAddresses(guest, created.id, {
      expectedVersion: contact.version,
      shippingAddress: {
        fullName: "Guest Customer",
        phone: "+91 98765 43210",
        addressLine1: "14 Residency Road",
        addressLine2: "",
        locality: "Central Bengaluru",
        landmark: "Near Trinity Circle",
        deliveryInstructions: "Call on arrival",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        country: "IN",
        addressType: "HOME",
        isDefaultShipping: false,
        isDefaultBilling: false,
      },
      billingSameAsShipping: true,
    }, { idempotencyKey: `${prefix}-address-01` });

    expect(address.shippingAddress?.source).toBe("INLINE");
    expect(address.billingSameAsShipping).toBe(true);
    expect(address.issues.map((issue) => issue.code)).not.toContain("SHIPPING_ADDRESS_REQUIRED");

    await expect(checkoutService.selectCheckoutDelivery(guest, created.id, {
      expectedVersion: address.version,
      deliveryMethodId: "invented-flat-rate",
    }, { idempotencyKey: `${prefix}-delivery-01` })).rejects.toMatchObject({ code: "DELIVERY_UNAVAILABLE" });
  });

  it("detects cart changes, requires acknowledgement and then revalidates current price and stock", async () => {
    const created = await checkoutService.createOrResumeCheckoutSession(guest, `${prefix}-start-cart`);
    checkoutIds.add(created.id);
    const cart = await cartService.getCartSnapshot(guest);
    cartIds.add(cart.id!);
    const line = cart.items[0]!;
    await cartService.updateCartItem(guest, { itemId: line.id, quantity: 2 }, {
      idempotencyKey: `${prefix}-cart-update`,
      expectedCartVersion: cart.version,
    });

    const changed = await checkoutService.getCheckoutSessionSummary(guest, created.id);
    expect(changed.issues.map((issue) => issue.code)).toContain("CART_CHANGED");
    expect(changed.items[0]?.quantity).toBe(2);

    const acknowledged = await checkoutService.revalidateCheckoutSession(guest, created.id, {
      expectedVersion: changed.version,
      acknowledgeCartChanges: true,
    }, { idempotencyKey: `${prefix}-review-cart` });
    expect(acknowledged.issues.map((issue) => issue.code)).not.toContain("CART_CHANGED");

    await db.update(schema.productVariants).set({ price: 12_500 }).where(eq(schema.productVariants.id, variantId));
    const repriced = await checkoutService.getCheckoutSessionSummary(guest, created.id);
    expect(repriced.issues.map((issue) => issue.code)).toContain("PRICE_CHANGED");

    await db.update(schema.productVariants).set({ stockQuantity: 1 }).where(eq(schema.productVariants.id, variantId));
    const stockChanged = await checkoutService.getCheckoutSessionSummary(guest, created.id);
    expect(stockChanged.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["STOCK_REDUCED"]));
    expect(stockChanged.isReady).toBe(false);
  });

  it("expires and redacts terminal guest data on schedule while pruning mutation keys", async () => {
    const created = await checkoutService.createOrResumeCheckoutSession(guest, `${prefix}-start-retention`);
    checkoutIds.add(created.id);
    const contact = await checkoutService.updateCheckoutContact(guest, created.id, {
      name: "Retention Guest",
      email: `${prefix}-retention@example.test`,
      phone: "+91 98765 43210",
    }, { expectedVersion: created.version, idempotencyKey: `${prefix}-retention-contact` });
    const addressed = await checkoutService.updateCheckoutAddresses(guest, created.id, {
      expectedVersion: contact.version,
      shippingAddress: {
        fullName: "Retention Guest",
        phone: "+91 98765 43210",
        addressLine1: "14 Residency Road",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        country: "IN",
        addressType: "HOME",
        isDefaultShipping: false,
        isDefaultBilling: false,
      },
      billingSameAsShipping: true,
    }, { idempotencyKey: `${prefix}-retention-address` });
    await checkoutService.cancelCheckoutSession(guest, created.id, {
      expectedVersion: addressed.version,
    }, { idempotencyKey: `${prefix}-retention-cancel` });

    const now = new Date();
    await db.update(schema.checkoutSessions).set({ piiPurgeAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.checkoutSessions.id, created.id));
    await db.update(schema.checkoutMutationKeys).set({ expiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(schema.checkoutMutationKeys.checkoutSessionId, created.id));

    const result = await checkoutService.runCheckoutMaintenance(now);
    expect(result.piiPurged).toBeGreaterThanOrEqual(1);
    expect(result.idempotencyKeysDeleted).toBeGreaterThanOrEqual(3);
    const [purged] = await db.select().from(schema.checkoutSessions)
      .where(eq(schema.checkoutSessions.id, created.id)).limit(1);
    expect(purged?.contactSnapshot).toBeNull();
    expect(purged?.shippingAddressSnapshot).toBeNull();
    expect(purged?.guestSessionHash).toBeNull();
    expect(purged?.piiPurgedAt).toBeInstanceOf(Date);
    const mutationKeys = await db.select().from(schema.checkoutMutationKeys)
      .where(eq(schema.checkoutMutationKeys.checkoutSessionId, created.id));
    expect(mutationKeys).toHaveLength(0);
  });

  it("supports cancellation and expires stale sessions without completing an order", async () => {
    const created = await checkoutService.createOrResumeCheckoutSession(guest, `${prefix}-start-cancel`);
    checkoutIds.add(created.id);
    const cancelled = await checkoutService.cancelCheckoutSession(guest, created.id, {
      expectedVersion: created.version,
    }, { idempotencyKey: `${prefix}-cancel-01` });
    expect(cancelled.status).toBe("CANCELLED");
    await expect(checkoutService.getCheckoutSessionSummary(guest, created.id))
      .rejects.toMatchObject({ code: "CHECKOUT_CANCELLED" });

    const expiring = await checkoutService.createOrResumeCheckoutSession(guest, `${prefix}-start-expire`);
    checkoutIds.add(expiring.id);
    await db.update(schema.checkoutSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.checkoutSessions.id, expiring.id));
    await expect(checkoutService.getCheckoutSessionSummary(guest, expiring.id))
      .rejects.toMatchObject({ code: "CHECKOUT_EXPIRED" });
    const [row] = await db.select({ status: schema.checkoutSessions.status })
      .from(schema.checkoutSessions).where(eq(schema.checkoutSessions.id, expiring.id)).limit(1);
    expect(row?.status).toBe("EXPIRED");
  });
});
