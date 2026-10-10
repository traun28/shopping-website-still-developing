import "server-only";
import { ValidationError } from "@/lib/errors";
import {
  addressSchema,
  normalizeAddressPhone,
  normalizeAddressText,
  normalizePostalCode,
  type AddressInput,
} from "@/validations/address";

export interface NormalizedAddressInput extends AddressInput {
  addressLine2: string;
  locality: string;
  landmark: string;
  deliveryInstructions: string;
  state: string;
  postalCode: string;
}

/**
 * Country-aware format validation and normalization. This deliberately does
 * not claim to verify that a physical address exists or can be delivered to.
 */
export class AddressValidationService {
  validate(input: unknown): NormalizedAddressInput {
    const parsed = addressSchema.safeParse(input);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Check the address details.";
      throw new ValidationError(message, parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })));
    }

    const address = parsed.data;
    const country = address.country.toUpperCase();
    return {
      ...address,
      fullName: normalizeAddressText(address.fullName),
      phone: normalizeAddressPhone(address.phone),
      addressLine1: normalizeAddressText(address.addressLine1),
      addressLine2: normalizeAddressText(address.addressLine2 ?? ""),
      locality: normalizeAddressText(address.locality ?? ""),
      landmark: normalizeAddressText(address.landmark ?? ""),
      deliveryInstructions: normalizeAddressText(address.deliveryInstructions ?? ""),
      city: normalizeAddressText(address.city),
      state: normalizeAddressText(address.state ?? ""),
      postalCode: normalizePostalCode(country, address.postalCode) ?? "",
      country,
    };
  }

  /** Likely duplicate hint only. Never merges or deletes addresses automatically. */
  likelyDuplicate(a: Pick<NormalizedAddressInput, "addressLine1" | "addressLine2" | "locality" | "city" | "state" | "postalCode" | "country">,
    b: Pick<NormalizedAddressInput, "addressLine1" | "addressLine2" | "locality" | "city" | "state" | "postalCode" | "country">): boolean {
    const parts = (value: typeof a) => [
      value.country,
      value.addressLine1,
      value.addressLine2,
      value.locality,
      value.city,
      value.state,
      value.postalCode,
    ].map((part) => normalizeAddressText(part).toLocaleLowerCase("en-IN"));
    const left = parts(a);
    const right = parts(b);
    return left.every((part, index) => part === right[index]) && left[1] !== "" && left[4] !== "";
  }
}

export const addressValidationService = new AddressValidationService();
