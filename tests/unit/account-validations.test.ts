import { describe, expect, it } from "vitest";
import { addressSchema } from "@/validations/address";
import { deactivateAccountSchema, preferencesSchema } from "@/validations/account";

const validAddress = {
  fullName: "Tarun Kumar",
  phone: "9876543210",
  addressLine1: "14 Residency Road",
  addressLine2: "Flat 3B",
  locality: "Central Bengaluru",
  landmark: "Near Trinity Circle",
  deliveryInstructions: "Call on arrival",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "IN",
  addressType: "HOME" as const,
  isDefaultShipping: false,
  isDefaultBilling: false,
};

describe("addressSchema", () => {
  it("accepts a valid Indian address", () => {
    expect(addressSchema.safeParse(validAddress).success).toBe(true);
  });

  it("requires a 6-digit PIN code starting non-zero", () => {
    expect(addressSchema.safeParse({ ...validAddress, postalCode: "56000" }).success).toBe(false);
    expect(addressSchema.safeParse({ ...validAddress, postalCode: "060001" }).success).toBe(false);
    expect(addressSchema.safeParse({ ...validAddress, postalCode: "560001" }).success).toBe(true);
  });

  it("requires city and state", () => {
    expect(addressSchema.safeParse({ ...validAddress, city: "" }).success).toBe(false);
    expect(addressSchema.safeParse({ ...validAddress, state: "" }).success).toBe(false);
  });

  it("accepts phone with country code", () => {
    expect(addressSchema.safeParse({ ...validAddress, phone: "+919876543210" }).success).toBe(true);
  });

  it("rejects malformed phone", () => {
    expect(addressSchema.safeParse({ ...validAddress, phone: "call-me" }).success).toBe(false);
  });

  it("allows international addresses without mandatory region or postal codes", () => {
    const international = {
      ...validAddress,
      phone: "+971 50 123 4567",
      city: "Dubai",
      state: "",
      postalCode: "",
      country: "AE",
    };
    expect(addressSchema.safeParse(international).success).toBe(true);
  });

  it("optional fields may be empty", () => {
    const minimal = { ...validAddress, addressLine2: "", landmark: "" };
    expect(addressSchema.safeParse(minimal).success).toBe(true);
  });
});

describe("preferencesSchema", () => {
  it("accepts full preference payloads", () => {
    expect(
      preferencesSchema.safeParse({
        marketingEmails: true,
        orderNotifications: true,
        promotionalNotifications: false,
        language: "hi-IN",
        currency: "INR",
        measurementSystem: "METRIC",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown languages", () => {
    expect(
      preferencesSchema.safeParse({
        marketingEmails: true,
        orderNotifications: true,
        promotionalNotifications: false,
        language: "fr-FR",
        currency: "INR",
        measurementSystem: "METRIC",
      }).success,
    ).toBe(false);
  });
});

describe("deactivateAccountSchema", () => {
  it("requires the current password", () => {
    expect(deactivateAccountSchema.safeParse({ password: "", reason: "" }).success).toBe(false);
    expect(
      deactivateAccountSchema.safeParse({ password: "AnyPass!23", reason: "Leaving" }).success,
    ).toBe(true);
  });
});
