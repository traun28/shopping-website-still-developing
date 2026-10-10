import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkoutStatusEnum } from "./enums";
import { idColumn, timestamps } from "./helpers";
import { addresses, users } from "./users";
import { carts } from "./commerce";

/** Private checkout-only copy of an address; no address is considered verified. */
export interface CheckoutAddressSnapshot {
  source: "SAVED" | "INLINE";
  sourceAddressId: string | null;
  sourceAddressVersion: number | null;
  sourceAddressUpdatedAt: string | null;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  locality: string | null;
  landmark: string | null;
  deliveryInstructions: string | null;
  city: string;
  state: string | null;
  postalCode: string | null;
  country: string;
  addressType: "HOME" | "WORK" | "OTHER";
}

export interface CheckoutContactSnapshot {
  name: string;
  email: string;
  phone: string;
}

export interface CheckoutItemSnapshot {
  cartItemId: string;
  productId: string;
  variantId: string;
  sellerId: string | null;
  sellerName: string | null;
  productName: string;
  variantName: string;
  quantity: number;
  currency: string;
  unitPricePaise: number | null;
  lineSubtotalPaise: number | null;
  lineDiscountPaise: number;
  estimatedTaxPaise: number;
}

export type CheckoutIssueSeverity = "BLOCKING" | "WARNING";

export interface CheckoutIssueSnapshot {
  code: string;
  severity: CheckoutIssueSeverity;
  message: string;
  itemId?: string;
  productId?: string;
}

export interface CheckoutDeliveryOptionSnapshot {
  id: string;
  name: string;
  description: string;
  currency: string;
  amountPaise: number | null;
  quoteId: string;
  validUntil: string | null;
  estimateOnly: boolean;
}

export interface CheckoutTotalsSnapshot {
  currency: string;
  /** Pre-discount list-price subtotal for transparent savings display. */
  listSubtotalPaise: number;
  /** Current merchandise subtotal after server-applied product/cart discounts. */
  subtotalPaise: number;
  discountPaise: number;
  estimatedTaxPaise: number | null;
  shippingPaise: number | null;
  totalEstimatePaise: number | null;
  taxStatus: "AUTHORITATIVE" | "CATALOG_ESTIMATE" | "UNAVAILABLE";
  deliveryStatus: "AVAILABLE" | "NOT_CONFIGURED";
  isFinal: false;
}

/**
 * A versioned customer-owned checkout preparation record. Its JSON snapshots
 * are private PII-bearing operational data and are never included in analytics
 * or admin aggregate views.
 */
export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    ...idColumn,
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** SHA-256 digest of the existing HttpOnly guest-cart bearer cookie. */
    guestSessionHash: text("guest_session_hash"),
    cartId: uuid("cart_id").references(() => carts.id, { onDelete: "set null" }),
    createIdempotencyKey: text("create_idempotency_key").notNull(),
    createRequestHash: text("create_request_hash").notNull(),
    status: checkoutStatusEnum("status").notNull().default("CREATED"),
    version: integer("version").notNull().default(1),
    cartVersion: integer("cart_version").notNull().default(0),
    currency: text("currency").notNull().default("INR"),
    /** Optional server-resolved coupon; never trusted as a price or eligibility input. */
    couponId: uuid("coupon_id"),
    couponCode: text("coupon_code"),
    contactSnapshot: jsonb("contact_snapshot").$type<CheckoutContactSnapshot | null>(),

    shippingAddressId: uuid("shipping_address_id").references(() => addresses.id, { onDelete: "set null" }),
    shippingAddressSnapshot: jsonb("shipping_address_snapshot").$type<CheckoutAddressSnapshot | null>(),
    billingAddressId: uuid("billing_address_id").references(() => addresses.id, { onDelete: "set null" }),
    billingAddressSnapshot: jsonb("billing_address_snapshot").$type<CheckoutAddressSnapshot | null>(),
    billingSameAsShipping: boolean("billing_same_as_shipping").notNull().default(true),
    selectedDeliveryMethodId: text("selected_delivery_method_id"),
    selectedDeliverySnapshot: jsonb("selected_delivery_snapshot").$type<CheckoutDeliveryOptionSnapshot | null>(),
    itemsSnapshot: jsonb("items_snapshot").$type<CheckoutItemSnapshot[]>().notNull().default([]),
    totalsSnapshot: jsonb("totals_snapshot").$type<CheckoutTotalsSnapshot | null>(),
    validationIssues: jsonb("validation_issues").$type<CheckoutIssueSnapshot[]>().notNull().default([]),
    validatedAt: timestamp("validated_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Address/contact snapshots are redacted after this bounded retention window. */
    piiPurgeAt: timestamp("pii_purge_at", { withTimezone: true, mode: "date" }).notNull(),
    piiPurgedAt: timestamp("pii_purged_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("checkout_sessions_user_status_expires_idx").on(table.userId, table.status, table.expiresAt),
    index("checkout_sessions_guest_status_expires_idx").on(table.guestSessionHash, table.status, table.expiresAt),
    index("checkout_sessions_cart_status_idx").on(table.cartId, table.status),
    uniqueIndex("checkout_sessions_user_create_key").on(table.userId, table.createIdempotencyKey).where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("checkout_sessions_guest_create_key").on(table.guestSessionHash, table.createIdempotencyKey).where(sql`${table.guestSessionHash} IS NOT NULL`),
    check("checkout_sessions_version_positive", sql`${table.version} > 0`),
    check("checkout_sessions_cart_version_non_negative", sql`${table.cartVersion} >= 0`),
    check("checkout_sessions_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("checkout_sessions_guest_hash_shape", sql`${table.guestSessionHash} IS NULL OR ${table.guestSessionHash} ~ '^[a-f0-9]{64}$'`),
    check("checkout_sessions_create_key_length", sql`length(${table.createIdempotencyKey}) BETWEEN 8 AND 128`),
  ],
);

/** Request de-duplication metadata contains no customer address or response body. */
export const checkoutMutationKeys = pgTable(
  "checkout_mutation_keys",
  {
    ...idColumn,
    checkoutSessionId: uuid("checkout_session_id")
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("checkout_mutation_keys_session_key").on(table.checkoutSessionId, table.key),
    index("checkout_mutation_keys_expiry_idx").on(table.expiresAt),
    check("checkout_mutation_keys_key_length", sql`length(${table.key}) BETWEEN 8 AND 128`),
  ],
);

export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;
export type CheckoutMutationKey = typeof checkoutMutationKeys.$inferSelect;
