import { describe, expect, it } from "vitest";
import { footerNav, mainNav, siteConfig } from "@/config/site";

/**
 * Configuration integrity — catches broken brand/nav edits before they
 * ever reach a deploy.
 */
describe("site configuration integrity", () => {
  it("uses INR commerce defaults for an India-first store", () => {
    expect(siteConfig.commerce.currency).toBe("INR");
    expect(siteConfig.commerce.locale).toBe("en-IN");
    expect(siteConfig.commerce.defaultCountry).toBe("IN");
  });

  it("exposes a valid absolute application URL", () => {
    expect(() => new URL(siteConfig.url)).not.toThrow();
    expect(siteConfig.url.startsWith("http")).toBe(true);
  });

  it("has no placeholder emails left blank", () => {
    expect(siteConfig.contact.email).toContain("@");
    expect(siteConfig.contact.supportEmail).toContain("@");
  });

  it("only links to real routes, anchors, mailto or https targets", () => {
    const valid = (href: string) =>
      href.startsWith("/") || href.startsWith("mailto:") || href.startsWith("https://");

    const footerGroups = Object.values(footerNav);
    footerGroups.forEach((group) => group.forEach((link) => expect(valid(link.href)).toBe(true)));
    mainNav.forEach((link) => expect(valid(link.href)).toBe(true));
  });

  it("enables the implemented cart while keeping checkout and payments unavailable", () => {
    expect(siteConfig.features.cart).toBe(true);
    expect(siteConfig.features.wishlist).toBe(true);
    expect(siteConfig.features.checkout).toBe(false);
    expect(siteConfig.features.payments).toBe(false);
    expect(siteConfig.features.newsletter).toBe(true);
  });
});
