/* eslint-disable @next/next/no-img-element -- simple Next Image test double */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CartButton } from "@/components/layout/cart-button";
import type { CartDTO } from "@/types/cart";

const mocks = vi.hoisted(() => ({
  state: { cart: null as unknown, loading: false, refresh: vi.fn() },
  cartMutation: vi.fn(),
}));

vi.mock("@/components/cart/cart-provider", () => ({ useCart: () => mocks.state }));
vi.mock("@/lib/cart/client", () => ({
  CART_UPDATED_EVENT: "inkline:cart-updated",
  cartMutation: (...args: unknown[]) => mocks.cartMutation(...args),
  CartClientError: class CartClientError extends Error {},
}));
vi.mock("next/image", () => ({ default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} /> }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }));

const cartFixture: CartDTO = {
  id: "e8d32f4c-c064-4f00-bc06-153313f9b7c5",
  status: "ACTIVE",
  currency: "INR",
  version: 4,
  createdAt: "2026-10-10T10:00:00.000Z",
  lastActivityAt: "2026-10-10T10:00:00.000Z",
  expiresAt: "2026-11-10T10:00:00.000Z",
  items: [{
    id: "24b50514-3bf7-43df-9aac-975347f0f00c",
    productId: "c90d5e8a-847b-4f68-9190-739a7e83a94d",
    variantId: "c1120666-6f76-42c8-9687-cce72b013eda",
    slug: "ember-hoodie",
    productName: "Ember Hoodie",
    variantName: "Black / M",
    size: "M",
    color: "Black",
    imageUrl: null,
    sellerId: null,
    sellerName: null,
    quantity: 1,
    currency: "INR",
    observedUnitPricePaise: 149_900,
    unitPricePaise: 149_900,
    compareAtPaise: null,
    listUnitPricePaise: 149_900,
    lineSubtotalPaise: 149_900,
    lineDiscountPaise: 0,
    estimatedTaxPaise: 0,
    availableQuantity: 2,
    purchasable: true,
    attributionSource: "PRODUCT_PAGE",
    version: 1,
    warnings: [],
  }],
  itemCount: 1,
  lineCount: 1,
  totals: {
    currency: "INR",
    listSubtotalPaise: 149_900,
    productDiscountPaise: 0,
    cartDiscountPaise: 0,
    subtotalPaise: 149_900,
    estimatedTaxPaise: 0,
    deliveryEstimatePaise: null,
    totalPaise: 149_900,
  },
  warnings: [],
  readyForCheckout: false,
  mergeResult: null,
};

beforeEach(() => {
  mocks.state.cart = cartFixture;
  mocks.state.loading = false;
  mocks.state.refresh.mockReset();
  mocks.cartMutation.mockReset().mockResolvedValue({});
});

describe("live mini-cart", () => {
  it("renders current cart values and updates quantity through the versioned API", async () => {
    render(<CartButton />);
    await fireEvent.click(screen.getByRole("button", { name: "Cart, 1 item" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ember Hoodie")).toBeInTheDocument();
    expect(within(dialog).getAllByText("₹1,499")).toHaveLength(2);

    fireEvent.click(within(dialog).getByRole("button", { name: "Increase" }));
    await waitFor(() => expect(mocks.cartMutation).toHaveBeenCalledWith(
      `/api/cart/items/${cartFixture.items[0]!.id}`,
      { method: "PATCH", body: { quantity: 2, cartVersion: 4 } },
    ));
    expect(mocks.state.refresh).toHaveBeenCalled();
  });

  it("removes a line without hiding checkout availability", async () => {
    render(<CartButton />);
    fireEvent.click(screen.getByRole("button", { name: "Cart, 1 item" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Ember Hoodie from cart" }));
    await waitFor(() => expect(mocks.cartMutation).toHaveBeenCalledWith(
      `/api/cart/items/${cartFixture.items[0]!.id}`,
      { method: "DELETE", body: { cartVersion: 4 } },
    ));
    expect(within(dialog).getByText(/checkout is not open yet/i)).toBeInTheDocument();
  });
});
