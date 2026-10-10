import { pgEnum } from "drizzle-orm/pg-core";

/**
 * All PostgreSQL enums for the platform, centralized.
 * Status systems are deliberately separated (order vs payment vs
 * fulfillment vs shipping) because each transitions independently.
 */

/* ── Users ────────────────────────────────────────────────────────────── */
export const userRoleEnum = pgEnum("user_role", [
  "CUSTOMER",
  "SUPPORT",
  "ORDER_MANAGER",
  "PRODUCT_MANAGER",
  "ADMIN",
  "SUPER_ADMIN",
]);

export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "SUSPENDED", "DEACTIVATED"]);

/* ── Catalog ──────────────────────────────────────────────────────────── */
export const productStatusEnum = pgEnum("product_status", [
  "DRAFT",
  "ACTIVE",
  "ARCHIVED",
  "DISCONTINUED",
]);

export const collectionStatusEnum = pgEnum("collection_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);

/**
 * Visibility is orthogonal to `productStatusEnum`.
 *   status   = lifecycle (is this product finished / retired?)
 *   visibility = who may see it (storefront / direct-link / staff only)
 * A product is listed on the storefront only when ACTIVE **and** PUBLIC.
 */
export const productVisibilityEnum = pgEnum("product_visibility", ["PUBLIC", "UNLISTED", "PRIVATE"]);

/** Media kind — the `images` table is the platform media table (see catalog.ts). */
export const mediaKindEnum = pgEnum("media_kind", ["IMAGE", "VIDEO", "SPIN_360"]);

export const productTypeEnum = pgEnum("product_type", [
  "T_SHIRT",
  "HOODIE",
  "SWEATSHIRT",
  "MUG",
  "POSTER",
  "PHONE_CASE",
  "TOTE_BAG",
  "CUSTOM",
  "OTHER",
]);

export const designStatusEnum = pgEnum("design_status", [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
  "REJECTED",
]);

export const copyrightStatusEnum = pgEnum("copyright_status", [
  "ORIGINAL",
  "LICENSED",
  "PENDING_REVIEW",
  "RESTRICTED",
]);

export const designPlacementEnum = pgEnum("design_placement", [
  "FRONT",
  "BACK",
  "LEFT_SLEEVE",
  "RIGHT_SLEEVE",
  "CENTER",
  "OTHER",
]);

export const availabilityStatusEnum = pgEnum("availability_status", [
  "IN_STOCK",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "PREORDER",
]);

export const imageTypeEnum = pgEnum("image_type", [
  "PRODUCT",
  "DESIGN",
  "CATEGORY",
  "COLLECTION",
  "USER",
  "REVIEW",
  "BANNER",
]);

export const imageRoleEnum = pgEnum("image_role", [
  "PRIMARY",
  "GALLERY",
  "HOVER",
  "THUMBNAIL",
  "MOBILE",
  "SOCIAL",
]);

/* ── Catalog intelligence (Part 11) ───────────────────────────────────── */

/**
 * Flexible attribute engine. A definition is an axis ("Size", "Storage",
 * "Material") or a spec key; products opt into whichever axes they need, so
 * size/colour are never hard-coded into the variant model.
 */
export const attributeTypeEnum = pgEnum("attribute_type", [
  "TEXT",
  "NUMBER",
  "BOOLEAN",
  "COLOR",
  "ENUM",
]);

/** Inventory movement kinds. Append-only ledger; quantity is derived, never edited. */
export const inventoryOperationEnum = pgEnum("inventory_operation", [
  "STOCK_IN",
  "SALE",
  "RETURN",
  "CANCELLATION",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
  "RESERVED",
  "RELEASED",
]);

/** What an object in the ledger points at (order, return, import batch, …). */
export const inventoryReferenceEnum = pgEnum("inventory_reference", [
  "ORDER",
  "ORDER_ITEM",
  "RETURN",
  "CANCELLATION",
  "PURCHASE_ORDER",
  "IMPORT_BATCH",
  "MANUAL",
]);

/* ── Pricing engine ───────────────────────────────────────────────────── */
export const priceRuleTypeEnum = pgEnum("price_rule_type", [
  "AUTOMATIC",
  "CAMPAIGN",
  "SELLER",
  "SCHEDULED",
]);

export const discountTypeEnum = pgEnum("discount_type", ["PERCENTAGE", "FIXED_AMOUNT"]);

/* ── Product relationships / recommendations ──────────────────────────── */
export const productRelationTypeEnum = pgEnum("product_relation_type", [
  "RELATED",
  "UPSELL",
  "CROSS_SELL",
  "FREQUENTLY_BOUGHT_TOGETHER",
  "ACCESSORY",
]);

/* ── Event-driven catalog outbox ──────────────────────────────────────── */
export const catalogEventTypeEnum = pgEnum("catalog_event_type", [
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_DELETED",
  "PRICE_CHANGED",
  "STOCK_CHANGED",
  "PRODUCT_PUBLISHED",
  "PRODUCT_UNPUBLISHED",
  "VARIANT_CREATED",
  "VARIANT_UPDATED",
  "VARIANT_RETIRED",
  "MEDIA_CHANGED",
  "CATEGORY_UPDATED",
  "BRAND_CREATED",
  "BRAND_UPDATED",
  "BRAND_DELETED",
  "SEARCH_INDEX_REFRESHED",
  "PROMOTION_CREATED",
  "PROMOTION_UPDATED",
  "PROMOTION_ACTIVATED",
  "PROMOTION_PAUSED",
  "PROMOTION_ARCHIVED",
  "CAMPAIGN_CREATED",
  "CAMPAIGN_UPDATED",
  "CAMPAIGN_ACTIVATED",
  "CAMPAIGN_PAUSED",
  "CAMPAIGN_ARCHIVED",
  "PROMOTION_RESERVED",
  "PROMOTION_RELEASED",
  "COUPON_APPLIED",
  "COUPON_REMOVED",
]);

export type CatalogEventType = (typeof catalogEventTypeEnum.enumValues)[number];
export type InventoryOperationType = (typeof inventoryOperationEnum.enumValues)[number];
export type ProductRelationType = (typeof productRelationTypeEnum.enumValues)[number];
export type PriceRuleType = (typeof priceRuleTypeEnum.enumValues)[number];
export type MediaKind = (typeof mediaKindEnum.enumValues)[number];
export type ProductVisibility = (typeof productVisibilityEnum.enumValues)[number];


/* ── Commerce ─────────────────────────────────────────────────────────── */
export const cartStatusEnum = pgEnum("cart_status", [
  "ACTIVE",
  "CONVERTED",
  "ABANDONED",
  "EXPIRED",
  "MERGED",
]);

export const addressTypeEnum = pgEnum("address_type", ["HOME", "WORK", "OTHER"]);

/**
 * Checkout preparation only. PAYMENT_PENDING / COMPLETED are reserved for a
 * future payment/order workflow and are not written by Part 15.
 */
export const checkoutStatusEnum = pgEnum("checkout_status", [
  "CREATED",
  "VALIDATING",
  "NEEDS_ATTENTION",
  "READY",
  "PAYMENT_PENDING",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

/* ── Orders (four independent status systems) ─────────────────────────── */
export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
  "ON_HOLD",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "PENDING",
  "AUTHORIZED",
  "PAID",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

export const fulfillmentStatusEnum = pgEnum("fulfillment_status", [
  "UNFULFILLED",
  "IN_PRODUCTION",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "CANCELLED",
]);

export const shipmentStatusEnum = pgEnum("shipment_status", [
  "NOT_SHIPPED",
  "LABEL_CREATED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "RETURNED",
]);

export const refundStatusEnum = pgEnum("refund_status", [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

/* ── POD ──────────────────────────────────────────────────────────────── */
export const podProviderStatusEnum = pgEnum("pod_provider_status", ["ACTIVE", "DISABLED", "TESTING"]);

export const podOrderStatusEnum = pgEnum("pod_order_status", [
  "DRAFT",
  "SUBMITTED",
  "ACCEPTED",
  "IN_PRODUCTION",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
]);

export const podEventTypeEnum = pgEnum("pod_event_type", [
  "ORDER_SUBMITTED",
  "ORDER_ACCEPTED",
  "IN_PRODUCTION",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "FAILED",
  "OTHER",
]);

/* ── Marketing & engagement ───────────────────────────────────────────── */
export const couponTypeEnum = pgEnum("coupon_type", ["PERCENTAGE", "FIXED_AMOUNT", "FREE_SHIPPING"]);

export const reviewStatusEnum = pgEnum("review_status", ["PENDING", "APPROVED", "REJECTED", "HIDDEN"]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "ORDER",
  "PAYMENT",
  "SHIPPING",
  "ACCOUNT",
  "PROMOTION",
  "SYSTEM",
]);

/* ── Support ──────────────────────────────────────────────────────────── */
export const ticketStatusEnum = pgEnum("ticket_status", [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "RESOLVED",
  "CLOSED",
]);

export const ticketPriorityEnum = pgEnum("ticket_priority", ["LOW", "NORMAL", "HIGH", "URGENT"]);

/* ── Analytics ────────────────────────────────────────────────────────── */
export const analyticsEventTypeEnum = pgEnum("analytics_event_type", [
  "PRODUCT_VIEW",
  "SEARCH",
  "ADD_TO_CART",
  "REMOVE_FROM_CART",
  "CHECKOUT_STARTED",
  "PURCHASE",
  "WISHLIST_ADD",
  /* ── Part 13: behavioural signals the recommender learns from ───────────
   * Added to this enum rather than a parallel table: one append-only event
   * stream is cheaper to reason about than two, and the recommender is just
   * another consumer of behaviour the storefront already had. */
  "PRODUCT_CLICK",
  "SEARCH_RESULT_CLICK",
  "WISHLIST_REMOVE",
  "RETURN",
  "SHARE",
  "COMPARE",
  "CATEGORY_VIEW",
  "BRAND_VIEW",
  "FILTER_USED",
  /* ── Part 14: persisted basket lifecycle signals ─────────────────────── */
  "CART_CREATED",
  "CART_ITEM_ADDED",
  "CART_ITEM_UPDATED",
  "CART_ITEM_REMOVED",
  "CART_ITEM_SAVED",
  "CART_ITEM_RESTORED",
  "CART_MERGED",
  "CART_RECONCILED",
  "CART_ABANDONED",
  "CART_CONVERTED",
  "WISHLIST_TO_CART",
  "CART_EXPIRED",
  /* ── Part 15: checkout preparation (no payment/order side-effects) ────── */
  "CHECKOUT_ADDRESS_SELECTED",
  "CHECKOUT_ADDRESS_CHANGED",
  "CHECKOUT_DELIVERY_SELECTED",
  "CHECKOUT_REVALIDATED",
  "CHECKOUT_NEEDS_ATTENTION",
  "CHECKOUT_READY",
  "CHECKOUT_CANCELLED",
  "CHECKOUT_EXPIRED",
  "CHECKOUT_FAILED",
  "CHECKOUT_COUPON_APPLIED",
  "CHECKOUT_COUPON_REMOVED",
]);

/* ── Part 13: recommendations ─────────────────────────────────────────── */

/**
 * Which question a recommendation request is answering.
 *
 * Kept as an enum rather than a free string because the ranking weights,
 * diversity budget and exclusion policy are all keyed off it — a caller
 * inventing a type would silently get the default treatment for every one.
 */
export const recommendationTypeEnum = pgEnum("recommendation_type", [
  "SIMILAR_PRODUCTS",
  "RELATED_PRODUCTS",
  "FREQUENTLY_BOUGHT_TOGETHER",
  "CUSTOMER_ALSO_BOUGHT",
  "CUSTOMER_ALSO_VIEWED",
  "TRENDING_PRODUCTS",
  "POPULAR_IN_CATEGORY",
  "RECENTLY_VIEWED",
  "CONTINUE_SHOPPING",
  "PERSONALIZED_FOR_YOU",
  "CART_RECOMMENDATIONS",
  "CHECKOUT_RECOMMENDATIONS",
  "POST_PURCHASE_RECOMMENDATIONS",
  "CROSS_SELL",
  "UPSELL",
  "NEW_USER_RECOMMENDATIONS",
  "ANONYMOUS_RECOMMENDATIONS",
]);

/** What happened to a recommendation after it was shown. */
export const recommendationEventTypeEnum = pgEnum("recommendation_event_type", [
  "SHOWN",
  "CLICKED",
  "ADDED_TO_CART",
  "PURCHASED",
]);

/** The axis a user-interest weight is recorded against. */
export const interestDimensionEnum = pgEnum("interest_dimension", [
  "CATEGORY",
  "BRAND",
  "PRODUCT",
  "ATTRIBUTE",
  "PRICE_BAND",
  "PRODUCT_TYPE",
]);

/** Which slice of the catalog a popularity score describes. */
export const popularityScopeEnum = pgEnum("popularity_scope", [
  "GLOBAL",
  "CATEGORY",
  "BRAND",
]);
