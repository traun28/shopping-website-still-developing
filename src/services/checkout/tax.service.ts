import "server-only";
import type { CheckoutAddressSnapshot } from "@/db/schema";
import type { CartDTO } from "@/types/cart";

export interface TaxQuote {
  currency: string;
  amountPaise: number | null;
  status: "AUTHORITATIVE" | "CATALOG_ESTIMATE" | "UNAVAILABLE";
  message: string;
}

export interface TaxProvider {
  quote(input: { currency: string; destination: CheckoutAddressSnapshot; cart: CartDTO }): Promise<number>;
}

/**
 * Reuses the existing catalog pricing estimate without presenting it as a
 * destination tax determination. A tax provider is intentionally not inferred
 * from product-level basis points.
 */
export class TaxService {
  constructor(private readonly provider: TaxProvider | null = null) {}

  async quote(input: { currency: string; destination: CheckoutAddressSnapshot | null; cart: CartDTO }): Promise<TaxQuote> {
    if (this.provider && input.destination) {
      const amountPaise = await this.provider.quote({
        currency: input.currency,
        destination: input.destination,
        cart: input.cart,
      });
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
        return { currency: input.currency, amountPaise: null, status: "UNAVAILABLE", message: "The tax provider returned an invalid quote." };
      }
      return { currency: input.currency, amountPaise, status: "AUTHORITATIVE", message: "Tax quote supplied by the configured provider." };
    }

    if (!Number.isSafeInteger(input.cart.totals.estimatedTaxPaise) || input.cart.totals.estimatedTaxPaise < 0) {
      return { currency: input.currency, amountPaise: null, status: "UNAVAILABLE", message: "Tax cannot be estimated from the current cart." };
    }
    return {
      currency: input.currency,
      amountPaise: input.cart.totals.estimatedTaxPaise,
      status: "CATALOG_ESTIMATE",
      message: "Catalog tax estimate only; destination tax calculation is not configured.",
    };
  }
}

/** No destination tax provider is wired in this repository at Part 15. */
export const taxService = new TaxService();
