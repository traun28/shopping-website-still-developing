export const PROMOTION_STRATEGIES = [
  "PERCENTAGE_OFF",
  "FIXED_AMOUNT_OFF",
  "CART_THRESHOLD",
  "QUANTITY_TIER",
  "BUY_X_GET_Y",
  "BUNDLE",
  "FREE_SHIPPING",
] as const;
export type PromotionStrategy = (typeof PROMOTION_STRATEGIES)[number];

export const PROMOTION_TARGET_DIMENSIONS = ["PRODUCT", "CATEGORY", "BRAND", "SELLER", "COLLECTION", "CUSTOMER"] as const;
export type PromotionTargetDimension = (typeof PROMOTION_TARGET_DIMENSIONS)[number];
export type PromotionTargetMode = "INCLUDE" | "EXCLUDE";

export interface PromotionTarget {
  dimension: PromotionTargetDimension;
  entityId: string;
  mode: PromotionTargetMode;
}

export interface PromotionTier {
  minQuantity: number;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  value: number;
  maxDiscountPaise?: number | null;
}

export type PromotionConfig =
  | { strategy: "PERCENTAGE_OFF"; discountBasisPoints: number; maxDiscountPaise?: number | null }
  | { strategy: "FIXED_AMOUNT_OFF"; amountPaise: number }
  | { strategy: "CART_THRESHOLD"; thresholdPaise: number; discountType: "PERCENTAGE" | "FIXED_AMOUNT"; value: number; maxDiscountPaise?: number | null }
  | { strategy: "QUANTITY_TIER"; tiers: PromotionTier[] }
  | { strategy: "BUY_X_GET_Y"; buyQuantity: number; getQuantity: number; rewardBasisPoints: number }
  | { strategy: "BUNDLE"; minimumDistinctProducts: number; discountBasisPoints: number }
  | { strategy: "FREE_SHIPPING" };

/** Bounded, data-only eligibility conditions. No expressions or executable code. */
export interface PromotionEligibility {
  minimumCartSubtotalPaise?: number | null;
  minimumItemQuantity?: number | null;
  requireAuthenticatedCustomer?: boolean;
  /** This flag is intentionally rejected by the runtime until completed-order identity is trustworthy. */
  firstOrderOnly?: boolean;
}

export interface PromotionCandidate {
  id: string;
  version: number;
  name: string;
  status?: string;
  strategy: PromotionStrategy;
  config: PromotionConfig;
  eligibility: PromotionEligibility;
  targets: readonly PromotionTarget[];
  priority: number;
  stackable: boolean;
  stackGroup: string | null;
  currency: string;
  startsAt: Date | null;
  endsAt: Date | null;
  campaignStartsAt?: Date | null;
  campaignEndsAt?: Date | null;
  campaignStatus?: string | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  isAutomatic: boolean;
  couponId?: string | null;
  couponCode?: string | null;
}

export interface PromotionCartLine {
  id: string;
  productId: string;
  variantId: string;
  sellerId: string | null;
  categoryIds: readonly string[];
  brandId: string | null;
  collectionIds: readonly string[];
  quantity: number;
  unitPricePaise: number;
  /** Current server-priced line total, after any earlier automatic promotions. */
  lineSubtotalPaise?: number | null;
  currency: string;
}

export interface PromotionContext {
  userId: string | null;
  now?: Date;
  /** Admin-only simulation can inspect a draft without changing persisted state. */
  ignoreLifecycle?: boolean;
  /** Only a validated server quote can make free shipping eligible. */
  shippingAmountPaise?: number | null;
  /** Pass true only when the shipping provider has returned a final quote. */
  shippingQuoteAuthoritative?: boolean;
}

export interface PromotionAllocation {
  promotionId: string;
  promotionName: string;
  couponId: string | null;
  amountPaise: number;
  lineAllocations: Record<string, number>;
  stackable: boolean;
  priority: number;
}

export interface PromotionEvaluation {
  allocations: PromotionAllocation[];
  totalDiscountPaise: number;
  evaluatedPromotions: Array<{
    promotionId: string;
    name: string;
    eligible: boolean;
    reason: string;
    discountPaise: number;
  }>;
  unsupported: Array<{ promotionId: string; strategy: PromotionStrategy; reason: string }>;
}
