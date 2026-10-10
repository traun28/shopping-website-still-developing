import { z } from "zod";
import { emailSchema, internationalPhoneSchema } from "@/validations/auth";

export { addressSchema, addressPatchSchema } from "@/validations/address";
export type { AddressInput, AddressPatchInput } from "@/validations/address";

/**
 * Account-domain validation — enforced on the server (mirrored in the
 * client only for feedback speed). The address model is country-aware and
 * keeps non-Indian administrative areas free-form.
 */

/* Indian states remain available as optional suggestions in the UI. */
export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Delhi (NCT)", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jammu & Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Puducherry", "Chandigarh",
  "Andaman & Nicobar Islands", "Dadra & Nagar Haveli and Daman & Diu", "Lakshadweep",
] as const;

export const emailChangeRequestSchema = z.object({
  newEmail: emailSchema,
});

export const deactivateAccountSchema = z.object({
  password: z.string().min(1, "Enter your current password to confirm."),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export const preferencesSchema = z.object({
  marketingEmails: z.boolean().default(false),
  orderNotifications: z.boolean().default(true),
  promotionalNotifications: z.boolean().default(false),
  language: z.enum(["en-IN", "hi-IN"]).default("en-IN"),
  currency: z.literal("INR").default("INR"),
  measurementSystem: z.enum(["METRIC", "IMPERIAL"]).default("METRIC"),
});

export const preferencesPatchSchema = preferencesSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Choose at least one preference to update.",
);

export const avatarMetaSchema = z.object({
  type: z.enum(["image/jpeg", "image/png", "image/webp"], {
    message: "Use a JPG, PNG or WebP image.",
  }),
  size: z.number().max(2 * 1024 * 1024, "Keep the image under 2 MB."),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;
export type PreferencesPatchInput = z.infer<typeof preferencesPatchSchema>;

export { internationalPhoneSchema };
