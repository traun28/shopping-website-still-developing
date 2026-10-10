import "server-only";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  productPriceRules,
  products,
  productVariants,
  type PriceRule as PriceRuleRow,
} from "@/db/schema";
import type { DbClient } from "@/db/utils";
import { withTransaction } from "@/db/utils";
import { emitCatalogEvent } from "@/services/catalog/events.service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  DISCOUNT_TYPES,
  PIPELINE_ORDER,
  PRICE_RULE_TYPES,
  assertValidRule,
  authoritativePrice,
  grossMarginPaise,
  marginBasisPoints,
  percentOff,
  quotePrice,
  type CouponInput,
  type DiscountType,
  type PriceContext,
  type PriceQuote,
  type PriceRule,
  type PriceRuleType,
} from "@/lib/catalog/pricing";

/**
 * Pricing engine — the database side of `src/lib/catalog/pricing.ts`.
 *
 * The pure module owns the arithmetic; this module owns *which rules apply to
 * which product* and when a change is worth an event.
 *
 * The load-bearing decision, recorded here because it is easy to undo by
 * accident: **the list price lives on `products`/`product_variants` and every
 * discount is a row in `product_price_rules`.** The original price is therefore
 * always recoverable, a promotion can be switched off without editing a price,
 * and "was this ever full price?" is answerable from history rather than memory.
 */

export interface PriceRuleInput {
  ruleType?: PriceRuleType;
  discountType: DiscountType;
  /** PERCENTAGE → basis points (2500 = 25%). FIXED_AMOUNT → paise. */
  discountValue: number;
  maxDiscountPaise?: number | null;
  priority?: number | null;
  stackable?: boolean | null;
  name?: string | null;
  variantId?: string | null;
  sellerId?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  isActive?: boolean | null;
}

export interface ProductPricing {
  productId: string;
  originalPaise: number;
  finalPaise: number;
  discountPaise: number;
  discountPercent: number | null;
  compareAtPaise: number | null;
  taxBasisPoints: number;
  taxPaise: number;
  totalWithTaxPaise: number;
  rulesApplied: number;
  steps: PriceQuote["steps"];
}

/* ── validation ──────────────────────────────────────────────────────── */

export function validatePriceRuleInput(input: PriceRuleInput): string[] {
  const errors: string[] = [];

  if (!DISCOUNT_TYPES.includes(input.discountType)) {
    errors.push(`discountType must be one of ${DISCOUNT_TYPES.join(", ")}.`);
  }
  if (input.ruleType && !PRICE_RULE_TYPES.includes(input.ruleType)) {
    errors.push(`ruleType must be one of ${PRICE_RULE_TYPES.join(", ")}.`);
  }

  if (!Number.isInteger(input.discountValue) || input.discountValue <= 0) {
    errors.push("discountValue must be a positive whole number.");
  } else if (input.discountType === "PERCENTAGE" && input.discountValue > 10_000) {
    // Above 100% the rule would drive the price negative; the pure engine
    // clamps, but accepting it here would hide a data-entry mistake.
    errors.push("A percentage discount cannot exceed 10000 basis points (100%).");
  }

  if (
    input.maxDiscountPaise !== null &&
    input.maxDiscountPaise !== undefined &&
    (!Number.isInteger(input.maxDiscountPaise) || input.maxDiscountPaise < 0)
  ) {
    errors.push("maxDiscountPaise must be a non-negative whole number.");
  }
  if (
    input.maxDiscountPaise != null &&
    input.discountType !== "PERCENTAGE"
  ) {
    errors.push("maxDiscountPaise only applies to PERCENTAGE discounts.");
  }

  const starts = input.startsAt ? new Date(input.startsAt) : null;
  const ends = input.endsAt ? new Date(input.endsAt) : null;
  if (input.startsAt && starts && Number.isNaN(starts.getTime())) {
    errors.push("startsAt is not a valid date.");
  }
  if (input.endsAt && ends && Number.isNaN(ends.getTime())) {
    errors.push("endsAt is not a valid date.");
  }
  if (starts && ends && ends <= starts) {
    errors.push("endsAt must be after startsAt.");
  }

  return errors;
}

/* ── reads ───────────────────────────────────────────────────────────── */

/**
 * Rules that could apply to a product, ordered the way the pipeline consumes
 * them: stage first, then priority, then creation time.
 *
 * Product-wide rules (variantId NULL) are returned alongside variant-specific
 * ones; the caller decides which set to feed the engine.
 */
export async function listPriceRules(
  productId: string,
  options: { variantId?: string | null; includeInactive?: boolean } = {},
  client: DbClient = db,
): Promise<PriceRuleRow[]> {
  const scope = options.variantId
    ? or(isNull(productPriceRules.variantId), eq(productPriceRules.variantId, options.variantId))
    : isNull(productPriceRules.variantId);

  const filters = [eq(productPriceRules.productId, productId), scope];
  if (!options.includeInactive) filters.push(eq(productPriceRules.isActive, true));

  return client
    .select()
    .from(productPriceRules)
    .where(and(...filters))
    .orderBy(
      // Ordering by stage here is an optimisation, not a requirement: the pure
      // engine sorts by PIPELINE_ORDER itself. Doing it in SQL keeps the row
      // order in logs and the admin list readable.
      asc(productPriceRules.priority),
      asc(productPriceRules.createdAt),
    );
}

function toRule(row: PriceRuleRow): PriceRule {
  return {
    id: row.id,
    ruleType: row.ruleType,
    discountType: row.discountType,
    discountValue: row.discountValue,
    maxDiscountPaise: row.maxDiscountPaise,
    priority: row.priority,
    stackable: row.stackable,
    name: row.name,
    sellerId: row.sellerId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    isActive: row.isActive,
  };
}

/**
 * Quote a product's price through the full pipeline.
 *
 * `originalPaise` comes from the stored list price — never from the discounted
 * result — so the "was ₹X, now ₹Y" comparison is always honest.
 */
export async function quoteProductPrice(
  productId: string,
  options: { variantId?: string | null; context?: PriceContext; coupon?: CouponInput | null } = {},
  client: DbClient = db,
): Promise<ProductPricing> {
  const [product] = await client
    .select({
      id: products.id,
      basePrice: products.basePrice,
      compareAtPrice: products.compareAtPrice,
      taxRateBp: products.taxRateBp,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new NotFoundError("Product not found");

  let originalPaise = product.basePrice;
  let compareAtPaise = product.compareAtPrice;

  // A variant's own price overrides the product's, which is what makes per-size
  // or per-capacity pricing work without a second pricing model.
  if (options.variantId) {
    const [variant] = await client
      .select({
        price: productVariants.price,
        compareAtPrice: productVariants.compareAtPrice,
      })
      .from(productVariants)
      .where(and(eq(productVariants.id, options.variantId), eq(productVariants.productId, productId)))
      .limit(1);
    if (!variant) throw new NotFoundError("Variant not found for this product");
    originalPaise = variant.price;
    compareAtPaise = variant.compareAtPrice ?? compareAtPaise;
  }

  const rows = await listPriceRules(productId, { variantId: options.variantId ?? null }, client);
  const rules = rows.map(toRule);

  const quote = quotePrice(originalPaise, rules, {
    compareAtPaise,
    taxBasisPoints: product.taxRateBp,
    context: { ...options.context, coupon: options.coupon ?? options.context?.coupon ?? null },
  });

  return {
    productId,
    originalPaise: quote.originalPaise,
    finalPaise: quote.finalPaise,
    discountPaise: quote.discountPaise,
    discountPercent: quote.discountPercent,
    compareAtPaise: quote.compareAtPaise,
    taxBasisPoints: quote.taxBasisPoints,
    taxPaise: quote.taxPaise,
    totalWithTaxPaise: quote.totalWithTaxPaise,
    rulesApplied: quote.steps.filter((step) => step.discountPaise > 0).length,
    steps: quote.steps,
  };
}

/**
 * Quote many products in one pass, for listing pages.
 *
 * Rules are fetched for the whole batch at once. Quoting per product would be
 * N+1 queries on every category page, which is exactly the kind of thing that
 * makes a catalog feel slow at 100k products.
 */
export async function quoteProductPrices(
  productIds: readonly string[],
  options: { context?: PriceContext } = {},
  client: DbClient = db,
): Promise<Map<string, ProductPricing>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();

  const [productRows, ruleRows] = await Promise.all([
    client
      .select({
        id: products.id,
        basePrice: products.basePrice,
        compareAtPrice: products.compareAtPrice,
        taxRateBp: products.taxRateBp,
      })
      .from(products)
      .where(inArray(products.id, ids)),
    client
      .select()
      .from(productPriceRules)
      .where(and(inArray(productPriceRules.productId, ids), eq(productPriceRules.isActive, true))),
  ]);

  const rulesByProduct = new Map<string, PriceRule[]>();
  for (const row of ruleRows) {
    // Variant-specific rules are excluded from the batch path: a listing shows
    // the product's headline price, and picking one variant's rule would
    // misrepresent the others.
    if (row.variantId) continue;
    const list = rulesByProduct.get(row.productId) ?? [];
    list.push(toRule(row));
    rulesByProduct.set(row.productId, list);
  }

  const out = new Map<string, ProductPricing>();
  for (const product of productRows) {
    const rules = rulesByProduct.get(product.id) ?? [];
    const quote = quotePrice(product.basePrice, rules, {
      compareAtPaise: product.compareAtPrice,
      taxBasisPoints: product.taxRateBp,
      context: options.context,
    });
    out.set(product.id, {
      productId: product.id,
      originalPaise: quote.originalPaise,
      finalPaise: quote.finalPaise,
      discountPaise: quote.discountPaise,
      discountPercent: quote.discountPercent,
      compareAtPaise: quote.compareAtPaise,
      taxBasisPoints: quote.taxBasisPoints,
      taxPaise: quote.taxPaise,
      totalWithTaxPaise: quote.totalWithTaxPaise,
      rulesApplied: quote.steps.filter((step) => step.discountPaise > 0).length,
      steps: quote.steps,
    });
  }
  return out;
}

/**
 * Quote a batch of specific purchasable variants in one authoritative pass.
 *
 * Cart, saved-item and wishlist reads use this instead of variant.price so
 * product- and variant-level promotions, seller rules and tax estimates stay
 * aligned with the existing pricing pipeline without an N+1 query per line.
 */
export async function quoteVariantPrices(
  variantIds: readonly string[],
  options: { context?: PriceContext } = {},
  client: DbClient = db,
): Promise<Map<string, ProductPricing>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();

  const variants = await client
    .select({
      variantId: productVariants.id,
      productId: products.id,
      price: productVariants.price,
      compareAtPrice: productVariants.compareAtPrice,
      productCompareAtPrice: products.compareAtPrice,
      taxRateBp: products.taxRateBp,
      sellerId: products.sellerId,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, ids));
  if (variants.length === 0) return new Map();

  const productIds = [...new Set(variants.map((row) => row.productId))];
  const ruleRows = await client
    .select()
    .from(productPriceRules)
    .where(and(inArray(productPriceRules.productId, productIds), eq(productPriceRules.isActive, true)));
  const rulesByProduct = new Map<string, PriceRuleRow[]>();
  for (const row of ruleRows) {
    const list = rulesByProduct.get(row.productId) ?? [];
    list.push(row);
    rulesByProduct.set(row.productId, list);
  }

  const out = new Map<string, ProductPricing>();
  for (const variant of variants) {
    const rules = (rulesByProduct.get(variant.productId) ?? [])
      .filter((row) => row.variantId === null || row.variantId === variant.variantId)
      .map(toRule);
    const quote = quotePrice(variant.price, rules, {
      compareAtPaise: variant.compareAtPrice ?? variant.productCompareAtPrice,
      taxBasisPoints: variant.taxRateBp,
      context: { ...options.context, sellerId: options.context?.sellerId ?? variant.sellerId },
    });
    out.set(variant.variantId, {
      productId: variant.productId,
      originalPaise: quote.originalPaise,
      finalPaise: quote.finalPaise,
      discountPaise: quote.discountPaise,
      discountPercent: quote.discountPercent,
      compareAtPaise: quote.compareAtPaise,
      taxBasisPoints: quote.taxBasisPoints,
      taxPaise: quote.taxPaise,
      totalWithTaxPaise: quote.totalWithTaxPaise,
      rulesApplied: quote.steps.filter((step) => step.discountPaise > 0).length,
      steps: quote.steps,
    });
  }
  return out;
}

/* ── writes ──────────────────────────────────────────────────────────── */

export async function createPriceRule(
  productId: string,
  input: PriceRuleInput,
  options: { actorId?: string | null } = {},
): Promise<PriceRuleRow> {
  const errors = validatePriceRuleInput(input);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  const rule: PriceRule = {
    ruleType: input.ruleType ?? "AUTOMATIC",
    discountType: input.discountType,
    discountValue: input.discountValue,
    maxDiscountPaise: input.maxDiscountPaise ?? null,
    priority: input.priority ?? 100,
    stackable: input.stackable ?? true,
    name: input.name ?? "Discount",
    sellerId: input.sellerId ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    isActive: input.isActive ?? true,
  };
  // The pure engine's own invariants — a rule that fails them would be silently
  // skipped at quote time, which is much harder to debug than a rejection here.
  assertValidRule(rule);

  return withTransaction(async (tx) => {
    const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1);
    if (!product) throw new NotFoundError("Product not found");

    if (input.variantId) {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.id, input.variantId), eq(productVariants.productId, productId)))
        .limit(1);
      if (!variant) throw new ValidationError("That variant does not belong to this product.");
    }

    const [row] = await tx
      .insert(productPriceRules)
      .values({
        productId,
        variantId: input.variantId ?? null,
        ruleType: rule.ruleType,
        discountType: rule.discountType,
        discountValue: rule.discountValue,
        maxDiscountPaise: rule.maxDiscountPaise ?? null,
        priority: rule.priority,
        stackable: rule.stackable,
        name: rule.name ?? "Discount",
        sellerId: rule.sellerId ?? null,
        startsAt: rule.startsAt ? new Date(rule.startsAt) : null,
        endsAt: rule.endsAt ? new Date(rule.endsAt) : null,
        isActive: rule.isActive,
      })
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "PRICE_CHANGED",
      aggregateType: "product",
      aggregateId: productId,
      payload: {
        reason: "rule_created",
        ruleId: row.id,
        ruleType: row.ruleType,
        discountType: row.discountType,
        discountValue: row.discountValue,
      },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

export async function updatePriceRule(
  ruleId: string,
  input: Partial<PriceRuleInput>,
  options: { actorId?: string | null } = {},
): Promise<PriceRuleRow> {
  const [current] = await db.select().from(productPriceRules).where(eq(productPriceRules.id, ruleId)).limit(1);
  if (!current) throw new NotFoundError("Price rule not found");

  const merged: PriceRuleInput = { ...current, ...input };
  const errors = validatePriceRuleInput(merged);
  if (errors.length) throw new ValidationError(errors[0]!, errors);

  const rule: PriceRule = {
    ruleType: merged.ruleType ?? current.ruleType,
    discountType: merged.discountType ?? current.discountType,
    discountValue: merged.discountValue ?? current.discountValue,
    maxDiscountPaise: merged.maxDiscountPaise ?? null,
    priority: merged.priority ?? current.priority,
    stackable: merged.stackable ?? current.stackable,
    name: merged.name ?? current.name,
    sellerId: merged.sellerId ?? null,
    startsAt: merged.startsAt ?? null,
    endsAt: merged.endsAt ?? null,
    isActive: merged.isActive ?? current.isActive,
  };
  assertValidRule(rule);

  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(productPriceRules)
      .set({
        ruleType: rule.ruleType,
        discountType: rule.discountType,
        discountValue: rule.discountValue,
        maxDiscountPaise: rule.maxDiscountPaise ?? null,
        priority: rule.priority,
        stackable: rule.stackable,
        name: rule.name ?? "Discount",
        sellerId: rule.sellerId ?? null,
        startsAt: rule.startsAt ? new Date(rule.startsAt) : null,
        endsAt: rule.endsAt ? new Date(rule.endsAt) : null,
        isActive: rule.isActive,
      })
      .where(eq(productPriceRules.id, ruleId))
      .returning();

    await emitCatalogEvent(tx, {
      eventType: "PRICE_CHANGED",
      aggregateType: "product",
      aggregateId: row.productId,
      payload: { reason: "rule_updated", ruleId: row.id },
      actorId: options.actorId ?? null,
    });

    return row;
  });
}

/**
 * Retire a rule instead of deleting it.
 *
 * Past orders were priced under this rule; deleting it would make a historical
 * price unexplainable. Deactivation preserves the audit trail.
 */
export async function deactivatePriceRule(
  ruleId: string,
  options: { actorId?: string | null } = {},
): Promise<PriceRuleRow> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(productPriceRules)
      .set({ isActive: false })
      .where(eq(productPriceRules.id, ruleId))
      .returning();
    if (!row) throw new NotFoundError("Price rule not found");

    await emitCatalogEvent(tx, {
      eventType: "PRICE_CHANGED",
      aggregateType: "product",
      aggregateId: row.productId,
      payload: { reason: "rule_deactivated", ruleId: row.id },
      actorId: options.actorId ?? null,
    });
    return row;
  });
}

/** Rules that have finished their window — the cleanup report. */
export async function listExpiredRules(
  limit = 100,
  client: DbClient = db,
): Promise<PriceRuleRow[]> {
  return client
    .select()
    .from(productPriceRules)
    .where(and(eq(productPriceRules.isActive, true), sql`${productPriceRules.endsAt} < now()`))
    .orderBy(asc(productPriceRules.endsAt))
    .limit(limit);
}

/* ── margin reporting (admin only) ───────────────────────────────────── */

export interface MarginReport {
  productId: string;
  basePrice: number;
  costPrice: number | null;
  grossMarginPaise: number | null;
  marginBasisPoints: number | null;
  discountPercent: number | null;
}

/**
 * Margin per product. Internal only — this must never reach a public route.
 *
 * `costPrice` is a private field; the DTO layer strips it, and this function is
 * the only place it is meant to surface.
 */
export async function marginReport(
  productIds: readonly string[],
  client: DbClient = db,
): Promise<MarginReport[]> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return [];

  const rows = await client
    .select({
      id: products.id,
      basePrice: products.basePrice,
      costPrice: products.costPrice,
      taxRateBp: products.taxRateBp,
    })
    .from(products)
    .where(inArray(products.id, ids));

  const quotes = await quoteProductPrices(ids, {}, client);

  return rows.map((row) => {
    const quote = quotes.get(row.id);
    const finalPaise = quote?.finalPaise ?? row.basePrice;
    const margin = grossMarginPaise({ sellingPaise: finalPaise, costPaise: row.costPrice });
    return {
      productId: row.id,
      basePrice: row.basePrice,
      costPrice: row.costPrice,
      grossMarginPaise: margin,
      marginBasisPoints: marginBasisPoints({ sellingPaise: finalPaise, costPaise: row.costPrice }),
      discountPercent: quote ? percentOff(quote.originalPaise, quote.finalPaise) : null,
    };
  });
}

/**
 * The price a buyer is actually charged, resolved the same way for every caller.
 *
 * Having one function do this is the point: a checkout path that computed the
 * price differently from the PDP would show one number and charge another.
 *
 * `clientPaise` is the figure the browser sent back. It is compared, never
 * trusted — a mismatch means a stale page or a tampered client, and in both
 * cases the server figure wins.
 */
export async function authoritativeProductPrice(
  productId: string,
  options: { variantId?: string | null; clientPaise?: number | null } = {},
  client: DbClient = db,
): Promise<{ pricePaise: number; mismatch: boolean; totalWithTaxPaise: number }> {
  const quote = await quoteProductPrice(productId, options, client);
  const resolved = authoritativePrice({
    serverPaise: quote.finalPaise,
    clientPaise: options.clientPaise ?? null,
  });
  return { ...resolved, totalWithTaxPaise: quote.totalWithTaxPaise };
}

export const PRICING_INTERNALS = {
  PIPELINE_ORDER,
  DISCOUNT_TYPES,
  PRICE_RULE_TYPES,
} as const;
