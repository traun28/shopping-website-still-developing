/* eslint-disable @next/next/no-img-element -- test double for next/image */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { CartButton } from "@/components/layout/cart-button";
import { MobileNav } from "@/components/layout/mobile-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { PrivacyChoices } from "@/components/privacy/privacy-choices";
import { AnalyticsBridge } from "@/components/storefront/analytics-bridge";
import { registerAnalyticsSink, STOREFRONT_EVENTS } from "@/lib/analytics";
import { writeConsent } from "@/lib/consent";
import type { StorefrontCollection } from "@/types/storefront";

vi.mock("next/image", () => ({
  default: function MockImage({ alt, src }: { alt: string; src: string }) {
    return <img alt={alt} src={src} />;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/server/actions/auth-actions", () => ({
  logoutAction: vi.fn(),
}));

vi.mock("@/components/cart/cart-provider", () => ({
  useCart: () => ({ cart: null, loading: false, refresh: vi.fn() }),
}));

const collection: StorefrontCollection = {
  slug: "limited-drop",
  name: "Limited Drop",
  description: "A published collection.",
  image: null,
  imageAlt: "Limited Drop",
  productCount: 1,
  seoTitle: null,
  seoDescription: null,
};

describe("storefront chrome", () => {
  it("exposes desktop navigation plus account, wishlist and a cart with no fake count", () => {
    render(<SiteHeader user={null} collections={[collection]} cartCount={null} />);

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(primary.className).toContain("hidden");
    expect(primary.className).toContain("lg:flex");
    expect(screen.getByRole("link", { name: "Shop" })).toHaveAttribute("href", "/shop");
    expect(screen.getByRole("link", { name: /wishlist — sign in required/i })).toHaveAttribute(
      "href",
      "/login?redirect=%2Faccount%2Fwishlist",
    );
    expect(screen.getByRole("link", { name: "Login" })).toHaveAttribute("href", "/login");
    const cart = screen.getByRole("button", { name: "Cart" });
    expect(cart.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByRole("button", { name: "Open menu" }).className).toContain("lg:hidden");
  });

  it("shows the account menu for a signed-in person and keeps wishlist on a slug path", () => {
    render(<SiteHeader user={{ name: "Ada", role: "CUSTOMER", verified: true }} cartCount={null} />);
    expect(screen.getByRole("button", { name: /account menu for ada/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wishlist" })).toHaveAttribute("href", "/account/wishlist");
  });

  it("puts shop, search, wishlist and account in the mobile drawer", () => {
    render(
      <MobileNav
        user={null}
        collections={[collection]}
        trigger={<button type="button">Open menu</button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("link", { name: /shop/i })).toHaveAttribute("href", "/shop");
    expect(screen.getByRole("link", { name: /search/i })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: /wishlist/i })).toHaveAttribute("href", "/login?redirect=%2Faccount%2Fwishlist");
    expect(screen.getByRole("link", { name: /login/i })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Limited Drop" })).toHaveAttribute("href", "/collection/limited-drop");
  });

  it("does not invent a cart count before the live cart has loaded", () => {
    render(<CartButton count={null} />);
    expect(screen.getByRole("button", { name: "Cart" })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders footer categories from data and a privacy-choices control", () => {
    render(
      <ThemeProvider>
        <SiteFooter categories={[{ slug: "mugs", name: "Mugs" }]} />
      </ThemeProvider>,
    );
    expect(screen.getByRole("link", { name: "Mugs" })).toHaveAttribute("href", "/category/mugs");
    expect(screen.getByRole("button", { name: /privacy choices/i })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveClass("bg-ink");
  });

  it("announces only scheduled messages and can be dismissed from the keyboard", async () => {
    window.sessionStorage.clear();
    render(
      <AnnouncementBar
        enabled
        messages={[
          { id: "live", message: "Accounts are open", href: "/faqs", active: true },
          { id: "off", message: "Secret sale ends tonight", active: false },
        ]}
      />,
    );
    expect(await screen.findByText("Accounts are open")).toBeInTheDocument();
    expect(screen.queryByText(/secret sale/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss announcement/i }));
    expect(screen.queryByText("Accounts are open")).not.toBeInTheDocument();
  });

  it("records a cart-open event only after analytics consent", async () => {
    const sink = vi.fn();
    registerAnalyticsSink(sink);
    writeConsent({ analytics: false, marketing: false });
    render(
      <>
        <AnalyticsBridge />
        <CartButton />
      </>,
    );
    const cart = screen.getByRole("button", { name: "Cart" });
    fireEvent.click(cart);
    expect(sink).not.toHaveBeenCalled();

    writeConsent({ analytics: true, marketing: false, updatedAt: "2026-09-29T00:00:00.000Z" });
    fireEvent.click(cart);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ name: STOREFRONT_EVENTS.CART_OPENED, consent: "analytics" }),
    );
    registerAnalyticsSink(null);
  });

  it("keeps privacy choices from enabling a tracker by themselves", async () => {
    window.localStorage.clear();
    render(<PrivacyChoices tone="ink" />);
    fireEvent.click(screen.getByRole("button", { name: /privacy choices/i }));
    expect(screen.getByText(/tools are not loaded/i)).toBeInTheDocument();
    expect(document.querySelector("script[src*='google']")).toBeNull();
  });
});
