/**
 * Storefront content architecture.
 *
 * Homepage copy, campaigns, section order and media live here — not inside
 * React components — so a later CMS can replace this module with database
 * rows of the same shape. Components only render.
 *
 * Claims are limited to what the business can currently support:
 * original artwork, print-after-order as the model, live accounts/wishlists,
 * and an email list we actually store. Checkout, tracking, material grades,
 * delivery windows and environmental certifications are not asserted.
 */

import type { ScheduleWindow } from "@/lib/schedule";
import { categoryPath, collectionPath } from "@/lib/storefront-paths";

export type StorefrontIcon =
  | "palette"
  | "printer"
  | "bag"
  | "truck"
  | "user"
  | "heart"
  | "mail"
  | "shield"
  | "search";

export interface AnnouncementMessage extends ScheduleWindow {
  id: string;
  message: string;
  href?: string | null;
}

export interface PromoBanner extends ScheduleWindow {
  id: string;
  title: string;
  description: string;
  image?: { src: string; alt: string; width: number; height: number };
  ctaLabel: string;
  href: string;
  placement: "after-hero" | "before-footer";
  kind: "launch" | "seasonal" | "collection" | "drop" | "shipping";
}

export interface HeroVisualAsset {
  id: string;
  kind: "artwork" | "mockup" | "photo" | "promo";
  src: string;
  /** Optional art-directed crop. Same file is fine when composition differs in CSS. */
  mobileSrc?: string;
  alt: string;
  width: number;
  height: number;
  slot: "primary" | "secondary" | "accent";
}

export interface Cta {
  label: string;
  href: string;
  event: "HERO_CTA_CLICK" | "COLLECTION_CLICK" | "CATEGORY_CLICK";
}

export interface HomepageSection {
  id:
    | "hero"
    | "marquee"
    | "promo"
    | "categories"
    | "featured-products"
    | "new-arrivals"
    | "featured-collection"
    | "how-it-works"
    | "why-us"
    | "design-showcase"
    | "reviews"
    | "newsletter";
  visible: boolean;
}

export interface TrustItem {
  id: string;
  icon: StorefrontIcon;
  label: string;
  description: string;
  /** Live capability vs something we have not shipped. */
  status: "live" | "upcoming" | "model";
}

const MARK = "/images/art/mark.png";

export const storefrontContent = {
  announcement: {
    enabled: true,
    messages: [
      {
        id: "made-to-order",
        message: "Printed after you order — not pulled from a shelf",
        href: "/#how-it-works",
        active: true,
      },
      {
        id: "wishlist-live",
        message: "Accounts are open — save pieces to your wishlist",
        href: "/account/wishlist",
        active: true,
      },
      {
        id: "checkout-later",
        message: "Checkout and payments are not open yet",
        href: "/faqs",
        active: true,
      },
    ] satisfies AnnouncementMessage[],
  },

  /**
   * Draft campaigns. Inactive entries never render.
   * When a real end time is configured, a countdown may be added later —
   * never a fake timer.
   */
  banners: [
    {
      id: "draft-seasonal",
      title: "Seasonal campaign",
      description: "Draft slot for a future seasonal collection. Not published.",
      ctaLabel: "Explore",
      href: "/shop",
      placement: "after-hero",
      kind: "seasonal",
      active: false,
      startsAt: null,
      endsAt: null,
    },
    {
      id: "draft-shipping",
      title: "Shipping campaign",
      description: "Draft slot. Do not announce free shipping until it is a real offer.",
      ctaLabel: "Shipping policy",
      href: "/legal/shipping",
      placement: "before-footer",
      kind: "shipping",
      active: false,
    },
  ] satisfies PromoBanner[],

  hero: {
    id: "home-hero",
    eyebrow: "Print-on-demand studio · India",
    headline: ["Original art,", "printed for you"],
    supporting:
      "Independent artwork on tees, hoodies, mugs, posters and more. A piece is printed after you order it — we don't keep finished stock waiting on a shelf.",
    primaryCta: { label: "Shop the collection", href: "/shop", event: "HERO_CTA_CLICK" } satisfies Cta,
    secondaryCta: { label: "Explore designs", href: "/#designs", event: "HERO_CTA_CLICK" } satisfies Cta,
    notes: ["Printed after you order", "Original artwork", "Wishlists are live", "Checkout opens later"],
    visuals: [
      {
        id: "hero-primary",
        kind: "photo",
        slot: "primary",
        src: "/images/hero.jpg",
        mobileSrc: "/images/hero.jpg",
        alt: "Folded ecru tee with a line-grid print, a leaning ink drawing and a cream mug with an orange stroke",
        width: 1122,
        height: 1402,
      },
      {
        id: "hero-poster",
        kind: "artwork",
        slot: "secondary",
        src: "/images/products/poster.jpg",
        alt: "Abstract line print in warm paper and flame orange",
        width: 1122,
        height: 1402,
      },
      {
        id: "hero-mug",
        kind: "mockup",
        slot: "accent",
        src: "/images/products/mug.jpg",
        alt: "Cream ceramic mug with a black and orange wave drawing",
        width: 1122,
        height: 1402,
      },
    ] satisfies HeroVisualAsset[],
  },

  marquee: ["Original art", "Printed after you order", "Made to order", "Wishlists are live", "Checkout opens later"],

  categories: {
    eyebrow: "Shop by category",
    titleLead: "Pick your",
    titleAccent: "canvas",
    description:
      "Tees, hoodies, mugs, posters, cases and totes — each one printed after the order, not pulled from a warehouse.",
    /** Pin order only. Categories that exist in the database still appear if they aren't listed. */
    pinOrder: ["t-shirts", "hoodies", "mugs", "posters", "phone-cases", "tote-bags", "sweatshirts"],
    ctaLabel: "Shop",
    /** Optional media when the database has no category image yet. */
    media: {
      "t-shirts": { src: "/images/products/tee.jpg", alt: "Folded tee with an abstract line-grid print" },
      hoodies: { src: "/images/products/hoodie.jpg", alt: "Black hoodie with an orange brush drawing" },
      sweatshirts: { src: "/images/products/sweatshirt.jpg", alt: "Oatmeal sweatshirt with a wave print and orange disc" },
      mugs: { src: "/images/products/mug.jpg", alt: "Cream mug with a wave line drawing" },
      posters: { src: "/images/products/poster.jpg", alt: "Abstract horizontal line print shifting into orange" },
      "phone-cases": { src: "/images/products/phone-case.jpg", alt: "Black phone case with an orange line drawing" },
      "tote-bags": { src: "/images/products/tote.jpg", alt: "Canvas tote with a black grid and one orange square" },
    } as Record<string, { src: string; alt: string }>,
    fallbackImage: MARK,
  },

  featuredProducts: {
    eyebrow: "The shop",
    titleLead: "Pieces in",
    titleAccent: "the catalogue",
    description: "Published artwork you can open, save, and — once checkout launches — order. Nothing here is a sample review or a made-up bestseller rank.",
    viewAll: { label: "View all", href: "/shop" },
    /** Optional pin list. Empty means "first published products". */
    productSlugs: [] as string[],
    limit: 8,
  },

  newArrivals: {
    eyebrow: "Just published",
    titleLead: "New",
    titleAccent: "arrivals",
    description: "Newest published pieces first. Limited drops will use the same section when a collection is actually scheduled.",
    viewAll: { label: "View the catalogue", href: "/shop" },
    limit: 8,
  },

  featuredCollection: {
    /** Reference, not a hardcoded campaign layout. Swap the slug when the season changes. */
    slug: "limited-drop",
    eyebrow: "Collection",
    ctaLabel: "Explore collection",
    emptyTitle: "No collection is scheduled",
    emptyDescription: "Seasonal and limited collections will show here when one is published. We don't invent a drop to fill the space.",
    fallbackImage: "/images/products/poster.jpg",
    fallbackImageAlt: "Abstract line print used as a stand-in until a collection image is set",
  },

  howItWorks: {
    eyebrow: "How print-on-demand works",
    titleLead: "Made after",
    titleAccent: "you order",
    description:
      "Print-on-demand means a piece is produced from the order, instead of being printed in bulk and hoped for. Checkout is not open yet, and we don't promise a delivery window.",
    image: {
      src: "/images/hero.jpg",
      alt: "Studio still life of a folded tee, an ink drawing and a mug — not a photograph of a specific factory",
      width: 1122,
      height: 1402,
    },
    steps: [
      {
        step: "01",
        icon: "palette" as const,
        title: "Choose a design",
        description: "Browse original artwork on tees, hoodies, mugs, posters, cases and totes.",
      },
      {
        step: "02",
        icon: "bag" as const,
        title: "Place your order",
        description: "Checkout is not open yet. You can create an account and save pieces to your wishlist now.",
      },
      {
        step: "03",
        icon: "printer" as const,
        title: "We print it",
        description: "When an order is placed, that piece is printed. We don't produce extras for a warehouse.",
      },
      {
        step: "04",
        icon: "truck" as const,
        title: "We ship it",
        description: "Packed and sent with tracking once fulfillment is live. No delivery-time guarantee is offered.",
      },
    ],
  },

  whyUs: {
    eyebrow: "Why Inkline",
    titleLead: "A simpler",
    titleAccent: "way to print",
    description: "What we can stand behind today — and what is still opening.",
    pillars: [
      {
        icon: "palette" as const,
        title: "Original artwork",
        description: "The catalogue is built from artwork made for Inkline, not stock graphics scraped from the internet.",
      },
      {
        icon: "printer" as const,
        title: "Printed after you order",
        description: "Production starts from the order. Finished pieces are not sitting in a warehouse waiting to be sold.",
      },
      {
        icon: "bag" as const,
        title: "Several products, one studio",
        description: "Apparel, drinkware, prints and carry goods share the same artwork catalogue.",
      },
      {
        icon: "heart" as const,
        title: "Accounts you can use now",
        description: "Profiles, addresses and wishlists are live. Checkout, payment and order tracking are not open yet.",
      },
    ],
  },

  trust: [
    {
      id: "support",
      icon: "mail",
      label: "Email support",
      description: "Write to the support address. There is no phone line or chat widget yet.",
      status: "live",
    },
    {
      id: "wishlist",
      icon: "heart",
      label: "Wishlist",
      description: "Signed-in customers can save published pieces.",
      status: "live",
    },
    {
      id: "pod",
      icon: "printer",
      label: "Printed to order",
      description: "The model is print-after-order. Supplier fulfillment is not switched on yet.",
      status: "model",
    },
    {
      id: "checkout",
      icon: "shield",
      label: "Secure checkout",
      description: "Payments are not available yet. This is not a live checkout.",
      status: "upcoming",
    },
    {
      id: "tracking",
      icon: "truck",
      label: "Order tracking",
      description: "Tracking arrives with fulfillment. Nothing can be tracked today.",
      status: "upcoming",
    },
  ] satisfies TrustItem[],

  showcase: {
    eyebrow: "Studio artwork",
    titleLead: "The work,",
    titleAccent: "up close",
    description: "Artwork and product studies from the studio. These are not customer photos.",
    /** Hard cap so the gallery never requests a large set on first paint. */
    limit: 6,
    items: [
      {
        id: "still-life",
        kind: "photo" as const,
        src: "/images/hero.jpg",
        alt: "Studio still life of a tee, an ink drawing and a mug",
        caption: "Studio still life",
        width: 1122,
        height: 1402,
      },
      {
        id: "grid-tee",
        kind: "mockup" as const,
        src: "/images/products/tee.jpg",
        alt: "Folded tee with a topographic line print and an orange stroke",
        caption: "Line grid study",
        width: 1122,
        height: 1402,
      },
      {
        id: "ember",
        kind: "mockup" as const,
        src: "/images/products/hoodie.jpg",
        alt: "Black hoodie with an orange and black brush drawing",
        caption: "Ember study",
        width: 1122,
        height: 1402,
      },
      {
        id: "waves",
        kind: "mockup" as const,
        src: "/images/products/sweatshirt.jpg",
        alt: "Sweatshirt with a wave print and an orange disc",
        caption: "Wave study",
        width: 1122,
        height: 1402,
      },
      {
        id: "lines",
        kind: "artwork" as const,
        src: "/images/products/poster.jpg",
        alt: "Abstract print of fine horizontal lines shifting into orange",
        caption: "Line field",
        width: 1122,
        height: 1402,
      },
      {
        id: "carry",
        kind: "mockup" as const,
        src: "/images/products/tote.jpg",
        alt: "Canvas tote with a black grid and a single orange square",
        caption: "Grid study",
        width: 1122,
        height: 1402,
      },
    ],
  },

  reviews: {
    eyebrow: "Reviews",
    titleLead: "Your review",
    titleAccent: "could be here",
    emptyTitle: "Your review could be here.",
    emptyDescription:
      "Verified reviews will appear after real purchases. We don't publish sample quotes or invented customers.",
  },

  newsletter: {
    eyebrow: "The list",
    titleLead: "Notes when",
    titleAccent: "there's news",
    description:
      "Launch notes and new artwork. Subscribing stores your email on Inkline's list. We won't tell you a marketing platform has you unless one is actually connected.",
    privacyHref: "/legal/privacy",
  },

  search: {
    placeholder: "Search tees, hoodies, mugs…",
    /** Editorial hints — not measured popularity. */
    suggested: ["tees", "hoodies", "mugs", "posters", "totes"],
    /** Left empty until search analytics exist. Do not invent popular queries. */
    popular: [] as string[],
  },

  cart: {
    feature: "Checkout isn't open yet",
    description:
      "Your cart is saved and prices are checked against the live catalog. You can add, edit, remove, or save items for later; checkout, payment, and order creation are not available yet.",
  },

  productMedia: {
    "offbeat-grid-tee": { hoverImage: "/images/hero.jpg" },
    "ink-marker-tee": { hoverImage: "/images/products/tee.jpg" },
    "ember-sketch-hoodie": { hoverImage: "/images/products/phone-case.jpg" },
  } as Record<string, { hoverImage?: string; image?: string }>,
} as const;

export type StorefrontContent = typeof storefrontContent;

export function categoryHref(slug: string): string {
  return categoryPath(slug);
}

export function collectionHref(slug: string): string {
  return collectionPath(slug);
}

export const homepageSections: HomepageSection[] = [
  { id: "hero", visible: true },
  { id: "marquee", visible: true },
  { id: "promo", visible: true },
  { id: "categories", visible: true },
  { id: "featured-products", visible: true },
  { id: "new-arrivals", visible: true },
  { id: "featured-collection", visible: true },
  { id: "how-it-works", visible: true },
  { id: "why-us", visible: true },
  { id: "design-showcase", visible: true },
  { id: "reviews", visible: true },
  { id: "newsletter", visible: true },
];
