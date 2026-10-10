import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "../helpers/user";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push, replace: vi.fn() }),
  usePathname: () => "/product/ember-hoodie",
  useSearchParams: () => new URLSearchParams(),
}));

const addProductToCart = vi.fn();
const cartRefresh = vi.fn();
vi.mock("@/lib/cart/client", () => ({
  addProductToCart: (input: unknown) => addProductToCart(input),
}));
vi.mock("@/components/cart/cart-provider", () => ({
  useCart: () => ({ cart: null, loading: false, refresh: cartRefresh }),
}));
vi.mock("@/server/actions/account-actions", () => ({
  toggleWishlistAction: vi.fn(async () => ({ ok: true, saved: true })),
}));

import { ProductGallery } from "@/components/product/product-gallery";
import { ProductExperience, type ProductExperienceProduct } from "@/components/product/product-experience";
import { ProductInfoSections } from "@/components/product/product-info";
import { ProductLoadError } from "@/components/product/product-load-error";
import { ProductPageSkeleton, RelatedSkeleton } from "@/components/product/product-skeleton";
import { SizeGuide } from "@/components/product/size-guide";
import { registerAnalyticsSink } from "@/lib/analytics";
import type { PdpImageDTO, PdpProductDTO, PdpVariantDTO } from "@/lib/catalog/pdp-dto";
import { EMPTY_PRODUCT_DETAILS } from "@/lib/catalog/product-details";
import { selectionFromParams } from "@/lib/catalog/variant-selection";

const img = (n: number, colorKey: string | null = null): PdpImageDTO => ({
  url: `/images/p${n}.jpg`,
  alt: `Ember Hoodie – view ${n}`,
  width: 1200,
  height: 1500,
  colorKey,
});

function variant(id: string, color: string, size: string, cents: number, state: PdpVariantDTO["state"] = "AVAILABLE", compareAt: number | null = null): PdpVariantDTO {
  return {
    id,
    sku: `EH-${color.slice(0, 3).toUpperCase()}-${size}`,
    name: `${color} / ${size}`,
    color,
    size,
    price: { amountPaise: cents, compareAtPaise: compareAt, discountPercent: compareAt ? Math.round(((compareAt - cents) / compareAt) * 100) : null },
    state,
  };
}

const variants = [
  variant("v-bs", "Black", "S", 149_900, "AVAILABLE", 199_900),
  variant("v-bm", "Black", "M", 149_900),
  variant("v-bl", "Black", "L", 149_900, "OUT_OF_STOCK"),
  variant("v-em", "Ecru", "M", 159_900),
];

function product(overrides: Partial<ProductExperienceProduct> = {}): ProductExperienceProduct {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "ember-hoodie",
    name: "Ember Hoodie",
    shortDescription: "A warm hoodie.",
    productTypeLabel: "Hoodie",
    price: { amountPaise: 149_900, compareAtPaise: null, discountPercent: null },
    variants,
    colors: [
      { key: "black", label: "Black", hex: "#16130e" },
      { key: "ecru", label: "Ecru", hex: "#efe9db" },
    ],
    sizes: [
      { key: "s", label: "S" },
      { key: "m", label: "M" },
      { key: "l", label: "L" },
    ],
    purchasable: true,
    images: [img(1), img(2), img(3, "ecru")],
    sizeChart: null,
    rating: null,
    isNew: false,
    ...overrides,
  };
}

function renderExperience(p: ProductExperienceProduct = product(), params: { color?: string; size?: string } = {}) {
  return render(
    <ProductExperience
      product={p}
      initialSelection={selectionFromParams(p.variants, params)}
      saved={false}
      categoryLabel="Hoodies"
      browseHref="/category/hoodies"
    >
      <p>server content</p>
    </ProductExperience>,
  );
}

beforeEach(() => {
  refresh.mockClear();
  push.mockClear();
  addProductToCart.mockReset();
  addProductToCart.mockResolvedValue({ status: "REJECTED", message: "The cart could not be updated." });
  cartRefresh.mockReset();
  registerAnalyticsSink(null);
  window.history.replaceState(null, "", "/product/ember-hoodie");
});

describe("ProductGallery", () => {
  const images = [img(1), img(2), img(3)];

  it("shows the main image with its own alt text and numbered thumbnails", () => {
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 1" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Show image \d of 3$/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show image 1 of 3" })).toHaveAttribute("aria-current", "true");
  });

  it("navigates with buttons, thumbnails and the keyboard, wrapping around", async () => {
    const user = userEvent.setup();
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show image 3 of 3" }));
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 3" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group", { name: /images/ }), { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 1" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group", { name: /images/ }), { key: "ArrowLeft" });
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 3" })).toBeInTheDocument();
  });

  it("supports swipe on touch", () => {
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    const zoom = screen.getByRole("button", { name: /^Zoom image/ });
    fireEvent.pointerDown(zoom, { pointerType: "touch", clientX: 300, clientY: 100 });
    fireEvent.pointerUp(zoom, { pointerType: "touch", clientX: 100, clientY: 110 });
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 2" })).toBeInTheDocument();
  });

  it("does not treat a vertical scroll as a swipe", () => {
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    const zoom = screen.getByRole("button", { name: /^Zoom image/ });
    fireEvent.pointerDown(zoom, { pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerUp(zoom, { pointerType: "touch", clientX: 120, clientY: 400 });
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 1" })).toBeInTheDocument();
  });

  it("opens a zoom lightbox with focus handling, zoom toggle and Escape to close", async () => {
    const user = userEvent.setup();
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    await user.click(screen.getByRole("button", { name: /^Zoom image/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Ember Hoodie")).toBeInTheDocument();
    const toggle = within(dialog).getByRole("button", { name: /Zoom in/ });
    await user.click(toggle);
    expect(within(dialog).getByRole("button", { name: /Zoom out/ })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("falls back safely when the image fails to load", () => {
    render(<ProductGallery images={[img(1)]} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    const main = screen.getByRole("img", { name: "Ember Hoodie – view 1" });
    fireEvent.error(main);
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 1 (image unavailable)" })).toBeInTheDocument();
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
  });

  it("renders a placeholder (not a broken image) when there are no images", () => {
    render(<ProductGallery images={[]} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    expect(screen.getByRole("img", { name: /photos coming soon/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });

  it("hides navigation for a single image and keeps the aspect box (no layout shift)", () => {
    const { container } = render(<ProductGallery images={[img(1)]} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    expect(container.querySelector(".aspect-\\[4\\/5\\]")).not.toBeNull();
  });

  it("reports image views to analytics, and analytics failure never breaks the gallery", async () => {
    const user = userEvent.setup();
    localStorage.setItem("inkline-consent", JSON.stringify({ essential: true, analytics: true, marketing: false, updatedAt: "2026-01-01" }));
    const sink = vi.fn(() => {
      throw new Error("analytics down");
    });
    registerAnalyticsSink(sink);
    render(<ProductGallery images={images} productName="Ember Hoodie" productSlug="ember-hoodie" />);
    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 2" })).toBeInTheDocument();
    localStorage.clear();
  });
});

describe("ProductExperience — variants, price, availability", () => {
  it("renders the selected variant's price, SKU and availability from real data", () => {
    renderExperience();
    expect(screen.getByRole("heading", { level: 1, name: "Ember Hoodie" })).toBeInTheDocument();
    expect(screen.getByTestId("price-block")).toHaveTextContent("₹1,499");
    expect(screen.getByTestId("sku")).toHaveTextContent("SKU EH-BLA-S");
    expect(screen.getByTestId("availability")).toHaveTextContent("Available to order");
  });

  it("shows compare-at and discount only when stored", () => {
    renderExperience();
    expect(screen.getByTestId("price-block")).toHaveTextContent("₹1,999");
    expect(screen.getByTestId("price-block")).toHaveTextContent("25% off");
  });

  it("does not invent a discount when there is no compare-at price", async () => {
    const user = userEvent.setup();
    renderExperience();
    await user.click(screen.getByRole("radio", { name: "Select size M" }));
    expect(screen.getByTestId("price-block")).not.toHaveTextContent("% off");
    expect(screen.queryByText(/only \d+ left/i)).not.toBeInTheDocument();
  });

  it("updates price and SKU when the colour changes, keeping a valid size", async () => {
    const user = userEvent.setup();
    renderExperience(product(), { color: "black", size: "m" });
    expect(screen.getByTestId("sku")).toHaveTextContent("EH-BLA-M");
    await user.click(screen.getByRole("radio", { name: "Select ecru color" }));
    expect(screen.getByTestId("price-block")).toHaveTextContent("₹1,599");
    expect(screen.getByTestId("sku")).toHaveTextContent("EH-ECR-M");
    expect(screen.getByRole("radio", { name: "Select ecru color" })).toBeChecked();
  });

  it("disables sizes that the chosen colour does not have or that are out of stock", async () => {
    const user = userEvent.setup();
    renderExperience(product(), { color: "black", size: "m" });
    expect(screen.getByRole("radio", { name: "Select size L (unavailable)" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Select ecru color" }));
    expect(screen.getByRole("radio", { name: "Select size S (unavailable)" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Select size M" })).toBeEnabled();
    // A disabled combination can't be chosen.
    await user.click(screen.getByRole("radio", { name: "Select size S (unavailable)" }));
    expect(screen.getByTestId("sku")).toHaveTextContent("EH-ECR-M");
  });

  it("uses accessible labels on colour swatches and never shows a hex from the client", () => {
    renderExperience();
    expect(screen.getByRole("radio", { name: "Select black color" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Color/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Size/ })).toBeInTheDocument();
  });

  it("starts from a valid URL selection", () => {
    renderExperience(product(), { color: "ecru", size: "m" });
    expect(screen.getByTestId("sku")).toHaveTextContent("EH-ECR-M");
  });

  it("loads fine with invalid URL params (?size=XXXXL&color=purple)", () => {
    renderExperience(product(), { color: "purple", size: "XXXXL" });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("sku")).toHaveTextContent("EH-BLA-S");
  });

  it("keeps the URL in sync without navigation, and the clean path when nothing is chosen", async () => {
    const user = userEvent.setup();
    const replace = vi.spyOn(window.history, "replaceState");
    renderExperience();
    await user.click(screen.getByRole("radio", { name: "Select ecru color" }));
    expect(replace).toHaveBeenLastCalledWith(null, "", "/product/ember-hoodie?color=ecru&size=m");
    replace.mockRestore();
  });

  it("reports selections to analytics without sensitive data", async () => {
    const user = userEvent.setup();
    localStorage.setItem("inkline-consent", JSON.stringify({ essential: true, analytics: true, marketing: false, updatedAt: "2026-01-01" }));
    const sink = vi.fn();
    registerAnalyticsSink(sink);
    renderExperience();
    await user.click(screen.getByRole("radio", { name: "Select ecru color" }));
    await user.click(screen.getByRole("radio", { name: "Select black color" }));
    const names = sink.mock.calls.map(([event]) => event.name);
    expect(names).toEqual(expect.arrayContaining(["COLOR_SELECTED", "VARIANT_SELECTED"]));
    await user.click(screen.getByRole("radio", { name: "Select size S" }));
    expect(sink.mock.calls.map(([event]) => event.name)).toContain("SIZE_SELECTED");
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/price|email|token/i);
    localStorage.clear();
  });

  it("swaps the gallery to a colour's own photo", async () => {
    const user = userEvent.setup();
    renderExperience();
    expect(screen.queryByRole("img", { name: "Ember Hoodie – view 3" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Select ecru color" }));
    expect(screen.getByRole("img", { name: "Ember Hoodie – view 3" })).toBeInTheDocument();
  });

  it("supports products without colour or size options (single variant)", () => {
    const single = product({
      variants: [{ id: "v1", sku: "MUG-1", name: "Standard", color: null, size: null, price: { amountPaise: 69_900, compareAtPaise: null, discountPercent: null }, state: "AVAILABLE" }],
      colors: [],
      sizes: [],
    });
    renderExperience(single);
    expect(screen.queryByRole("group", { name: /Color/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Size/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add to cart/ })).toBeEnabled();
  });

  it("handles very long names and SKUs with wrapping classes", () => {
    const long = "Ultra".repeat(60);
    const p = product({ name: long, variants: [{ ...variants[0]!, sku: "SKU-" + "9".repeat(80) }] });
    renderExperience(p);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(long);
    expect(heading.className).toContain("overflow-wrap:anywhere");
    expect(screen.getByTestId("sku").className).toContain("break-all");
  });
});

describe("ProductExperience — quantity and add to cart", () => {
  it("clamps absurd quantities typed into the field", async () => {
    const user = userEvent.setup();
    renderExperience();
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "999999999");
    expect(input).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Increase" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Decrease" }));
    expect(input).toHaveValue("9");
  });

  it("never goes below 1", async () => {
    renderExperience();
    expect(screen.getByRole("button", { name: "Decrease" })).toBeDisabled();
  });

  it("sends product and option identities plus quantity to the persistent cart boundary, never a price", async () => {
    const user = userEvent.setup();
    renderExperience(product(), { color: "black", size: "m" });
    await user.click(screen.getByRole("button", { name: "Increase" }));
    await user.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(addProductToCart).toHaveBeenCalledTimes(1));
    expect(addProductToCart).toHaveBeenCalledWith(expect.objectContaining({
      productId: "00000000-0000-4000-8000-000000000001",
      variantId: "v-bm",
      quantity: 2,
      cartVersion: 0,
      source: "PRODUCT_PAGE",
    }));
    const payload = addProductToCart.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("price");
    expect(payload).not.toHaveProperty("unitPricePaise");
    expect(payload).not.toHaveProperty("compareAtPrice");
  });

  it("shows the cart API's rejection and refreshes potentially stale product data", async () => {
    const user = userEvent.setup();
    addProductToCart.mockResolvedValue({ status: "REJECTED", message: "This option is currently unavailable." });
    renderExperience();
    await user.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This option is currently unavailable.");
    expect(refresh).toHaveBeenCalled();
  });

  it("only reports an add after the persistent cart API accepts the mutation", async () => {
    const user = userEvent.setup();
    addProductToCart.mockResolvedValue({
      status: "ADDED",
      result: { itemId: "line-1", productId: "p", variantId: "v-bs", quantity: 1, version: 2, replayed: false, currentUnitPricePaise: 149_900 },
    });
    renderExperience();
    await user.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(addProductToCart).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables add to cart for an out-of-stock selection", async () => {
    renderExperience(
      product({ variants: [variant("v1", "Black", "S", 100_000, "OUT_OF_STOCK"), variant("v2", "Black", "M", 100_000)] }),
      { size: "s" },
    );
    // URL asked for the out-of-stock size; it is ignored in favour of an orderable one.
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeEnabled();
  });
});

describe("ProductExperience — unavailable product", () => {
  const unavailable = () =>
    product({
      purchasable: false,
      variants: [variant("v1", "Black", "S", 100_000, "OUT_OF_STOCK")],
    });

  it("shows the unavailable state with no enabled purchase controls", () => {
    renderExperience(unavailable());
    expect(screen.getByText("This product is currently unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add to cart/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse Similar Products" })).toHaveAttribute("href", "/category/hoodies");
  });

  it("offers no purchase UI at all when there are zero variants", () => {
    renderExperience(product({ purchasable: false, variants: [], colors: [], sizes: [] }), {});
    expect(screen.queryByRole("button", { name: /add to cart|select options/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("unavailable-state")).toBeInTheDocument();
    expect(screen.queryByTestId("sku")).not.toBeInTheDocument();
  });
});

describe("ProductExperience — wishlist, rating, size guide, mobile", () => {
  it("connects to the existing wishlist button (logged-out users are sent to sign in and back)", async () => {
    const { toggleWishlistAction } = await import("@/server/actions/account-actions");
    vi.mocked(toggleWishlistAction).mockResolvedValueOnce({ ok: false, error: "Sign in", requiresLogin: true });
    const user = userEvent.setup();
    renderExperience();
    await user.click(screen.getByRole("button", { name: /Add Ember Hoodie to wishlist/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login?redirect=%2Fproduct%2Fember-hoodie"));
  });

  it("toggles saved state for signed-in users", async () => {
    const user = userEvent.setup();
    renderExperience();
    const button = screen.getByRole("button", { name: /Add Ember Hoodie to wishlist/ });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: /Remove Ember Hoodie from wishlist/ })).toHaveAttribute("aria-pressed", "true"));
  });

  it("shows a rating only when real review data exists", () => {
    const { unmount } = renderExperience();
    expect(screen.queryByRole("img", { name: /Rated/ })).not.toBeInTheDocument();
    unmount();
    renderExperience(product({ rating: { average: 4.5, count: 12 } }));
    expect(screen.getByRole("img", { name: "Rated 4.5 out of 5 from 12 reviews" })).toBeInTheDocument();
  });

  it("hides the size-guide button when there is no real chart", () => {
    renderExperience();
    expect(screen.queryByRole("button", { name: /size guide/i })).not.toBeInTheDocument();
  });

  it("opens a real size chart in an accessible dialog", async () => {
    const user = userEvent.setup();
    renderExperience(product({ sizeChart: { title: "Hoodie sizes", unit: "cm", columns: ["Size", "Chest"], rows: [["S", "100"], ["M", "106"]], notes: "Measured flat." } }));
    await user.click(screen.getByRole("button", { name: /size guide/i }));
    const dialog = await screen.findByRole("dialog", { name: "Hoodie sizes" });
    expect(within(dialog).getByRole("table")).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "Chest" })).toBeInTheDocument();
    expect(within(dialog).getByRole("rowheader", { name: "M" })).toBeInTheDocument();
    expect(within(dialog).getByText("Measured flat.")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("centimetres");
  });

  it("SizeGuide renders nothing without a chart", () => {
    const { container } = render(<SizeGuide chart={null} productSlug="x" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses a mobile-first layout: stacked on small screens, two columns from lg, sticky bar only below lg", () => {
    const { container } = renderExperience();
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain("lg:grid-cols-");
    expect(grid.className).toContain("pb-24"); // room for the sticky bar
    expect(grid.className).toContain("lg:pb-0");
    expect(container.innerHTML).not.toMatch(/style="[^"]*width:\s*\d{4,}px/);
  });

  it("shows the sticky purchase bar only after the main button scrolls out of view, without covering content", async () => {
    let callback: IntersectionObserverCallback = () => undefined;
    class FakeObserver {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    renderExperience();
    expect(screen.queryByTestId("sticky-purchase-bar")).not.toBeInTheDocument();
    act(() => {
      callback([{ isIntersecting: false, boundingClientRect: { top: -50 } } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    const bar = await screen.findByTestId("sticky-purchase-bar");
    expect(bar.className).toContain("lg:hidden");
    expect(within(bar).getByRole("button", { name: "Add to cart" })).toBeEnabled();
    // Scrolled back up: the real button is visible again, so the bar leaves.
    act(() => {
      callback([{ isIntersecting: true, boundingClientRect: { top: 200 } } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
    expect(screen.queryByTestId("sticky-purchase-bar")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders server content passed as children", () => {
    renderExperience();
    expect(screen.getByText("server content")).toBeInTheDocument();
  });
});

describe("ProductInfoSections", () => {
  function dto(overrides: Partial<PdpProductDTO> = {}): PdpProductDTO {
    return {
      id: "id",
      slug: "ember-hoodie",
      name: "Ember Hoodie",
      shortDescription: null,
      description: "First paragraph.\n\nSecond paragraph.",
      productType: "HOODIE",
      productTypeLabel: "Hoodie",
      currency: "INR",
      price: { amountPaise: 100, compareAtPaise: null, discountPercent: null },
      variants: [],
      colors: [],
      sizes: [],
      purchasable: true,
      images: [],
      categoryTrail: [],
      collection: null,
      details: { ...EMPTY_PRODUCT_DETAILS },
      designs: [],
      sizeChart: null,
      rating: null,
      isNew: false,
      seo: { title: null, description: null, image: null },
      ...overrides,
    };
  }

  it("renders only sections with real data", () => {
    render(<ProductInfoSections product={dto()} />);
    expect(screen.getByRole("heading", { name: "Description" })).toBeInTheDocument();
    expect(screen.getAllByText(/paragraph\./)).toHaveLength(2);
    for (const missing of ["Product details", "Care", "The design"]) {
      expect(screen.queryByRole("heading", { name: missing })).not.toBeInTheDocument();
    }
  });

  it("renders features, specs, materials, care and designs when present", () => {
    render(
      <ProductInfoSections
        product={dto({
          details: {
            features: ["Brushed fleece"],
            materials: "80% cotton",
            fit: "Relaxed",
            care: ["Wash cold"],
            printDetails: "Water-based ink",
            specs: [{ label: "Weight", value: "320 gsm" }],
          },
          designs: [{ name: "Ember", placements: ["Front", "Back"] }],
        })}
      />,
    );
    expect(screen.getByText("Brushed fleece")).toBeInTheDocument();
    expect(screen.getByText("Materials")).toBeInTheDocument();
    expect(screen.getByText("320 gsm")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Care" })).toBeInTheDocument();
    expect(screen.getByText("Front, Back", { exact: false })).toBeInTheDocument();
  });

  it("never renders HTML from content and never prints coordinates", () => {
    const { container } = render(<ProductInfoSections product={dto({ description: "<img src=x onerror=alert(1)>Safe" })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/dpi|scale|rotation|printFileKey/i);
  });

  it("shows policy links and no delivery promises", () => {
    const { container } = render(<ProductInfoSections product={dto()} />);
    expect(screen.getByRole("link", { name: /shipping & delivery policy/i })).toHaveAttribute("href", "/legal/shipping");
    expect(screen.getByRole("link", { name: /returns & refunds policy/i })).toHaveAttribute("href", "/legal/refunds");
    expect(container.textContent).not.toMatch(/guarantee|free shipping|delivered (in|by)|\d+\s*-?\s*\d*\s*days/i);
    expect(container.textContent).not.toMatch(/secure checkout|certified|award/i);
  });
});

describe("loading and error states", () => {
  it("renders an accessible full-page skeleton and a related skeleton", () => {
    render(
      <>
        <ProductPageSkeleton />
        <RelatedSkeleton />
      </>,
    );
    expect(screen.getByRole("status", { name: "Loading product" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "Loading related products" })).toBeInTheDocument();
  });

  it("shows the customer-safe error with Try Again, which retries", async () => {
    const user = userEvent.setup();
    render(<ProductLoadError />);
    expect(screen.getByText("We couldn't load this product right now.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("product not-found copy offers Continue Shopping", async () => {
    const { default: NotFound } = await import("@/app/(storefront)/product/[slug]/not-found");
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: /Product not found/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue Shopping" })).toHaveAttribute("href", "/shop");
  });
});
