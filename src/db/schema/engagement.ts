import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { couponTypeEnum, notificationTypeEnum, reviewStatusEnum } from "./enums";
import { idColumn, moneyNullable, moneyZero, timestamps, timestampsNoUpdate } from "./helpers";
import { categories, collections, products } from "./catalog";
import { orders } from "./orders";
import { checkoutSessions } from "./checkout";
import { users } from "./users";

/* ── Promotion campaigns and promotion rules ─────────────────────────── */
export const promotionCampaigns = pgTable(
  "promotion_campaigns",
  {
    ...idColumn,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: text("status").notNull().default("DRAFT"),
    timezone: text("timezone").notNull().default("UTC"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("promotion_campaigns_slug_key").on(table.slug),
    index("promotion_campaigns_status_window_idx").on(table.status, table.startsAt, table.endsAt),
    check("promotion_campaigns_status_valid", sql`${table.status} IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')`),
    check("promotion_campaigns_version_positive", sql`${table.version} > 0`),
    check("promotion_campaigns_window_valid", sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
  ],
);

export const promotions = pgTable(
  "promotions",
  {
    ...idColumn,
    campaignId: uuid("campaign_id").references(() => promotionCampaigns.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    strategy: text("strategy").notNull(),
    status: text("status").notNull().default("DRAFT"),
    discountConfig: jsonb("discount_config").$type<Record<string, unknown>>().notNull(),
    eligibility: jsonb("eligibility").$type<Record<string, unknown>>().notNull().default({}),
    priority: integer("priority").notNull().default(100),
    stackable: boolean("stackable").notNull().default(false),
    stackGroup: text("stack_group"),
    isAutomatic: boolean("is_automatic").notNull().default(true),
    applyToCatalog: boolean("apply_to_catalog").notNull().default(false),
    currency: text("currency").notNull().default("INR"),
    totalUsageLimit: integer("total_usage_limit"),
    perCustomerUsageLimit: integer("per_customer_usage_limit"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
    timezone: text("timezone").notNull().default("UTC"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => [
    index("promotions_status_window_idx").on(table.status, table.startsAt, table.endsAt),
    index("promotions_campaign_idx").on(table.campaignId, table.status),
    check("promotions_strategy_valid", sql`${table.strategy} IN ('PERCENTAGE_OFF', 'FIXED_AMOUNT_OFF', 'CART_THRESHOLD', 'QUANTITY_TIER', 'BUY_X_GET_Y', 'BUNDLE', 'FREE_SHIPPING')`),
    check("promotions_status_valid", sql`${table.status} IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED', 'ARCHIVED')`),
    check("promotions_priority_non_negative", sql`${table.priority} >= 0`),
    check("promotions_version_positive", sql`${table.version} > 0`),
    check("promotions_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("promotions_total_limit_positive", sql`${table.totalUsageLimit} IS NULL OR ${table.totalUsageLimit} > 0`),
    check("promotions_customer_limit_positive", sql`${table.perCustomerUsageLimit} IS NULL OR ${table.perCustomerUsageLimit} > 0`),
    check("promotions_window_valid", sql`${table.startsAt} IS NULL OR ${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`),
    check("promotions_catalog_automatic_only", sql`${table.applyToCatalog} = false OR (${table.isAutomatic} = true AND ${table.totalUsageLimit} IS NULL AND ${table.perCustomerUsageLimit} IS NULL)`),
  ],
);

/** Normalized targeting for product/catalog and explicit customer assignments. */
export const promotionTargets = pgTable(
  "promotion_targets",
  {
    promotionId: uuid("promotion_id").notNull().references(() => promotions.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    entityId: uuid("entity_id").notNull(),
    mode: text("mode").notNull().default("INCLUDE"),
  },
  (table) => [
    primaryKey({ columns: [table.promotionId, table.dimension, table.entityId, table.mode] }),
    index("promotion_targets_entity_idx").on(table.dimension, table.entityId, table.promotionId),
    check("promotion_targets_dimension_valid", sql`${table.dimension} IN ('PRODUCT', 'CATEGORY', 'BRAND', 'SELLER', 'COLLECTION', 'CUSTOMER')`),
    check("promotion_targets_mode_valid", sql`${table.mode} IN ('INCLUDE', 'EXCLUDE')`),
  ],
);

/** Immutable config snapshots; version rows and outbox events are written with admin mutations. */
export const promotionVersions = pgTable(
  "promotion_versions",
  {
    ...idColumn,
    promotionId: uuid("promotion_id").references(() => promotions.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => promotionCampaigns.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("promotion_versions_promotion_version_key").on(table.promotionId, table.version).where(sql`${table.promotionId} IS NOT NULL`),
    uniqueIndex("promotion_versions_campaign_version_key").on(table.campaignId, table.version).where(sql`${table.campaignId} IS NOT NULL`),
    check("promotion_versions_one_owner", sql`(${table.promotionId} IS NOT NULL) <> (${table.campaignId} IS NOT NULL)`),
    check("promotion_versions_version_positive", sql`${table.version} > 0`),
  ],
);

/* ── Coupons ──────────────────────────────────────────────────────────── */
export const coupons = pgTable(
  "coupons",
  {
    ...idColumn,
    /** Stored uppercase by the application layer; case-insensitive unique index is also enforced. */
    code: text("code").notNull(),
    promotionId: uuid("promotion_id").references(() => promotions.id, { onDelete: "set null" }),
    type: couponTypeEnum("type").notNull(),
    /** PERCENTAGE → 0–100; FIXED_AMOUNT → minor units; FREE_SHIPPING → 0. */
    value: integer("value").notNull(),
    minimumOrderAmount: moneyNullable("minimum_order_amount"),
    maximumDiscountAmount: moneyNullable("maximum_discount_amount"),
    usageLimit: integer("usage_limit"),
    perUserLimit: integer("per_user_limit"),
    usageCount: integer("usage_count").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("coupons_code_key").on(table.code),
    uniqueIndex("coupons_code_normalized_key").on(sql`upper(${table.code})`),
    index("coupons_promotion_idx").on(table.promotionId),
    index("coupons_active_idx").on(table.isActive),
    check("coupons_value_non_negative", sql`${table.value} >= 0`),
    check("coupons_percentage_range", sql`${table.type} != 'PERCENTAGE' OR ${table.value} <= 100`),
  ],
);

/** Every redemption (who used what, on which order). */
export const couponUsages = pgTable(
  "coupon_usages",
  {
    ...idColumn,
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    discountApplied: moneyZero("discount_applied"),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("coupon_usages_coupon_idx").on(table.couponId),
    index("coupon_usages_user_idx").on(table.userId),
  ],
);

/** Temporary use holds; only a future trusted order/payment event may finalize redemption. */
export const promotionRedemptions = pgTable(
  "promotion_redemptions",
  {
    ...idColumn,
    promotionId: uuid("promotion_id").notNull().references(() => promotions.id, { onDelete: "restrict" }),
    couponId: uuid("coupon_id").references(() => coupons.id, { onDelete: "set null" }),
    checkoutSessionId: uuid("checkout_session_id").notNull().references(() => checkoutSessions.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("RESERVED"),
    discountPaise: moneyZero("discount_paise"),
    currency: text("currency").notNull().default("INR"),
    allocations: jsonb("allocations").$type<Array<{ cartItemId: string; productId: string; amountPaise: number }>>().notNull().default([]),
    reservedAt: timestamp("reserved_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("promotion_redemptions_idempotency_key").on(table.idempotencyKey),
    uniqueIndex("promotion_redemptions_checkout_active_key")
      .on(table.checkoutSessionId, table.promotionId)
      .where(sql`${table.status} = 'RESERVED'`),
    index("promotion_redemptions_capacity_idx").on(table.promotionId, table.status, table.expiresAt),
    index("promotion_redemptions_coupon_customer_idx").on(table.couponId, table.userId, table.status),
    index("promotion_redemptions_checkout_idx").on(table.checkoutSessionId, table.status),
    check("promotion_redemptions_status_valid", sql`${table.status} IN ('RESERVED', 'REDEEMED', 'RELEASED', 'EXPIRED')`),
    check("promotion_redemptions_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("promotion_redemptions_discount_paise_non_negative", sql`${table.discountPaise} >= 0`),
    check("promotion_redemptions_order_redeemed_only", sql`${table.status} != 'REDEEMED' OR ${table.orderId} IS NOT NULL`),
    check("promotion_redemptions_release_timestamp", sql`${table.status} NOT IN ('RELEASED', 'EXPIRED') OR ${table.releasedAt} IS NOT NULL`),
  ],
);

/* ── Coupon targeting (empty set of a dimension = unrestricted) ───────── */
export const couponProducts = pgTable(
  "coupon_products",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.productId] })],
);

export const couponCategories = pgTable(
  "coupon_categories",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.categoryId] })],
);

export const couponCollections = pgTable(
  "coupon_collections",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.collectionId] })],
);

export const couponCustomers = pgTable(
  "coupon_customers",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.couponId, table.userId] })],
);

/* ── Reviews ──────────────────────────────────────────────────────────── */
export const reviews = pgTable(
  "reviews",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Purchase link powers verified-preview logic — set null keeps the
     *  review if the order row is ever removed. */
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    title: text("title"),
    content: text("content"),
    status: reviewStatusEnum("status").notNull().default("PENDING"),
    verifiedPurchase: boolean("verified_purchase").notNull().default(false),
    helpfulCount: integer("helpful_count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("reviews_product_idx").on(table.productId),
    index("reviews_status_idx").on(table.status),
    uniqueIndex("reviews_unique_per_order").on(table.userId, table.productId, table.orderId),
    check("reviews_rating_range", sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

/* ── Notifications ────────────────────────────────────────────────────── */
export const notifications = pgTable(
  "notifications",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    linkHref: text("link_href"),
    /** Read state is timestamp-based (readAt NULL = unread). */
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    index("notifications_user_idx").on(table.userId),
    index("notifications_user_unread_idx").on(table.userId, table.readAt),
  ],
);

export type PromotionCampaign = typeof promotionCampaigns.$inferSelect;
export type Promotion = typeof promotions.$inferSelect;
export type PromotionTargetRow = typeof promotionTargets.$inferSelect;
export type PromotionRedemption = typeof promotionRedemptions.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
