import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cartStatusEnum } from "./enums";
import { idColumn, money, timestamps, timestampsNoUpdate } from "./helpers";
import { products, productVariants } from "./catalog";
import { users } from "./users";

/* ── Cart ─────────────────────────────────────────────────────────────── */
export const carts = pgTable(
  "carts",
  {
    ...idColumn,
    /** Registered owner; null for guest carts. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 digest of the opaque HttpOnly guest-cart cookie; never the cookie itself. */
    sessionId: text("session_id"),
    currency: text("currency").notNull().default("INR"),
    status: cartStatusEnum("status").notNull().default("ACTIVE"),
    /** Optimistic concurrency version, bumped by every committed mutation. */
    version: integer("version").notNull().default(1),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (table) => [
    index("carts_user_idx").on(table.userId),
    index("carts_session_idx").on(table.sessionId),
    index("carts_status_idx").on(table.status),
    index("carts_abandonment_idx").on(table.status, table.lastActivityAt).where(sql`${table.status} = 'ACTIVE'`),
    uniqueIndex("carts_user_active_key").on(table.userId).where(sql`${table.status} = 'ACTIVE' AND ${table.userId} IS NOT NULL`),
    uniqueIndex("carts_session_active_key").on(table.sessionId).where(sql`${table.status} = 'ACTIVE' AND ${table.sessionId} IS NOT NULL`),
    check("carts_version_positive", sql`${table.version} > 0`),
    check("carts_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    ...idColumn,
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    /** Current owner/seller snapshot, retained even if listing ownership changes. */
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull(),
    /** Server-observed unit selling price in minor units; never client-authoritative. */
    unitPrice: money("unit_price"),
    currency: text("currency").notNull().default("INR"),
    attributionSource: text("attribution_source"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("cart_items_cart_variant_key").on(table.cartId, table.variantId),
    index("cart_items_cart_idx").on(table.cartId),
    index("cart_items_product_variant_idx").on(table.productId, table.variantId),
    check("cart_items_quantity_positive", sql`${table.quantity} > 0`),
    check("cart_items_unit_price_non_negative", sql`${table.unitPrice} >= 0`),
    check("cart_items_version_positive", sql`${table.version} > 0`),
    check("cart_items_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Save for Later is separate from a wishlist and remains attached to the cart owner. */
export const savedItems = pgTable(
  "saved_items",
  {
    ...idColumn,
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    sellerId: uuid("seller_id").references(() => users.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull(),
    /** Last price observed by the server, useful for explaining later changes. */
    unitPrice: money("unit_price"),
    currency: text("currency").notNull().default("INR"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("saved_items_cart_variant_key").on(table.cartId, table.variantId),
    index("saved_items_cart_idx").on(table.cartId, table.createdAt),
    check("saved_items_quantity_positive", sql`${table.quantity} > 0`),
    check("saved_items_unit_price_non_negative", sql`${table.unitPrice} >= 0`),
    check("saved_items_currency_iso_code", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Persisted idempotency results: retries replay the original result, not the mutation. */
export const cartMutationKeys = pgTable(
  "cart_mutation_keys",
  {
    ...idColumn,
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("cart_mutation_keys_cart_key").on(table.cartId, table.key),
    index("cart_mutation_keys_expiry_idx").on(table.expiresAt),
    check("cart_mutation_keys_key_length", sql`length(${table.key}) BETWEEN 8 AND 128`),
  ],
);

/* ── Wishlist ─────────────────────────────────────────────────────────── */
export const wishlists = pgTable(
  "wishlists",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Saved items"),
    ...timestampsNoUpdate,
  },
  (table) => [uniqueIndex("wishlists_user_name_key").on(table.userId, table.name)],
);

export const wishlistItems = pgTable(
  "wishlist_items",
  {
    ...idColumn,
    wishlistId: uuid("wishlist_id")
      .notNull()
      .references(() => wishlists.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Legacy optional preferred variant; uniqueness and wishlist identity are product-only. */
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    ...timestampsNoUpdate,
  },
  (table) => [
    uniqueIndex("wishlist_items_unique_product").on(table.wishlistId, table.productId),
    index("wishlist_items_wishlist_idx").on(table.wishlistId),
  ],
);

export type Cart = typeof carts.$inferSelect;
export type CartItem = typeof cartItems.$inferSelect;
export type SavedItem = typeof savedItems.$inferSelect;
export type CartMutationKey = typeof cartMutationKeys.$inferSelect;
export type Wishlist = typeof wishlists.$inferSelect;
export type WishlistItem = typeof wishlistItems.$inferSelect;
