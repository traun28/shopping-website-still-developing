import { describe, expect, it } from "vitest";
import { applyPromotionEvaluationToCart, evaluatePromotionCart } from "@/lib/promotions/engine";
import type { PromotionCandidate, PromotionCartLine } from "@/lib/promotions/types";
import { normalizeCouponCode } from "@/lib/promotions/utils";

const line = (input: Partial<PromotionCartLine> & Pick<PromotionCartLine, "id" | "productId" | "unitPricePaise" | "quantity">): PromotionCartLine => ({
  id: input.id,
  productId: input.productId,
  variantId: input.variantId ?? `variant-${input.id}`,
  sellerId: input.sellerId ?? "seller-a",
  categoryIds: input.categoryIds ?? [],
  brandId: input.brandId ?? null,
  collectionIds: input.collectionIds ?? [],
  quantity: input.quantity,
  unitPricePaise: input.unitPricePaise,
  lineSubtotalPaise: input.lineSubtotalPaise,
  currency: input.currency ?? "INR",
});

const promo = (id: string, config: PromotionCandidate["config"], overrides: Partial<PromotionCandidate> = {}): PromotionCandidate => ({
  id,
  version: 1,
  name: id,
  status: "ACTIVE",
  strategy: config.strategy,
  config,
  eligibility: { requireAuthenticatedCustomer: false },
  targets: [],
  priority: 100,
  stackable: false,
  stackGroup: null,
  currency: "INR",
  startsAt: null,
  endsAt: null,
  isAutomatic: true,
  ...overrides,
});

const evaluate = (candidates: PromotionCandidate[], lines: PromotionCartLine[], userId: string | null = null) =>
  evaluatePromotionCart({ candidates, lines, currency: "INR", context: { userId, now: new Date("2026-10-11T12:00:00Z") } });

describe("promotion allocation engine", () => {
  it("allocates a fixed cart discount exactly with deterministic largest remainders", () => {
    const result = evaluate(
      [promo("fixed", { strategy: "FIXED_AMOUNT_OFF", amountPaise: 101 })],
      [line({ id: "a", productId: "p-a", quantity: 2, unitPricePaise: 50 }), line({ id: "b", productId: "p-b", quantity: 1, unitPricePaise: 200 })],
    );
    expect(result.totalDiscountPaise).toBe(101);
    expect(result.allocations[0]?.lineAllocations).toEqual({ a: 34, b: 67 });
    expect(Object.values(result.allocations[0]!.lineAllocations).reduce((sum, amount) => sum + amount, 0)).toBe(101);
  });

  it("uses basis points with integer half-up rounding and respects discount caps", () => {
    const result = evaluate(
      [promo("percent", { strategy: "PERCENTAGE_OFF", discountBasisPoints: 3333, maxDiscountPaise: 10 })],
      [line({ id: "a", productId: "p-a", quantity: 1, unitPricePaise: 31 })],
    );
    expect(result.totalDiscountPaise).toBe(10);
  });

  it("composes product, category, brand and seller targeting without trusting client totals", () => {
    const candidate = promo("targeted", { strategy: "PERCENTAGE_OFF", discountBasisPoints: 2000 }, {
      targets: [
        { dimension: "CATEGORY", entityId: "cat-a", mode: "INCLUDE" },
        { dimension: "BRAND", entityId: "brand-a", mode: "INCLUDE" },
        { dimension: "SELLER", entityId: "seller-a", mode: "INCLUDE" },
        { dimension: "PRODUCT", entityId: "p-blocked", mode: "EXCLUDE" },
      ],
    });
    const result = evaluate([
      candidate,
      promo("threshold", { strategy: "CART_THRESHOLD", thresholdPaise: 50_000, discountType: "FIXED_AMOUNT", value: 5_000 }),
    ], [
      line({ id: "match", productId: "p-match", categoryIds: ["cat-a"], brandId: "brand-a", sellerId: "seller-a", quantity: 1, unitPricePaise: 1_000 }),
      line({ id: "category-only", productId: "p-other", categoryIds: ["cat-a"], brandId: "brand-b", sellerId: "seller-a", quantity: 1, unitPricePaise: 1_000 }),
      line({ id: "excluded", productId: "p-blocked", categoryIds: ["cat-a"], brandId: "brand-a", sellerId: "seller-a", quantity: 1, unitPricePaise: 1_000 }),
    ]);
    expect(result.totalDiscountPaise).toBe(200);
    expect(result.allocations[0]?.lineAllocations).toEqual({ match: 200 });
    expect(result.evaluatedPromotions.find((item) => item.promotionId === "threshold")?.eligible).toBe(false);
  });

  it("uses customer assignment rules only for the matching authenticated customer", () => {
    const candidate = promo("assigned", { strategy: "FIXED_AMOUNT_OFF", amountPaise: 25 }, {
      targets: [{ dimension: "CUSTOMER", entityId: "user-1", mode: "INCLUDE" }],
    });
    const cart = [line({ id: "line", productId: "product", quantity: 1, unitPricePaise: 100 })];
    expect(evaluate([candidate], cart).totalDiscountPaise).toBe(0);
    expect(evaluate([candidate], cart, "user-2").totalDiscountPaise).toBe(0);
    expect(evaluate([candidate], cart, "user-1").totalDiscountPaise).toBe(25);
  });

  it("applies stackable discounts sequentially to the remaining eligible subtotal", () => {
    const result = evaluate([
      promo("first", { strategy: "PERCENTAGE_OFF", discountBasisPoints: 5000 }, { stackable: true, priority: 20 }),
      promo("second", { strategy: "PERCENTAGE_OFF", discountBasisPoints: 5000 }, { stackable: true, priority: 10 }),
    ], [line({ id: "line", productId: "product", quantity: 1, unitPricePaise: 100 })]);
    expect(result.totalDiscountPaise).toBe(75);
    expect(result.allocations.map((allocation) => allocation.amountPaise)).toEqual([50, 25]);
  });

  it("selects one best proposal if any applicable promotion is non-stackable", () => {
    const result = evaluate([
      promo("small-fixed", { strategy: "FIXED_AMOUNT_OFF", amountPaise: 40 }, { priority: 20, stackable: false }),
      promo("large-percent", { strategy: "PERCENTAGE_OFF", discountBasisPoints: 5000 }, { priority: 10, stackable: true }),
    ], [line({ id: "line", productId: "product", quantity: 1, unitPricePaise: 100 })]);
    expect(result.totalDiscountPaise).toBe(50);
    expect(result.allocations.map((allocation) => allocation.promotionId)).toEqual(["large-percent"]);
  });

  it("applies Buy X Get Y to the cheapest eligible reward units in a deterministic order", () => {
    const result = evaluate([
      promo("bxgy", { strategy: "BUY_X_GET_Y", buyQuantity: 2, getQuantity: 1, rewardBasisPoints: 10_000 })],
      [line({ id: "expensive", productId: "p1", quantity: 2, unitPricePaise: 100 }), line({ id: "cheap", productId: "p2", quantity: 1, unitPricePaise: 50 })],
    );
    expect(result.totalDiscountPaise).toBe(50);
    expect(result.allocations[0]?.lineAllocations).toEqual({ cheap: 50 });
  });

  it("chooses the highest satisfied quantity tier and applies bundle thresholds", () => {
    const tiers = promo("tiers", {
      strategy: "QUANTITY_TIER",
      tiers: [
        { minQuantity: 2, discountType: "PERCENTAGE", value: 1000 },
        { minQuantity: 4, discountType: "PERCENTAGE", value: 2500 },
      ],
    });
    const bundle = promo("bundle", { strategy: "BUNDLE", minimumDistinctProducts: 2, discountBasisPoints: 500 });
    const result = evaluate([tiers, bundle], [
      line({ id: "a", productId: "p-a", quantity: 2, unitPricePaise: 100 }),
      line({ id: "b", productId: "p-b", quantity: 2, unitPricePaise: 100 }),
    ]);
    expect(result.totalDiscountPaise).toBe(100);
    expect(result.allocations.map((allocation) => allocation.amountPaise)).toEqual([100]);
    expect(result.allocations[0]?.promotionId).toBe("tiers");
  });

  it("does not fabricate a shipping discount when no final shipping quote exists", () => {
    const result = evaluate([promo("shipping", { strategy: "FREE_SHIPPING" })], [line({ id: "line", productId: "product", quantity: 1, unitPricePaise: 100 })]);
    expect(result.totalDiscountPaise).toBe(0);
    expect(result.allocations).toEqual([]);
    expect(result.unsupported[0]?.reason).toContain("authoritative shipping quote");
  });

  it("applies allocations to cart totals and line snapshots without making a negative amount", () => {
    const cart = {
      items: [{ id: "line", quantity: 1, unitPricePaise: 100, lineSubtotalPaise: 100, lineDiscountPaise: 0 }],
      totals: { currency: "INR", listSubtotalPaise: 100, productDiscountPaise: 0, cartDiscountPaise: 0, subtotalPaise: 100, estimatedTaxPaise: 0, deliveryEstimatePaise: null, totalPaise: 100 },
    };
    const result = evaluate([promo("fixed", { strategy: "FIXED_AMOUNT_OFF", amountPaise: 900 })], [line({ id: "line", productId: "product", quantity: 1, unitPricePaise: 100 })]);
    const applied = applyPromotionEvaluationToCart(cart, result);
    expect(applied.items[0]?.lineSubtotalPaise).toBe(0);
    expect(applied.items[0]?.lineDiscountPaise).toBe(100);
    expect(applied.totals.subtotalPaise).toBe(0);
    expect(applied.totals.cartDiscountPaise).toBe(100);
  });

  it("normalizes coupon codes and rejects malformed/ambiguous text", () => {
    expect(normalizeCouponCode("  spring_10 ")).toBe("SPRING_10");
    expect(normalizeCouponCode("ab")).toBeNull();
    expect(normalizeCouponCode("A B C")).toBeNull();
    expect(normalizeCouponCode("% eval" )).toBeNull();
  });
});
