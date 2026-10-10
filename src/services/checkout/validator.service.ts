import type {
  CheckoutAddressSnapshot,
  CheckoutDeliveryOptionSnapshot,
  CheckoutIssueSnapshot,
  CheckoutItemSnapshot,
  CheckoutSession,
  CheckoutTotalsSnapshot,
} from "@/db/schema";
import type { CartDTO } from "@/types/cart";
import type { DeliveryOptionResult } from "./delivery-method.service";
import type { TaxQuote } from "./tax.service";

export type CheckoutAddressState = "MISSING" | "VALID" | "CHANGED" | "INVALID";

export interface CheckoutValidationInput {
  session: CheckoutSession;
  cart: CartDTO;
  shippingAddressState: CheckoutAddressState;
  billingAddressState: CheckoutAddressState;
  delivery: DeliveryOptionResult;
  tax: TaxQuote;
  acknowledgeCartChanges?: boolean;
  now?: Date;
}

export interface CheckoutValidationResult {
  ready: boolean;
  issues: CheckoutIssueSnapshot[];
  items: CheckoutItemSnapshot[];
  totals: CheckoutTotalsSnapshot;
  selectedDelivery: CheckoutDeliveryOptionSnapshot | null;
  deliveryOptions: CheckoutDeliveryOptionSnapshot[];
  deliveryMessage: string;
  taxMessage: string;
  observedCartVersion: number;
  appliedPromotions: NonNullable<CartDTO["promotionApplications"]>;
}

function addIssue(
  issues: CheckoutIssueSnapshot[],
  code: string,
  message: string,
  severity: "BLOCKING" | "WARNING" = "BLOCKING",
  extra: Pick<CheckoutIssueSnapshot, "itemId" | "productId"> = {},
) {
  if (!issues.some((issue) => issue.code === code && issue.itemId === extra.itemId)) {
    issues.push({ code, message, severity, ...extra });
  }
}

function toItems(cart: CartDTO): CheckoutItemSnapshot[] {
  return cart.items.map((line) => ({
    cartItemId: line.id,
    productId: line.productId,
    variantId: line.variantId,
    sellerId: line.sellerId,
    sellerName: line.sellerName,
    productName: line.productName,
    variantName: line.variantName,
    quantity: line.quantity,
    currency: line.currency,
    unitPricePaise: line.unitPricePaise,
    lineSubtotalPaise: line.lineSubtotalPaise,
    lineDiscountPaise: line.lineDiscountPaise,
    estimatedTaxPaise: line.estimatedTaxPaise,
  }));
}

function selectedOption(
  session: CheckoutSession,
  options: readonly CheckoutDeliveryOptionSnapshot[],
): CheckoutDeliveryOptionSnapshot | null {
  if (!session.selectedDeliveryMethodId) return null;
  return options.find((option) => option.id === session.selectedDeliveryMethodId) ?? null;
}

export function validateCheckout(input: CheckoutValidationInput): CheckoutValidationResult {
  const { session, cart, delivery, tax } = input;
  const now = input.now ?? new Date();
  const issues: CheckoutIssueSnapshot[] = [];
  const items = toItems(cart);
  const chosen = selectedOption(session, delivery.options);
  const cartChanged = session.cartId !== cart.id || session.cartVersion !== cart.version;

  if (cart.items.length === 0) addIssue(issues, "CART_EMPTY", "Add an available item to your cart before continuing.");
  if (cartChanged && !input.acknowledgeCartChanges) {
    addIssue(issues, "CART_CHANGED", "Your cart changed. Review the current items and confirm before continuing.");
  }
  for (const warning of cart.warnings) {
    addIssue(issues, warning.code, warning.message, "BLOCKING", {
      itemId: warning.itemId,
      productId: warning.productId,
    });
  }
  if (cart.promotionIssues?.length) {
    addIssue(issues, "COUPON_UNAVAILABLE", "This code is invalid or unavailable for this cart.");
  }
  if (!cart.readyForCheckout && cart.items.length > 0 && cart.warnings.length === 0) {
    addIssue(issues, "CART_NOT_READY", "The current cart cannot be checked out yet.");
  }

  if (input.shippingAddressState === "MISSING") addIssue(issues, "SHIPPING_ADDRESS_REQUIRED", "Add or select a shipping address.");
  if (input.shippingAddressState === "CHANGED") addIssue(issues, "SHIPPING_ADDRESS_CHANGED", "This saved shipping address changed. Review and select it again.");
  if (input.shippingAddressState === "INVALID") addIssue(issues, "SHIPPING_ADDRESS_INVALID", "Correct the shipping address before continuing.");
  if (input.billingAddressState === "MISSING") addIssue(issues, "BILLING_ADDRESS_REQUIRED", "Add or select a billing address, or use the shipping address for billing.");
  if (input.billingAddressState === "CHANGED") addIssue(issues, "BILLING_ADDRESS_CHANGED", "This saved billing address changed. Review and select it again.");
  if (input.billingAddressState === "INVALID") addIssue(issues, "BILLING_ADDRESS_INVALID", "Correct the billing address before continuing.");

  if (!session.userId) {
    const contact = session.contactSnapshot;
    if (!contact?.name.trim() || !contact?.email.trim() || !contact?.phone.trim()) {
      addIssue(issues, "CONTACT_REQUIRED", "Enter your name, email and contact number.");
    }
  }

  if (delivery.status === "NOT_CONFIGURED") {
    addIssue(issues, "DELIVERY_UNAVAILABLE", delivery.message);
  } else if (!session.selectedDeliveryMethodId) {
    addIssue(issues, "DELIVERY_NOT_SELECTED", "Choose an available delivery option.");
  } else if (!chosen) {
    addIssue(issues, "DELIVERY_QUOTE_EXPIRED", "The selected delivery quote is no longer available. Choose again.");
  } else {
    if (chosen.validUntil && new Date(chosen.validUntil).getTime() <= now.getTime()) {
      addIssue(issues, "DELIVERY_QUOTE_EXPIRED", "The selected delivery quote expired. Request a current option.");
    }
    if (chosen.currency !== cart.currency) {
      addIssue(issues, "DELIVERY_CURRENCY_MISMATCH", "The delivery quote currency does not match the cart.");
    }
    if (chosen.amountPaise === null || !Number.isSafeInteger(chosen.amountPaise) || chosen.amountPaise < 0 || chosen.estimateOnly) {
      addIssue(issues, "DELIVERY_QUOTE_NOT_FINAL", "A final server quote is required before checkout can be marked ready.");
    }
  }

  if (tax.status === "UNAVAILABLE") {
    addIssue(issues, "TAX_UNAVAILABLE", tax.message);
  } else if (tax.status !== "AUTHORITATIVE") {
    addIssue(issues, "TAX_NOT_CONFIGURED", tax.message);
  }

  // A READY checkout is still not an order or stock reservation. Preserve this
  // warning in the server snapshot and show it in the review UI.
  addIssue(issues, "INVENTORY_NOT_RESERVED", "Items are not reserved; stock will be checked again before any future payment or order step.", "WARNING");

  const shippingPaise = chosen && chosen.amountPaise !== null ? chosen.amountPaise : null;
  const taxPaise = tax.amountPaise;
  const totalEstimatePaise = shippingPaise !== null && taxPaise !== null
    ? cart.totals.subtotalPaise + taxPaise + shippingPaise
    : null;
  const totals: CheckoutTotalsSnapshot = {
    currency: cart.currency,
    listSubtotalPaise: cart.totals.listSubtotalPaise,
    subtotalPaise: cart.totals.subtotalPaise,
    discountPaise: cart.totals.productDiscountPaise + cart.totals.cartDiscountPaise,
    estimatedTaxPaise: taxPaise,
    shippingPaise,
    totalEstimatePaise,
    taxStatus: tax.status,
    deliveryStatus: delivery.status,
    isFinal: false,
  };
  const blocking = issues.some((issue) => issue.severity === "BLOCKING");

  return {
    ready: !blocking,
    issues,
    items,
    totals,
    selectedDelivery: chosen,
    deliveryOptions: delivery.options,
    deliveryMessage: delivery.message,
    taxMessage: tax.message,
    observedCartVersion: cart.version,
    appliedPromotions: cart.promotionApplications ?? [],
  };
}

export function snapshotAddressIsPresent(value: CheckoutAddressSnapshot | null): boolean {
  return Boolean(value?.fullName && value.addressLine1 && value.city && value.country);
}
