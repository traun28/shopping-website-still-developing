import type { RecommendationType } from "@/lib/recommendations/types";

export type CartAttributionSource =
  | "PRODUCT_PAGE"
  | "PRODUCT_CARD"
  | "MINI_CART"
  | "CART_RECOMMENDATION"
  | "WISHLIST"
  | "SAVED_FOR_LATER"
  | "RESTORE_SAVED_ITEM"
  | "UNKNOWN";

export interface CartPrincipal {
  userId: string | null;
  /** SHA-256 digest of the opaque HttpOnly cart cookie, or null when absent. */
  guestSessionHash: string | null;
  /** Part 13's salted analytics identity; not used for cart ownership. */
  analyticsSessionHash?: string | null;
}

export interface RecommendationAttribution {
  id: string;
  type: RecommendationType;
  position: number;
  algorithmVersion: string;
}

export interface CartMutationOptions {
  idempotencyKey: string;
  expectedCartVersion?: number;
  recommendation?: RecommendationAttribution | null;
}

export interface CartMutationResult {
  itemId?: string;
  productId?: string;
  variantId?: string;
  quantity?: number;
  version: number;
  priceChanged?: boolean;
  previousObservedUnitPricePaise?: number;
  currentUnitPricePaise?: number;
  warnings?: Array<{ code: string; message: string; [key: string]: unknown }>;
  replayed: boolean;
}

export interface CartOperationResult {
  result: CartMutationResult;
  createdGuestCart: boolean;
}
