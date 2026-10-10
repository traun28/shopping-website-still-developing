import { describe, expect, it } from "vitest";
import { promotionConfigSchema, promotionCreateSchema, promotionEligibilitySchema } from "@/validations/promotions";

const base = {
  name: "Cart offer",
  strategy: "PERCENTAGE_OFF",
  config: { strategy: "PERCENTAGE_OFF", discountBasisPoints: 1250 },
  eligibility: { requireAuthenticatedCustomer: false },
  targets: [],
  isAutomatic: true,
  applyToCatalog: false,
  stackable: false,
  priority: 10,
  currency: "INR",
};

describe("promotion rule schemas", () => {
  it("accepts a typed basis-point rule and bounded normalized targets", () => {
    const parsed = promotionCreateSchema.parse({
      ...base,
      targets: [{ dimension: "CATEGORY", entityId: "00000000-0000-4000-8000-000000000001", mode: "INCLUDE" }],
    });
    expect(parsed.config).toEqual({ strategy: "PERCENTAGE_OFF", discountBasisPoints: 1250 });
    expect(parsed.targets[0]?.dimension).toBe("CATEGORY");
  });

  it("rejects executable or unknown condition data rather than interpreting it", () => {
    expect(promotionCreateSchema.safeParse({ ...base, arbitrarySql: "drop table products" }).success).toBe(false);
    expect(promotionEligibilitySchema.safeParse({ firstOrderOnly: true }).success).toBe(false);
    expect(promotionConfigSchema.safeParse({ strategy: "PERCENTAGE_OFF", discountBasisPoints: 20000 }).success).toBe(false);
  });

  it("rejects mismatched strategy/config and coupon/automatic ambiguity", () => {
    expect(promotionCreateSchema.safeParse({ ...base, strategy: "FIXED_AMOUNT_OFF" }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ ...base, isAutomatic: false }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ ...base, couponCode: "SAVE10" }).success).toBe(false);
  });

  it("bounds rule complexity and enforces ordered tiers", () => {
    const duplicateTierConfig = {
      strategy: "QUANTITY_TIER",
      tiers: [
        { minQuantity: 3, discountType: "PERCENTAGE", value: 1000 },
        { minQuantity: 3, discountType: "PERCENTAGE", value: 2000 },
      ],
    };
    expect(promotionConfigSchema.safeParse(duplicateTierConfig).success).toBe(false);
    expect(promotionConfigSchema.safeParse({ strategy: "QUANTITY_TIER", tiers: [] }).success).toBe(false);
  });

  it("requires a coupon for code-based promotions and rejects usage-limited automatic rules", () => {
    expect(promotionCreateSchema.safeParse({ ...base, isAutomatic: false, couponCode: "SAVE10" }).success).toBe(true);
    expect(promotionCreateSchema.safeParse({ ...base, isAutomatic: false }).success).toBe(false);
    expect(promotionCreateSchema.safeParse({ ...base, totalUsageLimit: 1 }).success).toBe(false);
  });
});
