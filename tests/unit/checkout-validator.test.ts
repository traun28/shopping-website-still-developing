import { describe, expect, it } from "vitest";
import type { CheckoutDeliveryOptionSnapshot, CheckoutSession } from "@/db/schema";
import type { CartDTO } from "@/types/cart";
import { validateCheckout } from "@/services/checkout/validator.service";
import { assertCheckoutTransition, canTransitionCheckoutStatus } from "@/services/checkout/state-machine";

const cartId = "11111111-1111-4111-8111-111111111111";
const selectedMethod = "supported-standard";
const selectedOption: CheckoutDeliveryOptionSnapshot = {
  id: selectedMethod,
  name: "Standard delivery",
  description: "A provider-supplied option",
  currency: "INR",
  amountPaise: 500,
  quoteId: "quote-123",
  validUntil: "2099-01-01T00:00:00.000Z",
  estimateOnly: false,
};

const cart: CartDTO = {
  id: cartId,
  status: "ACTIVE",
  currency: "INR",
  version: 7,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  items: [{
    id: "cart-line-1",
    productId: "product-1",
    variantId: "variant-1",
    slug: "print-shirt",
    productName: "Print shirt",
    variantName: "M",
    size: "M",
    color: null,
    imageUrl: null,
    sellerId: "seller-1",
    sellerName: "Inkline seller",
    quantity: 1,
    currency: "INR",
    observedUnitPricePaise: 1_200,
    unitPricePaise: 1_200,
    compareAtPaise: null,
    listUnitPricePaise: 1_500,
    lineSubtotalPaise: 1_200,
    lineDiscountPaise: 300,
    estimatedTaxPaise: 50,
    availableQuantity: 5,
    purchasable: true,
    attributionSource: null,
    version: 1,
    warnings: [],
  }],
  itemCount: 1,
  lineCount: 1,
  totals: {
    currency: "INR",
    listSubtotalPaise: 1_500,
    productDiscountPaise: 300,
    cartDiscountPaise: 0,
    subtotalPaise: 1_200,
    estimatedTaxPaise: 50,
    deliveryEstimatePaise: null,
    totalPaise: 1_250,
  },
  warnings: [],
  readyForCheckout: true,
  mergeResult: null,
};

const session = {
  id: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  guestSessionHash: null,
  cartId,
  cartVersion: 7,
  currency: "INR",
  selectedDeliveryMethodId: selectedMethod,
  contactSnapshot: null,
} as CheckoutSession;

describe("checkout validation", () => {
  it("only passes with a current cart, valid addresses and authoritative delivery and tax", () => {
    const result = validateCheckout({
      session,
      cart,
      shippingAddressState: "VALID",
      billingAddressState: "VALID",
      delivery: { status: "AVAILABLE", options: [selectedOption], message: "Provider quote" },
      tax: { currency: "INR", amountPaise: 200, status: "AUTHORITATIVE", message: "Provider tax quote" },
    });

    expect(result.ready).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "BLOCKING")).toHaveLength(0);
    expect(result.issues.some((issue) => issue.code === "INVENTORY_NOT_RESERVED" && issue.severity === "WARNING")).toBe(true);
    expect(result.totals).toMatchObject({
      listSubtotalPaise: 1_500,
      subtotalPaise: 1_200,
      discountPaise: 300,
      estimatedTaxPaise: 200,
      shippingPaise: 500,
      totalEstimatePaise: 1_900,
      isFinal: false,
    });
  });

  it("fails closed when delivery or destination tax is not authoritative", () => {
    const result = validateCheckout({
      session: { ...session, selectedDeliveryMethodId: null },
      cart,
      shippingAddressState: "VALID",
      billingAddressState: "VALID",
      delivery: { status: "NOT_CONFIGURED", options: [], message: "Delivery not configured" },
      tax: { currency: "INR", amountPaise: 50, status: "CATALOG_ESTIMATE", message: "Estimate only" },
    });

    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("DELIVERY_UNAVAILABLE");
    expect(result.issues.map((issue) => issue.code)).toContain("TAX_NOT_CONFIGURED");
    expect(result.totals.shippingPaise).toBeNull();
    expect(result.totals.totalEstimatePaise).toBeNull();
    expect(result.totals.estimatedTaxPaise).toBe(50);
  });

  it("keeps an unavailable destination-tax quote null instead of presenting zero tax", () => {
    const result = validateCheckout({
      session,
      cart,
      shippingAddressState: "VALID",
      billingAddressState: "VALID",
      delivery: { status: "AVAILABLE", options: [selectedOption], message: "Provider quote" },
      tax: { currency: "INR", amountPaise: null, status: "UNAVAILABLE", message: "Tax provider unavailable" },
    });
    expect(result.ready).toBe(false);
    expect(result.totals.estimatedTaxPaise).toBeNull();
    expect(result.totals.totalEstimatePaise).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("TAX_UNAVAILABLE");
  });

  it("requires explicit review when the observed cart version is stale", () => {
    const result = validateCheckout({
      session: { ...session, cartVersion: 6 },
      cart,
      shippingAddressState: "VALID",
      billingAddressState: "VALID",
      delivery: { status: "AVAILABLE", options: [selectedOption], message: "Provider quote" },
      tax: { currency: "INR", amountPaise: 200, status: "AUTHORITATIVE", message: "Provider tax quote" },
    });
    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("CART_CHANGED");
  });

  it("blocks expired delivery quotes and estimate-only rates", () => {
    const result = validateCheckout({
      session,
      cart,
      shippingAddressState: "VALID",
      billingAddressState: "VALID",
      delivery: {
        status: "AVAILABLE",
        options: [{ ...selectedOption, validUntil: "2020-01-01T00:00:00.000Z", estimateOnly: true }],
        message: "Estimate only",
      },
      tax: { currency: "INR", amountPaise: 200, status: "AUTHORITATIVE", message: "Provider tax quote" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("DELIVERY_QUOTE_EXPIRED");
    expect(result.issues.map((issue) => issue.code)).toContain("DELIVERY_QUOTE_NOT_FINAL");
  });
});

describe("checkout state machine", () => {
  it("allows recoverable issues to enter validation again and validation to commit its result", () => {
    expect(() => assertCheckoutTransition("NEEDS_ATTENTION", "VALIDATING")).not.toThrow();
    expect(() => assertCheckoutTransition("VALIDATING", "NEEDS_ATTENTION")).not.toThrow();
  });

  it.each([
    ["CREATED", "VALIDATING"],
    ["VALIDATING", "READY"],
    ["READY", "VALIDATING"],
    ["NEEDS_ATTENTION", "CANCELLED"],
    ["FAILED", "VALIDATING"],
  ] as const)("permits %s -> %s", (from, to) => {
    expect(canTransitionCheckoutStatus(from, to)).toBe(true);
  });

  it.each([
    ["CREATED", "COMPLETED"],
    ["COMPLETED", "VALIDATING"],
    ["EXPIRED", "READY"],
    ["CANCELLED", "VALIDATING"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransitionCheckoutStatus(from, to)).toBe(false);
  });
});
