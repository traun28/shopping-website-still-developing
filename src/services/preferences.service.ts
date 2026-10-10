import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { marketingConsentEvents, userPreferences, users, type UserPreferences } from "@/db/schema";
import { withTransaction } from "@/db/utils";
import { writeAudit } from "@/services/audit.service";
import type { PreferencesInput } from "@/validations/account";

/**
 * Account preferences — read defaults and persist changes against the existing
 * per-user preferences row. Marketing email consent is opt-in, separately
 * recorded as an append-only event; transactional order notices never imply it.
 */

export type PreferencesDTO = Pick<
  UserPreferences,
  | "marketingEmails"
  | "orderNotifications"
  | "promotionalNotifications"
  | "language"
  | "currency"
  | "measurementSystem"
>;

export const DEFAULT_PREFERENCES: PreferencesDTO = {
  marketingEmails: false,
  orderNotifications: true,
  promotionalNotifications: false,
  language: "en-IN",
  currency: "INR",
  measurementSystem: "METRIC",
};

const MARKETING_POLICY_VERSION = "marketing-email-opt-in-v1";

export async function getPreferences(userId: string): Promise<PreferencesDTO> {
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (!row) return DEFAULT_PREFERENCES;
  return {
    marketingEmails: row.marketingEmails,
    orderNotifications: row.orderNotifications,
    promotionalNotifications: row.promotionalNotifications,
    language: row.language,
    currency: row.currency,
    measurementSystem: row.measurementSystem as PreferencesDTO["measurementSystem"],
  };
}

export async function savePreferences(
  userId: string,
  input: PreferencesInput,
  options: { source?: "ACCOUNT_SETTINGS" | "ACCOUNT_API" } = {},
): Promise<PreferencesDTO> {
  let marketingConsentChanged = false;
  await withTransaction(async (tx) => {
    // Serialize first-save races as well as changes to the existing row.
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    if (!owner) return;
    const [existing] = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .for("update");
    const previousMarketingConsent = existing?.marketingEmails ?? false;
    marketingConsentChanged = previousMarketingConsent !== input.marketingEmails;

    await tx
      .insert(userPreferences)
      .values({ userId, ...input })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          marketingEmails: input.marketingEmails,
          orderNotifications: input.orderNotifications,
          promotionalNotifications: input.promotionalNotifications,
          language: input.language,
          currency: input.currency,
          measurementSystem: input.measurementSystem,
          updatedAt: new Date(),
        },
      });

    if (marketingConsentChanged) {
      await tx.insert(marketingConsentEvents).values({
        userId,
        consented: input.marketingEmails,
        source: options.source ?? "ACCOUNT_SETTINGS",
        policyVersion: MARKETING_POLICY_VERSION,
      });
    }
  });

  await writeAudit({
    action: "user.preferences_updated",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: {
      fields: ["marketingEmails", "orderNotifications", "promotionalNotifications", "language", "currency", "measurementSystem"],
      marketingConsentChanged,
      source: options.source ?? "ACCOUNT_SETTINGS",
    },
  });
  return getPreferences(userId);
}
