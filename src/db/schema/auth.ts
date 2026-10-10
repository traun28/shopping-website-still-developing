import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn, timestamps } from "./helpers";
import { users } from "./users";

/**
 * Auth-support tables.
 * Sessions themselves are stateless JWTs (Auth.js) — no session table.
 * These tables cover what must be durable and server-controlled.
 */

export const authTokenTypeEnum = pgEnum("auth_token_type", [
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "EMAIL_CHANGE",
]);

/**
 * One-time credential tokens. The RAW token is only ever sent via email
 * (or logged in development); the database stores its SHA-256 hash so a
 * database leak can never mint a usable link.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: authTokenTypeEnum("type").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Set when the token is used or superseded — single-use guarantee. */
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_tokens_hash_key").on(table.tokenHash),
    index("auth_tokens_user_type_idx").on(table.userId, table.type),
  ],
);

/**
 * Database-backed rate limiting — fixed-window counters keyed by
 * "bucket:identity". Unlike in-memory limiting, this is correct across
 * multiple application instances (and survives restarts).
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    hits: integer("hits").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("rate_limits_reset_at_idx").on(table.resetAt)],
);

/**
 * User preferences — persisted account settings. One row per user,
 * created lazily on first save. Values are ALWAYS read through
 * `getPreferences()` which falls back to defaults.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Explicit opt-in only; account creation and order updates do not imply consent. */
    marketingEmails: boolean("marketing_emails").notNull().default(false),
    orderNotifications: boolean("order_notifications").notNull().default(true),
    promotionalNotifications: boolean("promotional_notifications").notNull().default(false),
    /** BCP-47, e.g. "en-IN" — international-ready. */
    language: text("language").notNull().default("en-IN"),
    currency: text("currency").notNull().default("INR"),
    measurementSystem: text("measurement_system").notNull().default("METRIC"),
    /** Extensible for future privacy toggles without new columns. */
    extras: jsonb("extras").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("user_preferences_user_idx").on(table.userId),
    check("user_preferences_measurement_system", sql`${table.measurementSystem} IN ('METRIC', 'IMPERIAL')`),
  ],
);

/** Append-only evidence for explicit marketing email consent changes. */
export const marketingConsentEvents = pgTable(
  "marketing_consent_events",
  {
    ...idColumn,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    consented: boolean("consented").notNull(),
    source: text("source").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("marketing_consent_events_user_created_idx").on(table.userId, table.createdAt)],
);

export type AuthToken = typeof authTokens.$inferSelect;
export type AuthTokenType = (typeof authTokenTypeEnum.enumValues)[number];
export type UserPreferences = typeof userPreferences.$inferSelect;
export type MarketingConsentEvent = typeof marketingConsentEvents.$inferSelect;
