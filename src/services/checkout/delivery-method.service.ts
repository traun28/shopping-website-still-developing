import "server-only";
import type { CheckoutAddressSnapshot, CheckoutDeliveryOptionSnapshot, CheckoutItemSnapshot } from "@/db/schema";

export interface DeliveryQuoteRequest {
  currency: string;
  destination: CheckoutAddressSnapshot;
  items: readonly CheckoutItemSnapshot[];
}

export interface DeliveryOptionResult {
  status: "AVAILABLE" | "NOT_CONFIGURED";
  options: CheckoutDeliveryOptionSnapshot[];
  message: string;
}

/**
 * Integration contract for a real delivery-rating service. It must own
 * destination/serviceability, seller/product/package eligibility and quote
 * expiry. The checkout never synthesizes a method or rate from catalog margin
 * estimates.
 */
export interface DeliveryProvider {
  getOptions(request: DeliveryQuoteRequest): Promise<CheckoutDeliveryOptionSnapshot[]>;
}

export class DeliveryMethodService {
  constructor(private readonly provider: DeliveryProvider | null = null) {}

  async getOptions(request: DeliveryQuoteRequest | null): Promise<DeliveryOptionResult> {
    if (!this.provider || !request) {
      return {
        status: "NOT_CONFIGURED",
        options: [],
        message: "Delivery rating is not configured for this store yet.",
      };
    }
    const options = await this.provider.getOptions(request);
    return {
      status: options.length ? "AVAILABLE" : "NOT_CONFIGURED",
      options,
      message: options.length ? "Delivery options are available." : "No supported delivery option is available for this destination and cart.",
    };
  }
}

/** No shipping provider is wired in this repository at Part 15. */
export const deliveryMethodService = new DeliveryMethodService();
