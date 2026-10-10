import type { CartTotalsDTO } from "@/types/cart";

export interface CartTotalsLine {
  quantity: number;
  currentUnitPricePaise: number | null;
  listUnitPricePaise: number | null;
  estimatedTaxPerUnitPaise: number;
}

/**
 * One authoritative cart calculation in integer minor units.
 *
 * Order: variant list price × quantity → active product/variant pricing rules
 * (already applied by the catalog pricing service) → product discount → cart
 * discount (currently zero; there is no cart-coupon integration) → catalog
 * product tax estimate on the discounted unit price → delivery (null until a
 * real rating service exists). No tax/shipping/discount is invented here.
 */
export function calculateCartTotals(lines: readonly CartTotalsLine[], currency: string): CartTotalsDTO {
  let listSubtotalPaise = 0;
  let subtotalPaise = 0;
  let productDiscountPaise = 0;
  let estimatedTaxPaise = 0;

  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) continue;
    if (line.currentUnitPricePaise === null || !Number.isSafeInteger(line.currentUnitPricePaise)) continue;
    const current = Math.max(0, line.currentUnitPricePaise);
    const listPrice = typeof line.listUnitPricePaise === "number" && Number.isSafeInteger(line.listUnitPricePaise)
      ? line.listUnitPricePaise
      : current;
    const list = Math.max(current, listPrice);
    const tax = Math.max(0, Number.isSafeInteger(line.estimatedTaxPerUnitPaise) ? line.estimatedTaxPerUnitPaise : 0);
    listSubtotalPaise += list * line.quantity;
    subtotalPaise += current * line.quantity;
    productDiscountPaise += (list - current) * line.quantity;
    estimatedTaxPaise += tax * line.quantity;
  }

  const cartDiscountPaise = 0;
  const deliveryEstimatePaise = null;
  return {
    currency,
    listSubtotalPaise,
    productDiscountPaise,
    cartDiscountPaise,
    subtotalPaise: subtotalPaise - cartDiscountPaise,
    estimatedTaxPaise,
    deliveryEstimatePaise,
    totalPaise: subtotalPaise - cartDiscountPaise + estimatedTaxPaise,
  };
}

/** The current storefront supports one currency per cart. */
export function currenciesMatch(cartCurrency: string, productCurrency: string): boolean {
  return /^[A-Z]{3}$/.test(cartCurrency) && cartCurrency === productCurrency;
}
