import type { CheckoutAddressSnapshot } from "@/db/schema";

/** Remove snapshot metadata before re-running the country-aware address schema. */
export function stableAddressInputFromSnapshot(snapshot: CheckoutAddressSnapshot): Record<string, unknown> {
  return {
    fullName: snapshot.fullName,
    phone: snapshot.phone,
    addressLine1: snapshot.addressLine1,
    addressLine2: snapshot.addressLine2 ?? "",
    locality: snapshot.locality ?? "",
    landmark: snapshot.landmark ?? "",
    deliveryInstructions: snapshot.deliveryInstructions ?? "",
    city: snapshot.city,
    state: snapshot.state ?? "",
    postalCode: snapshot.postalCode ?? "",
    country: snapshot.country,
    addressType: snapshot.addressType,
    isDefaultShipping: false,
    isDefaultBilling: false,
  };
}
