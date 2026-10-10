import { describe, expect, it } from "vitest";
import { calculateCartTotals, currenciesMatch } from "@/services/cart/totals.service";

describe("cart totals", () => {
  it("uses integer minor units, current selling price, and server tax estimates", () => {
    const totals = calculateCartTotals(
      [
        { quantity: 2, currentUnitPricePaise: 8500, listUnitPricePaise: 10_000, estimatedTaxPerUnitPaise: 1530 },
        { quantity: 1, currentUnitPricePaise: 2000, listUnitPricePaise: 2000, estimatedTaxPerUnitPaise: 0 },
      ],
      "INR",
    );
    expect(totals).toEqual({
      currency: "INR",
      listSubtotalPaise: 22_000,
      productDiscountPaise: 3_000,
      cartDiscountPaise: 0,
      subtotalPaise: 19_000,
      estimatedTaxPaise: 3_060,
      deliveryEstimatePaise: null,
      totalPaise: 22_060,
    });
  });

  it("does not invent a price or tax for unavailable lines", () => {
    const totals = calculateCartTotals(
      [
        { quantity: 2, currentUnitPricePaise: null, listUnitPricePaise: null, estimatedTaxPerUnitPaise: 500 },
        { quantity: 0, currentUnitPricePaise: 1000, listUnitPricePaise: 1000, estimatedTaxPerUnitPaise: 100 },
      ],
      "INR",
    );
    expect(totals.subtotalPaise).toBe(0);
    expect(totals.estimatedTaxPaise).toBe(0);
    expect(totals.totalPaise).toBe(0);
    expect(totals.deliveryEstimatePaise).toBeNull();
  });

  it("only accepts a single valid ISO currency per cart", () => {
    expect(currenciesMatch("INR", "INR")).toBe(true);
    expect(currenciesMatch("INR", "USD")).toBe(false);
    expect(currenciesMatch("inr", "inr")).toBe(false);
    expect(currenciesMatch("IN", "IN")).toBe(false);
  });
});
