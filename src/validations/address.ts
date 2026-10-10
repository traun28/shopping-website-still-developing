import { z } from "zod";

export const ADDRESS_TYPES = ["HOME", "WORK", "OTHER"] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const requiredText = (message: string, min = 2, max = 120) =>
  z.string().trim().min(min, message).max(max);
const countryCode = z.string().trim().regex(/^[A-Za-z]{2}$/, "Enter a two-letter country code (for example, IN or US).").transform((value) => value.toUpperCase());
const phoneText = z
  .string()
  .trim()
  .min(7, "Enter a valid phone number.")
  .max(32, "That phone number looks too long.")
  .regex(/^\+?[0-9\s().-]+$/, "Use digits and an optional leading + in the phone number.");

const requiredAddressFields = {
  fullName: requiredText("Enter the recipient's full name.", 2, 80),
  phone: phoneText,
  addressLine1: requiredText("Enter your street address.", 3, 120),
  addressLine2: optionalText(120),
  locality: optionalText(100),
  landmark: optionalText(120),
  deliveryInstructions: optionalText(240),
  city: requiredText("Enter your city or town.", 2, 80),
  state: optionalText(80),
  postalCode: optionalText(20),
  country: countryCode,
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function validateAddressFields(
  value: {
    fullName?: string;
    phone?: string;
    addressLine1?: string;
    addressLine2?: string;
    locality?: string;
    landmark?: string;
    deliveryInstructions?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  },
  ctx: z.RefinementCtx,
) {
  for (const [field, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /[\u0000-\u001f\u007f]/u.test(entry)) {
      ctx.addIssue({ code: "custom", path: [field], message: "Remove control characters from this field." });
    }
  }

  const country = value.country?.toUpperCase();
  const phone = value.phone ?? "";
  const digits = digitsOnly(phone);
  const validPhoneLength = digits.length >= 7 && digits.length <= 15;
  const validIndiaPhone = country !== "IN" ||
    ((digits.length === 10 && /^[6-9]/.test(digits)) ||
      (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))));
  if (!validPhoneLength || !validIndiaPhone) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: country === "IN" ? "Enter a valid Indian mobile number." : "Enter a phone number with 7 to 15 digits." });
  }

  const state = value.state?.trim() ?? "";
  const postal = value.postalCode?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  if (country === "IN") {
    if (state.length < 2) ctx.addIssue({ code: "custom", path: ["state"], message: "Enter your state or union territory." });
    if (!/^[1-9]\d{5}$/.test(postal)) {
      ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid 6-digit Indian PIN code." });
    }
  } else if (country === "US" && postal && !/^\d{5}(?:-\d{4})?$/.test(postal)) {
    ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid ZIP code." });
  } else if (country === "CA" && postal && !/^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/.test(postal)) {
    ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid Canadian postal code." });
  } else if (country === "GB" && postal && !/^(GIR 0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/.test(postal)) {
    ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid UK postcode." });
  } else if (postal && !/^[\p{L}\p{N}][\p{L}\p{N} -]{1,18}[\p{L}\p{N}]$/u.test(postal)) {
    ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid postal code." });
  }
}

const addressFields = z.object(requiredAddressFields).strict();

/** Complete, normalized delivery address input. This validates format, not physical existence. */
export const addressSchema = addressFields
  .extend({
    addressType: z.enum(ADDRESS_TYPES).default("HOME"),
    isDefaultShipping: z.boolean().default(false),
    isDefaultBilling: z.boolean().default(false),
    expectedVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine(validateAddressFields);

/** Partial address-book edit. The service merges it with the owner's current row and validates the whole address. */
export const addressPatchSchema = z
  .object({
    fullName: requiredAddressFields.fullName.optional(),
    phone: phoneText.optional(),
    addressLine1: requiredAddressFields.addressLine1.optional(),
    addressLine2: optionalText(120),
    locality: optionalText(100),
    landmark: optionalText(120),
    deliveryInstructions: optionalText(240),
    city: requiredAddressFields.city.optional(),
    state: optionalText(80),
    postalCode: optionalText(20),
    country: countryCode.optional(),
    addressType: z.enum(ADDRESS_TYPES).optional(),
    isDefaultShipping: z.boolean().optional(),
    isDefaultBilling: z.boolean().optional(),
    expectedVersion: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), "Choose at least one address field to update.");

export type AddressInput = z.infer<typeof addressSchema>;
export type AddressPatchInput = z.infer<typeof addressPatchSchema>;

/** Opaque, conservative normalization used for persistence and duplicate hints only. */
export function normalizeAddressText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function normalizeAddressPhone(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/[\s().-]/g, "");
  return normalized.startsWith("+") ? `+${digitsOnly(normalized)}` : digitsOnly(normalized);
}

export function normalizePostalCode(country: string, value: string | null | undefined): string | null {
  const trimmed = value?.normalize("NFKC").trim();
  if (!trimmed) return null;
  const normalized = trimmed.toUpperCase().replace(/\s+/g, country.toUpperCase() === "IN" ? "" : " ");
  return normalized || null;
}
