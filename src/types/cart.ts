export type CartWarningCode =
  | "PRICE_CHANGED"
  | "STOCK_REDUCED"
  | "OUT_OF_STOCK"
  | "PRODUCT_UNAVAILABLE"
  | "VARIANT_UNAVAILABLE"
  | "SELLER_UNAVAILABLE"
  | "CURRENCY_MISMATCH"
  | "QUANTITY_LIMIT";

export interface CartWarning {
  code: CartWarningCode;
  message: string;
  itemId?: string;
  productId?: string;
  previousUnitPricePaise?: number;
  currentUnitPricePaise?: number;
  availableQuantity?: number;
  requestedQuantity?: number;
}

export interface CartLineDTO {
  id: string;
  productId: string;
  variantId: string;
  slug: string;
  productName: string;
  variantName: string;
  size: string | null;
  color: string | null;
  imageUrl: string | null;
  sellerId: string | null;
  sellerName: string | null;
  quantity: number;
  currency: string;
  /** Last server-observed selling price saved on the line. */
  observedUnitPricePaise: number;
  /** Current catalog price after eligible product/variant rules, or null if unavailable. */
  unitPricePaise: number | null;
  compareAtPaise: number | null;
  listUnitPricePaise: number | null;
  lineSubtotalPaise: number | null;
  lineDiscountPaise: number;
  estimatedTaxPaise: number;
  availableQuantity: number;
  purchasable: boolean;
  attributionSource: string | null;
  version: number;
  warnings: CartWarning[];
}

export interface CartTotalsDTO {
  currency: string;
  listSubtotalPaise: number;
  productDiscountPaise: number;
  cartDiscountPaise: number;
  subtotalPaise: number;
  estimatedTaxPaise: number;
  /** null until a real delivery-rating service exists. */
  deliveryEstimatePaise: number | null;
  /** Current subtotal + current catalog tax estimate; not a checkout quote. */
  totalPaise: number;
}

export interface CartMergeResult {
  merged: boolean;
  mergedLines: number;
  combinedLines: number;
  warnings: CartWarning[];
  requiresCustomerAttention: boolean;
}

export interface CartPromotionApplication {
  promotionId: string;
  name: string;
  discountPaise: number;
  couponId: string | null;
  couponCode: string | null;
}

export interface CartDTO {
  id: string | null;
  status: "ACTIVE";
  currency: string;
  version: number;
  createdAt: string | null;
  lastActivityAt: string | null;
  expiresAt: string | null;
  items: CartLineDTO[];
  itemCount: number;
  lineCount: number;
  totals: CartTotalsDTO;
  /** Server-calculated promotion allocations; omitted on raw validation snapshots. */
  promotionApplications?: CartPromotionApplication[];
  /** Customer-safe coupon failure only; never reveals whether another user's code exists. */
  promotionIssues?: string[];
  warnings: CartWarning[];
  readyForCheckout: boolean;
  mergeResult: CartMergeResult | null;
}

export interface SavedItemDTO extends CartLineDTO {
  id: string;
  savedAt: string;
}

export interface CartMutationDTO {
  itemId?: string;
  quantity?: number;
  version: number;
  priceChanged?: boolean;
  previousObservedUnitPricePaise?: number;
  currentUnitPricePaise?: number;
  warnings?: CartWarning[];
}
