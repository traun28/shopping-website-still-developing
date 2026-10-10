/**
 * Development seed — clearly marked sample data.
 *
 * Safe to run repeatedly: every write is idempotent (insert-or-skip on
 * unique keys). No fake customers, orders or reviews are fabricated;
 * the only users are one staff admin (dev password, MUST rotate) and
 * one obviously-labeled demo customer on a `.test` domain.
 */
import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { DEFAULT_COLORS, SIZE_CATALOG, tagSlug } from "@/lib/catalog-rules";
import {
  categories,
  collections,
  colors,
  coupons,
  designs,
  images,
  podProductMappings,
  podProviders,
  podVariantMappings,
  productCategories,
  productCollections,
  productDesigns,
  products,
  productVariants,
  sizeProductTypes,
  sizes,
  users,
} from "@/db/schema";

// Server services carry a Next.js-only import guard; the development seed is a
// trusted Node entry point and exercises those same services directly.
const require_ = createRequire(import.meta.url);
const Module = require_("node:module") as { _resolveFilename: (...args: unknown[]) => string };
const serverOnlyStub = fileURLToPath(new URL("../tests/mocks/server-only.ts", import.meta.url));
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request: unknown, ...rest: unknown[]): string {
  if (request === "server-only") return serverOnlyStub;
  return (originalResolve as (r: unknown, ...a: unknown[]) => string).call(this, request, ...rest);
};

function hashDevPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(plain, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

/** Insert-if-absent and always return the row's id. */
async function ensure<T extends Record<string, unknown>>(opts: {
  table: any;
  values: T;
  target: any;
  selectBy: any;
}): Promise<string> {
  const inserted = await opts.table === undefined ? [] : await db
    .insert(opts.table)
    .values(opts.values)
    .onConflictDoNothing({ target: opts.target })
    .returning({ id: (opts.table as any).id });
  if (inserted.length > 0) return inserted[0].id as string;

  const existing = await db
    .select({ id: (opts.table as any).id })
    .from(opts.table)
    .where(eq(opts.selectBy.column, opts.selectBy.value))
    .limit(1);
  if (!existing.length) throw new Error(`Seed ensure failed for ${JSON.stringify(opts.values)}`);
  return existing[0].id as string;
}

async function seedOptions() {
  for (const [index, color] of DEFAULT_COLORS.entries()) {
    await ensure({
      table: colors,
      values: { name: color.name, slug: tagSlug(color.name), hex: color.hex, displayOrder: index, isActive: true },
      target: colors.slug,
      selectBy: { column: colors.slug, value: tagSlug(color.name) },
    });
  }
  for (const [index, size] of SIZE_CATALOG.entries()) {
    const sizeId = await ensure({
      table: sizes,
      values: { code: size.code, label: size.label, displayOrder: index, isActive: true },
      target: sizes.code,
      selectBy: { column: sizes.code, value: size.code },
    });
    for (const productType of size.productTypes) {
      const existing = await db
        .select({ sizeId: sizeProductTypes.sizeId })
        .from(sizeProductTypes)
        .where(and(eq(sizeProductTypes.sizeId, sizeId), eq(sizeProductTypes.productType, productType)))
        .limit(1);
      if (!existing.length) {
        await db.insert(sizeProductTypes).values({ sizeId, productType });
      }
    }
  }
}

async function main() {
  console.log("Seeding Inkline development data…");
  const { adjustInventory } = await import("@/services/catalog/inventory.service");
  await seedOptions();
  const now = new Date();

  /* ── Users ──────────────────────────────────────────────────────── */
  const adminId = await ensure({
    table: users,
    values: {
      name: "Inkline Admin (seed)",
      email: "admin@inkline.in",
      passwordHash: hashDevPassword("InklineAdmin#2026"),
      role: "SUPER_ADMIN" as const,
      status: "ACTIVE" as const,
      emailVerifiedAt: now,
    },
    target: users.email,
    selectBy: { column: users.email, value: "admin@inkline.in" },
  });

  await ensure({
    table: users,
    values: {
      name: "Demo Customer (seed — not a real person)",
      email: "demo.customer@inkline.test",
      role: "CUSTOMER" as const,
      status: "ACTIVE" as const,
      emailVerifiedAt: now,
    },
    target: users.email,
    selectBy: { column: users.email, value: "demo.customer@inkline.test" },
  });
  console.log("  users ✓ (admin@inkline.in — dev password only, rotate before launch)");

  /* ── Category tree ──────────────────────────────────────────────── */
  const cat = async (slug: string, name: string, description: string, parentId?: string, order = 0) => {
    const parent = parentId
      ? (await db
          .select({ path: categories.path, depth: categories.depth, ancestorIds: categories.ancestorIds })
          .from(categories)
          .where(eq(categories.id, parentId))
          .limit(1))[0]
      : null;
    if (parentId && !parent) throw new Error(`Seed parent category ${parentId} was not found.`);
    const path = parent ? `${parent.path}/${slug}` : slug;
    const depth = parent ? parent.depth + 1 : 0;
    const ancestorIds = parent
      ? parent.ancestorIds
        ? `${parent.ancestorIds},${parentId}`
        : parentId!
      : "";

    return ensure({
      table: categories,
      values: { slug, name, description, parentId, path, depth, ancestorIds, displayOrder: order, isActive: true },
      target: categories.slug,
      selectBy: { column: categories.slug, value: slug },
    });
  };

  const apparelId = await cat("apparel", "Apparel", "Clothing printed after you order.", undefined, 1);
  const accessoriesId = await cat("accessories", "Accessories", "Carry, sip and protect.", undefined, 2);
  const wallArtId = await cat("wall-art", "Wall Art", "Prints for your walls.", undefined, 3);

  const tshirtsId = await cat("t-shirts", "T-Shirts", "Tees printed after you order.", apparelId, 1);
  const hoodiesId = await cat("hoodies", "Hoodies", "Hoodies printed after you order.", apparelId, 2);
  const sweatshirtsId = await cat("sweatshirts", "Sweatshirts", "Crewnecks printed after you order.", apparelId, 3);
  const mugsId = await cat("mugs", "Mugs", "Ceramic mugs.", accessoriesId, 1);
  const totesId = await cat("tote-bags", "Tote Bags", "Canvas totes.", accessoriesId, 2);
  const casesId = await cat("phone-cases", "Phone Cases", "Phone cases.", accessoriesId, 3);
  const postersId = await cat("posters", "Posters", "Posters printed after you order.", wallArtId, 1);
  console.log("  categories ✓ (3 parents, 7 children)");

  /* ── Collections ────────────────────────────────────────────────── */
  const coll = async (slug: string, name: string, description: string, order = 0) =>
    ensure({
      table: collections,
      values: { slug, name, description, status: "ACTIVE" as const, displayOrder: order },
      target: collections.slug,
      selectBy: { column: collections.slug, value: slug },
    });

  const newArrivalsId = await coll("new-arrivals", "New Arrivals", "Fresh off the press.", 1);
  const bestSellersId = await coll("best-sellers", "Best Sellers", "Most loved by the community.", 2);
  await coll("wave-study", "Wave Study", "Fluid line art from the coast residency.", 3);
  await coll("limited-drop", "Limited Drop", "Short runs. Gone when they're gone.", 4);
  console.log("  collections ✓");

  /* ── Designs ────────────────────────────────────────────────────── */
  const design = async (slug: string, name: string, description: string) =>
    ensure({
      table: designs,
      values: {
        slug,
        name,
        description,
        status: "PUBLISHED" as const,
        designerId: adminId,
        copyrightStatus: "ORIGINAL" as const,
        licenseInfo: "© Inkline Studios — original commissioned artwork.",
      },
      target: designs.slug,
      selectBy: { column: designs.slug, value: slug },
    });

  const waveStudyId = await design("wave-study", "Wave Study", "Swirling organic wave lines in flame & ink.");
  const offbeatGridId = await design("offbeat-grid", "Offbeat Grid", "Topographic grid study, flame on ecru.");
  const emberSketchId = await design("ember-sketch", "Ember Sketch", "Hand-drawn ember strokes series.");
  const inkPortraitId = await design("ink-portrait", "Ink Portrait", "Single-sitting marker portrait.");
  console.log("  designs ✓");

  /* ── Products ───────────────────────────────────────────────────── */
  interface SeedProduct {
    slug: string;
    name: string;
    type: "T_SHIRT" | "HOODIE" | "SWEATSHIRT" | "MUG" | "POSTER" | "PHONE_CASE" | "TOTE_BAG";
    price: number;
    compareAt?: number;
    image: string;
    categories: string[];
    collections: string[];
    designId: string;
    status: "DRAFT" | "ACTIVE";
    short: string;
  }

  const seedProducts: SeedProduct[] = [
    { slug: "offbeat-grid-tee", name: "Offbeat Grid Tee", type: "T_SHIRT", price: 89900, compareAt: 119900, image: "/images/products/tee.jpg", categories: [tshirtsId], collections: [newArrivalsId, bestSellersId], designId: offbeatGridId, status: "ACTIVE", short: "Tee with a swirling grid print. Development catalogue sample." },
    { slug: "ember-sketch-hoodie", name: "Ember Sketch Hoodie", type: "HOODIE", price: 199900, image: "/images/products/hoodie.jpg", categories: [hoodiesId], collections: [bestSellersId], designId: emberSketchId, status: "ACTIVE", short: "Hoodie with ember line art. Development catalogue sample." },
    { slug: "studio-sweatshirt", name: "Studio Sweatshirt", type: "SWEATSHIRT", price: 149900, image: "/images/products/sweatshirt.jpg", categories: [sweatshirtsId], collections: [newArrivalsId], designId: waveStudyId, status: "ACTIVE", short: "Crewneck with a wave study. Development catalogue sample." },
    { slug: "morning-ritual-mug", name: "Morning Ritual Mug", type: "MUG", price: 49900, image: "/images/products/mug.jpg", categories: [mugsId], collections: [newArrivalsId], designId: waveStudyId, status: "ACTIVE", short: "Mug with wrap-around line art. Development catalogue sample." },
    { slug: "sunset-lines-poster", name: "Sunset Lines Poster", type: "POSTER", price: 34900, image: "/images/products/poster.jpg", categories: [postersId], collections: [], designId: waveStudyId, status: "ACTIVE", short: "Poster with a line-field print. Development catalogue sample." },
    { slug: "carry-chaos-tote", name: "Carry Chaos Tote", type: "TOTE_BAG", price: 69900, image: "/images/products/tote.jpg", categories: [totesId], collections: [], designId: offbeatGridId, status: "ACTIVE", short: "Tote with a grid print. Development catalogue sample." },
    { slug: "pocket-art-case", name: "Pocket Art Case", type: "PHONE_CASE", price: 79900, image: "/images/products/phone-case.jpg", categories: [casesId], collections: [], designId: emberSketchId, status: "ACTIVE", short: "Phone case with a line drawing. Development catalogue sample." },
    { slug: "ink-marker-tee", name: "Ink Marker Tee", type: "T_SHIRT", price: 99900, image: "/images/products/tee.jpg", categories: [tshirtsId], collections: [bestSellersId], designId: inkPortraitId, status: "ACTIVE", short: "Tee with a marker-line portrait. Development catalogue sample." },
  ];

  const APPAREL_SIZES = ["S", "M", "L", "XL", "XXL"] as const;
  const APPAREL_COLORS = [
    { name: "Black", code: "#16130E" },
    { name: "Ecru", code: "#EFE9DB" },
  ];

  let variantCount = 0;
  for (const seed of seedProducts) {
    const productId = await ensure({
      table: products,
      values: {
        slug: seed.slug,
        name: seed.name,
        shortDescription: seed.short,
        description: `${seed.short} Printed after the order is placed. Development seed — not a customer review or a material certificate.`,
        productType: seed.type,
        status: seed.status,
        basePrice: seed.price,
        compareAtPrice: seed.compareAt ?? null,
        publishedAt: now,
        seoTitle: `${seed.name} — Inkline`,
        seoDescription: seed.short,
      },
      target: products.slug,
      selectBy: { column: products.slug, value: seed.slug },
    });

    // Category + collection + design associations
    for (const categoryId of seed.categories) {
      await db
        .insert(productCategories)
        .values({ productId, categoryId, isPrimary: true })
        .onConflictDoNothing({ target: [productCategories.productId, productCategories.categoryId] });
    }
    for (const collectionId of seed.collections) {
      await db
        .insert(productCollections)
        .values({ productId, collectionId })
        .onConflictDoNothing({ target: [productCollections.productId, productCollections.collectionId] });
    }
    await db
      .insert(productDesigns)
      .values({ productId, designId: seed.designId, placement: seed.type === "MUG" ? ("CENTER" as const) : ("FRONT" as const) })
      .onConflictDoNothing();

    // Primary storefront image (images have no natural unique key —
    // guard by product+url instead of a naive always-insert).
    const existingImage = await db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.productId, productId), eq(images.url, seed.image)))
      .limit(1);
    if (!existingImage.length) {
      await db.insert(images).values({
        type: "PRODUCT" as const,
        url: seed.image,
        altText: seed.name,
        width: 1200,
        height: 1500,
        mimeType: "image/jpeg",
        productId,
        sortOrder: 0,
      });
    }

    // Variants
    const isApparel = ["T_SHIRT", "HOODIE", "SWEATSHIRT"].includes(seed.type);
    const prefix = seed.slug
      .split("-")
      .map((part) => part[0].toUpperCase())
      .join("");

    const variantSpecs = isApparel
      ? APPAREL_COLORS.flatMap((color) =>
          APPAREL_SIZES.map((size) => ({
            sku: `INK-${prefix}-${color.name.slice(0, 3).toUpperCase()}-${size}`,
            name: `${color.name} / ${size}`,
            size,
            color: color.name,
            colorCode: color.code,
          })),
        )
      : [{ sku: `INK-${prefix}-STD`, name: "Standard", size: undefined, color: undefined, colorCode: undefined }];

    for (const spec of variantSpecs) {
      const variantId = await ensure({
        table: productVariants,
        values: {
          productId,
          sku: spec.sku,
          name: spec.name,
          size: spec.size ?? null,
          color: spec.color ?? null,
          colorCode: spec.colorCode ?? null,
          price: seed.price,
          compareAtPrice: seed.compareAt ?? null,
          availability: "IN_STOCK" as const,
          weightGrams: isApparel ? 260 : 350,
        },
        target: productVariants.sku,
        selectBy: { column: productVariants.sku, value: spec.sku },
      });
      await adjustInventory(
        { id: adminId },
        {
          productId,
          variantId,
          operation: "STOCK_IN",
          quantity: 10,
          referenceType: "IMPORT_BATCH",
          referenceId: `development-seed:${spec.sku}`,
          reason: "Development seed opening inventory",
        },
      );
      variantCount += 1;
    }
  }
  console.log(`  products ✓ (${seedProducts.length} products, ${variantCount} variants)`);

  /* ── POD provider + mappings (PLAACEHOLDER supplier IDs for dev) ── */
  const providerId = await ensure({
    table: podProviders,
    values: {
      name: "Printrove (sandbox placeholder)",
      code: "printrove",
      status: "TESTING" as const,
      isDefault: true,
      config: {
        baseUrl: "https://api.printrove.com",
        note: "Development placeholder — configure real credentials via environment before live fulfillment.",
      },
    },
    target: podProviders.code,
    selectBy: { column: podProviders.code, value: "printrove" },
  });

  const allProducts = await db.select().from(products);
  for (const product of allProducts) {
    await db
      .insert(podProductMappings)
      .values({
        providerId,
        productId: product.id,
        supplierProductId: `PRT-${product.slug.toUpperCase().replace(/-/g, "_")}`,
        baseCost: Math.round(product.basePrice * 0.55),
        isActive: true,
      })
      .onConflictDoNothing({ target: [podProductMappings.providerId, podProductMappings.productId] });

    const variants = await db.select().from(productVariants).where(eq(productVariants.productId, product.id));
    for (const variant of variants) {
      await db
        .insert(podVariantMappings)
        .values({
          providerId,
          variantId: variant.id,
          supplierVariantId: `PRTV-${variant.sku}`,
          cost: Math.round(variant.price * 0.55),
          isActive: true,
        })
        .onConflictDoNothing({ target: [podVariantMappings.providerId, podVariantMappings.variantId] });
    }
  }
  console.log("  POD provider + mappings ✓ (placeholder IDs, TESTING status)");

  /* ── Coupon ─────────────────────────────────────────────────────── */
  await ensure({
    table: coupons,
    values: {
      code: "WELCOME10",
      type: "PERCENTAGE" as const,
      value: 10,
      minimumOrderAmount: 99900,
      maximumDiscountAmount: 30000,
      isActive: true,
    },
    target: coupons.code,
    selectBy: { column: coupons.code, value: "WELCOME10" },
  });
  console.log("  coupon ✓ (WELCOME10 — 10% off over ₹999)");

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
