// @vitest-environment node
/** Part 16 — PostgreSQL promotion lifecycle, checkout reservation and concurrent capacity checks. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const prefix = `promo${randomBytes(6).toString("hex")}`;
let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let eq: typeof import("drizzle-orm").eq;
let inArray: typeof import("drizzle-orm").inArray;
let cartService: typeof import("@/services/cart/cart.service");
let checkoutService: typeof import("@/services/checkout/checkout.service");
let promotionService: typeof import("@/services/promotions/promotion.service");
let productId: string;
let variantId: string;
let actorId: string;
const promotionIds: string[] = [];
const checkoutIds: string[] = [];
const cartIds: string[] = [];
const couponIds: string[] = [];

function guest(seed: string) {
  return { userId: null, guestSessionHash: createHash("sha256").update(seed).digest("hex"), analyticsSessionHash: null };
}

async function createCheckout(owner: ReturnType<typeof guest>, suffix: string) {
  await cartService.addCartItem(owner, { productId, variantId, quantity: 1, source: "PRODUCT_PAGE" }, { idempotencyKey: `${prefix}-${suffix}-add-0001` });
  const cart = await cartService.getCartSnapshot(owner);
  if (!cart.id) throw new Error("Test cart was not created.");
  cartIds.push(cart.id);
  const checkout = await checkoutService.createOrResumeCheckoutSession(owner, `${prefix}-${suffix}-start-0001`);
  checkoutIds.push(checkout.id);
  return { owner, cart, checkout };
}

async function createCouponPromotion(code: string, usageLimit?: number) {
  const created = await promotionService.createPromotion({
    name: `${prefix} percent promotion`,
    strategy: "PERCENTAGE_OFF",
    config: { strategy: "PERCENTAGE_OFF", discountBasisPoints: 1000, maxDiscountPaise: null },
    eligibility: { requireAuthenticatedCustomer: false },
    targets: [],
    couponCode: code,
    isAutomatic: false,
    applyToCatalog: false,
    stackable: false,
    priority: 100,
    currency: "INR",
    totalUsageLimit: usageLimit ?? null,
    perCustomerUsageLimit: null,
    startsAt: null,
    endsAt: null,
    timezone: "Asia/Kolkata",
    campaignId: null,
  }, actorId);
  const row = created as { id: string };
  promotionIds.push(row.id);
  const coupon = await promotionService.transitionPromotion(row.id, 1, "ACTIVATE", actorId);
  const codeRow = await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.promotionId, row.id)).limit(1);
  if (codeRow[0]) couponIds.push(codeRow[0].id);
  expect(coupon).toMatchObject({ id: row.id, status: "ACTIVE", version: 2 });
  return row.id;
}

describe.skipIf(!enabled)("promotion checkout integration (PostgreSQL)", () => {
  beforeAll(async () => {
    const [dbModule, schemaModule, drizzle, cart, checkout, promotion] = await Promise.all([
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
      import("@/services/cart/cart.service"),
      import("@/services/checkout/checkout.service"),
      import("@/services/promotions/promotion.service"),
    ]);
    db = dbModule.db;
    schema = schemaModule;
    eq = drizzle.eq;
    inArray = drizzle.inArray;
    cartService = cart;
    checkoutService = checkout;
    promotionService = promotion;
    actorId = randomUUID();
    await db.insert(schema.users).values({
      id: actorId,
      name: `${prefix} admin`,
      email: `${prefix}@example.test`,
      role: "ADMIN",
    });
    const [product] = await db.insert(schema.products).values({
      name: `${prefix} Catalog Item`,
      slug: `${prefix}-catalog-item`,
      productType: "OTHER",
      status: "ACTIVE",
      visibility: "PUBLIC",
      basePrice: 10_000,
      currency: "INR",
      publishedAt: new Date(),
    }).returning({ id: schema.products.id });
    const [variant] = await db.insert(schema.productVariants).values({
      productId: product!.id,
      sku: `${prefix}-variant`.toUpperCase(),
      name: "Standard",
      price: 10_000,
      stockQuantity: 10,
      reservedQuantity: 0,
      availability: "IN_STOCK",
      isActive: true,
    }).returning({ id: schema.productVariants.id });
    productId = product!.id;
    variantId = variant!.id;
  });

  afterAll(async () => {
    if (!db || !schema) return;
    if (checkoutIds.length) await db.delete(schema.checkoutSessions).where(inArray(schema.checkoutSessions.id, checkoutIds)).catch(() => undefined);
    if (cartIds.length) await db.delete(schema.carts).where(inArray(schema.carts.id, cartIds)).catch(() => undefined);
    if (couponIds.length) await db.delete(schema.coupons).where(inArray(schema.coupons.id, couponIds)).catch(() => undefined);
    if (promotionIds.length) {
      await db.delete(schema.promotionVersions).where(inArray(schema.promotionVersions.promotionId, promotionIds)).catch(() => undefined);
      await db.delete(schema.promotions).where(inArray(schema.promotions.id, promotionIds)).catch(() => undefined);
    }
    if (productId) await db.delete(schema.products).where(eq(schema.products.id, productId)).catch(() => undefined);
    if (actorId) await db.delete(schema.users).where(eq(schema.users.id, actorId)).catch(() => undefined);
  });

  it("applies the server quote, stores line allocations, and releases a checkout reservation on cancel", async () => {
    const promotionId = await createCouponPromotion(`${prefix}10`);
    const owner = guest(`${prefix}owner1`);
    const { checkout } = await createCheckout(owner, "lifecycle");
    const applied = await checkoutService.applyCheckoutCoupon(owner, checkout.id, {
      expectedVersion: checkout.version,
      code: `${prefix}10`,
    }, { idempotencyKey: `${prefix}-apply-0001` });

    expect(applied.appliedCoupon).toEqual({ code: `${prefix}10`.toUpperCase(), applied: true, discountPaise: 1000 });
    expect(applied.totals.subtotalPaise).toBe(9_000);
    expect(applied.appliedPromotions).toEqual(expect.arrayContaining([expect.objectContaining({ promotionId, discountPaise: 1000 })]));
    expect(applied.isReady).toBe(false);

    const reserved = await db.select().from(schema.promotionRedemptions).where(eq(schema.promotionRedemptions.checkoutSessionId, checkout.id));
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ promotionId, status: "RESERVED", discountPaise: 1000, currency: "INR" });
    expect(reserved[0]?.allocations).toEqual([expect.objectContaining({ productId, amountPaise: 1000 })]);
    const versions = await db.select({ version: schema.promotionVersions.version, snapshot: schema.promotionVersions.snapshot })
      .from(schema.promotionVersions).where(eq(schema.promotionVersions.promotionId, promotionId));
    expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
    expect(versions[0]?.snapshot).toMatchObject({ targets: [], couponConfigured: true });

    const cancelled = await checkoutService.cancelCheckoutSession(owner, checkout.id, { expectedVersion: applied.version }, { idempotencyKey: `${prefix}-cancel-0001` });
    expect(cancelled.status).toBe("CANCELLED");
    const released = await db.select().from(schema.promotionRedemptions).where(eq(schema.promotionRedemptions.checkoutSessionId, checkout.id));
    expect(released[0]).toMatchObject({ status: "RELEASED" });
    const coupon = await db.select().from(schema.coupons).where(eq(schema.coupons.promotionId, promotionId)).limit(1);
    expect(coupon[0]?.usageCount).toBe(0);
  });

  it("releases an abandoned checkout reservation during session maintenance without redeeming it", async () => {
    const promotionId = await createCouponPromotion(`${prefix}expire`, 1);
    const owner = guest(`${prefix}owner4`);
    const { checkout } = await createCheckout(owner, "expiry");
    const applied = await checkoutService.applyCheckoutCoupon(owner, checkout.id, {
      expectedVersion: checkout.version,
      code: `${prefix}expire`,
    }, { idempotencyKey: `${prefix}-apply-expire-0001` });
    await db.update(schema.checkoutSessions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.checkoutSessions.id, checkout.id));

    const maintenance = await checkoutService.runCheckoutMaintenance(new Date(), 100);
    expect(maintenance.expired).toBe(1);
    const expiredSession = await db.select().from(schema.checkoutSessions).where(eq(schema.checkoutSessions.id, checkout.id)).limit(1);
    expect(expiredSession[0]?.status).toBe("EXPIRED");
    const reservation = await db.select().from(schema.promotionRedemptions).where(eq(schema.promotionRedemptions.checkoutSessionId, checkout.id));
    expect(reservation[0]).toMatchObject({ promotionId, status: "RELEASED" });
    const coupon = await db.select().from(schema.coupons).where(eq(schema.coupons.promotionId, promotionId)).limit(1);
    expect(coupon[0]?.usageCount).toBe(0);
    expect(applied.appliedCoupon?.applied).toBe(true);
  });

  it("serializes capped reservations so concurrent checkouts cannot exceed one-use capacity", async () => {
    await createCouponPromotion(`${prefix}cap`, 1);
    const first = await createCheckout(guest(`${prefix}owner2`), "concurrent-a");
    const second = await createCheckout(guest(`${prefix}owner3`), "concurrent-b");
    const code = `${prefix}cap`;
    const settled = await Promise.allSettled([
      checkoutService.applyCheckoutCoupon(first.owner, first.checkout.id, { expectedVersion: first.checkout.version, code }, { idempotencyKey: `${prefix}-apply-a-0001` }),
      checkoutService.applyCheckoutCoupon(second.owner, second.checkout.id, { expectedVersion: second.checkout.version, code }, { idempotencyKey: `${prefix}-apply-b-0001` }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "COUPON_UNAVAILABLE" });

    const currentReservations = await db.select().from(schema.promotionRedemptions).where(eq(schema.promotionRedemptions.status, "RESERVED"));
    const thisCoupon = await db.select({ id: schema.coupons.id }).from(schema.coupons).where(eq(schema.coupons.code, code.toUpperCase())).limit(1);
    expect(thisCoupon).toHaveLength(1);
    const matching = currentReservations.filter((row) => row.couponId === thisCoupon[0]?.id);
    expect(matching).toHaveLength(1);

    const fulfilledIndex = settled.findIndex((result) => result.status === "fulfilled");
    const winner = fulfilledIndex === 0 ? first : second;
    const loser = fulfilledIndex === 0 ? second : first;
    const winnerDto = (settled[fulfilledIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof checkoutService.applyCheckoutCoupon>>>).value;
    await checkoutService.cancelCheckoutSession(winner.owner, winner.checkout.id, { expectedVersion: winnerDto.version }, { idempotencyKey: `${prefix}-cancel-winner-0001` });

    const retry = await checkoutService.applyCheckoutCoupon(loser.owner, loser.checkout.id, {
      expectedVersion: loser.checkout.version,
      code,
    }, { idempotencyKey: `${prefix}-apply-retry-0001` });
    expect(retry.appliedCoupon?.applied).toBe(true);
    await checkoutService.cancelCheckoutSession(loser.owner, loser.checkout.id, { expectedVersion: retry.version }, { idempotencyKey: `${prefix}-cancel-loser-0001` });

    const released = await db.select().from(schema.promotionRedemptions).where(eq(schema.promotionRedemptions.couponId, thisCoupon[0]!.id));
    expect(released.filter((row) => row.status === "RELEASED")).toHaveLength(2);
  });
});
