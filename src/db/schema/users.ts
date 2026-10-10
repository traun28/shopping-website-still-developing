import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex, timestamp, uuid } from "drizzle-orm/pg-core";
import { addressTypeEnum, userRoleEnum, userStatusEnum } from "./enums";
import { idColumn, timestamps } from "./helpers";

/**
 * Users — one row per human: customers and staff share the table,
 * separated by `role`. Passwords are ONLY ever stored as hashes
 * (scrypt/argon from the auth layer); OAuth-only users may have a null
 * hash.
 */
export const users = pgTable(
  "users",
  {
    ...idColumn,
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    /** Never a plain-text password. Null for OAuth-only accounts. */
    passwordHash: text("password_hash"),
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    /** CDN/storage URL of the user's avatar (never a filesystem path). */
    avatarUrl: text("avatar_url"),
    /** Email pending verification for the secure email-change flow. */
    pendingEmail: text("pending_email"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    /**
     * Bumped on password change/reset or security events. Embedded in
     * the session JWT — a mismatch invalidates the session server-side
     * without needing a session table.
     */
    securityStamp: integer("security_stamp").notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_key").on(table.email), index("users_role_idx").on(table.role)],
);

/** Reusable addresses — a customer can store many; orders snapshot them. */
export const addresses = pgTable(
  "addresses",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    locality: text("locality"),
    city: text("city").notNull(),
    /** State, province, prefecture or region; optional outside jurisdictions that require it. */
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("IN"),
    landmark: text("landmark"),
    deliveryInstructions: text("delivery_instructions"),
    addressType: addressTypeEnum("address_type").notNull().default("HOME"),
    /** Legacy column name retained; this is the default shipping address. */
    isDefault: boolean("is_default").notNull().default(false),
    isDefaultBilling: boolean("is_default_billing").notNull().default(false),
    /** Optimistic concurrency for an address-book edit. */
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("addresses_user_id_idx").on(table.userId),
    uniqueIndex("addresses_user_default_shipping_key").on(table.userId).where(sql`${table.isDefault} = true`),
    uniqueIndex("addresses_user_default_billing_key").on(table.userId).where(sql`${table.isDefaultBilling} = true`),
    check("addresses_country_iso_code", sql`${table.country} ~ '^[A-Z]{2}$'`),
    check("addresses_version_positive", sql`${table.version} > 0`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
