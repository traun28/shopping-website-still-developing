/**
 * Central application & brand configuration.
 *
 * Every piece of business metadata lives here — never hard-code brand
 * strings, URLs, currency codes, or contact details inside components.
 * This file is safe to import from both server and client components:
 * it only reads `NEXT_PUBLIC_*` variables and build-time constants.
 */

const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export const siteConfig = {
  /** Brand identity */
  name: "Inkline",
  legalName: "Inkline Studios",
  tagline: "Wear your creativity.",
  description:
    "Original artwork printed after you order, on tees, hoodies, mugs, posters and more. Browse the catalogue, save pieces to a wishlist, and join the list for launch notes. Checkout is not open yet.",
  keywords: [
    "print on demand india",
    "original artwork",
    "graphic tees",
    "printed hoodies",
    "art posters",
    "printed mugs",
    "wishlist",
  ],

  /** Deployment */
  url: rawAppUrl.replace(/\/$/, ""),
  version: "0.1.0",

  /** Commerce */
  commerce: {
    currency: "INR",
    currencySymbol: "₹",
    locale: "en-IN",
    defaultCountry: "IN",
    /** Prices are stored in the smallest currency unit (paise). */
    currencyFractionDigits: 2,
    /**
     * Shipping facts shown on product pages ONLY when set. Leave null until
     * they are real — the storefront never invents delivery promises.
     */
    shipping: {
      processingTime: null as string | null,
      deliveryEstimate: null as string | null,
      regions: null as string | null,
    },
  },

  /** Contact placeholders — replace before public launch. */
  contact: {
    email: "hello@inkline.in",
    supportEmail: "support@inkline.in",
    phone: null as string | null,
    address: null as string | null,
  },

  /** Social profiles (placeholders until launch). */
  social: {
    instagram: "https://instagram.com/inkline.in",
    x: "https://x.com/inkline_in",
    youtube: "https://youtube.com/@inkline",
    pinterest: "https://pinterest.com/inklinestudio",
  },

  /**
   * Feature flags. Modules that are not built yet stay off so the UI can
   * present honest "coming soon" states instead of dead functionality.
   */
  features: {
    newsletter: true,
    catalogSearch: true, // client-side preview search over sample catalogue
    cart: true,
    wishlist: true,
    customerAccounts: true,
    checkout: false,
    payments: false,
    reviews: false,
    coupons: false,
    podFulfillment: false,
  },

  /**
   * Announcement bar — rotate campaign messages from one place.
   * Set `enabled: false` to hide it entirely.
   */
  announcement: {
    enabled: true,
    messages: [
      "Printed after you order — not pulled from a shelf",
      "Accounts are open — save pieces to your wishlist",
      "Checkout and payments are not open yet",
    ],
  },
} as const;

export type SiteConfig = typeof siteConfig;

/** Primary storefront navigation — only routes/anchors that exist. */
export const mainNav = [
  { label: "Shop", href: "/shop" },
  { label: "Categories", href: "/#categories" },
  { label: "New arrivals", href: "/#new-arrivals" },
  { label: "How it works", href: "/#how-it-works" },
] as const;

/** Footer navigation — every href must resolve to a real route or anchor. */
export const footerNav = {
  shop: [
    { label: "All products", href: "/shop" },
    { label: "New arrivals", href: "/#new-arrivals" },
    { label: "Shop by category", href: "/#categories" },
  ],
  support: [
    { label: "FAQs", href: "/faqs" },
    { label: "Shipping & delivery", href: "/legal/shipping" },
    { label: "Returns & refunds", href: "/legal/refunds" },
    { label: "Contact us", href: `mailto:${siteConfig.contact.supportEmail}` },
  ],
  company: [
    { label: "Our story", href: "/#how-it-works" },
    { label: "Reviews", href: "/#reviews" },
    { label: "Instagram", href: siteConfig.social.instagram },
  ],
  legal: [
    { label: "Privacy policy", href: "/legal/privacy" },
    { label: "Terms of service", href: "/legal/terms" },
  ],
} as const;
