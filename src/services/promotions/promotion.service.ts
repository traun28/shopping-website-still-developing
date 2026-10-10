import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  brands,
  categories,
  carts,
  catalogEvents,
  collections,
  couponUsages,
  coupons,
  productCategories,
  productCollections,
  products,
  productVariants,
  promotionCampaigns,
  promotionRedemptions,
  promotionTargets,
  promotionVersions,
  promotions,
  users,
  type Promotion,
} from "@/db/schema";
import { withTransaction, type DbClient, type DbTx } from "@/db/utils";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { evaluatePromotionCart, applyPromotionEvaluationToCart } from "@/lib/promotions/engine";
import type {
  PromotionCandidate,
  PromotionCartLine,
  PromotionConfig,
  PromotionEligibility,
  PromotionEvaluation,
  PromotionTarget,
} from "@/lib/promotions/types";
import { normalizeCouponCode } from "@/lib/promotions/utils";
import { campaignUpdateSchema, campaignWriteSchema, promotionConfigSchema, promotionEligibilitySchema, promotionUpdateSchema, promotionWriteSchema, type PromotionWriteInput } from "@/validations/promotions";
import { writeAudit } from "@/services/audit.service";
import { calculateCartTotals } from "@/services/cart/totals.service";
import { quoteVariantPrices } from "@/services/catalog/pricing.service";
import type { CartDTO, CartLineDTO } from "@/types/cart";

interface PromotionDbRow {
  id: string;
  campaignId: string | null;
  name: string;
  description: string | null;
  strategy: string;
  status: string;
  discountConfig: Record<string, unknown>;
  eligibility: Record<string, unknown>;
  priority: number;
  stackable: boolean;
  stackGroup: string | null;
  isAutomatic: boolean;
  applyToCatalog: boolean;
  currency: string;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  version: number;
  campaignStatus: string | null;
  campaignStartsAt: Date | null;
  campaignEndsAt: Date | null;
}

interface CouponRow {
  id: string;
  code: string;
  promotionId: string | null;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
  value: number;
  minimumOrderAmount: number | null;
  maximumDiscountAmount: number | null;
  usageLimit: number | null;
  perUserLimit: number | null;
  usageCount: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
}

export interface AppliedCouponPreview {
  valid: boolean;
  couponId: string | null;
  promotionId: string | null;
  code: string;
  discountPaise: number;
  reason: string;
  evaluation: PromotionEvaluation;
  cart: CartDTO;
  /** Internal use only, never returned by a public endpoint. */
  coupon?: CouponRow;
  candidate?: PromotionCandidate;
  allocation?: PromotionEvaluation["allocations"][number];
}

const SAFE_COUPON_MESSAGE = "This code is invalid or unavailable for this cart.";
const MAX_ACTIVE_PROMOTIONS = 500;

export { normalizeCouponCode };

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new ValidationError("Choose a valid IANA time zone.");
  }
}

function configForCoupon(config: PromotionConfig): { type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING"; value: number; maximumDiscountAmount: number | null } {
  switch (config.strategy) {
    case "PERCENTAGE_OFF": return { type: "PERCENTAGE", value: Math.floor(config.discountBasisPoints / 100), maximumDiscountAmount: config.maxDiscountPaise ?? null };
    case "FIXED_AMOUNT_OFF": return { type: "FIXED_AMOUNT", value: config.amountPaise, maximumDiscountAmount: null };
    case "FREE_SHIPPING": return { type: "FREE_SHIPPING", value: 0, maximumDiscountAmount: null };
    case "CART_THRESHOLD":
      return config.discountType === "PERCENTAGE"
        ? { type: "PERCENTAGE", value: Math.floor(config.value / 100), maximumDiscountAmount: config.maxDiscountPaise ?? null }
        : { type: "FIXED_AMOUNT", value: config.value, maximumDiscountAmount: null };
    case "QUANTITY_TIER": {
      const highest = [...config.tiers].sort((a, b) => a.minQuantity - b.minQuantity).at(-1)!;
      return highest.discountType === "PERCENTAGE"
        ? { type: "PERCENTAGE", value: Math.floor(highest.value / 100), maximumDiscountAmount: highest.maxDiscountPaise ?? null }
        : { type: "FIXED_AMOUNT", value: highest.value, maximumDiscountAmount: null };
    }
    case "BUY_X_GET_Y": return { type: "PERCENTAGE", value: Math.floor(config.rewardBasisPoints / 100), maximumDiscountAmount: null };
    case "BUNDLE": return { type: "PERCENTAGE", value: Math.floor(config.discountBasisPoints / 100), maximumDiscountAmount: null };
  }
}

function couponValues(input: PromotionWriteInput): {
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
  value: number;
  minimumOrderAmount: number | null;
  maximumDiscountAmount: number | null;
} {
  const legacy = configForCoupon(input.config as PromotionConfig);
  const strategyMinimum = input.config.strategy === "CART_THRESHOLD" ? input.config.thresholdPaise : null;
  return {
    type: legacy.type,
    value: legacy.value,
    minimumOrderAmount: input.eligibility.minimumCartSubtotalPaise ?? strategyMinimum,
    maximumDiscountAmount: legacy.maximumDiscountAmount,
  };
}

function serializePromotion(row: Promotion): Record<string, unknown> {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    description: row.description,
    strategy: row.strategy,
    status: row.status,
    discountConfig: row.discountConfig,
    eligibility: row.eligibility,
    priority: row.priority,
    stackable: row.stackable,
    stackGroup: row.stackGroup,
    isAutomatic: row.isAutomatic,
    applyToCatalog: row.applyToCatalog,
    currency: row.currency,
    totalUsageLimit: row.totalUsageLimit,
    perCustomerUsageLimit: row.perCustomerUsageLimit,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    timezone: row.timezone,
    version: row.version,
  };
}

async function validateTargets(client: DbClient, targets: PromotionWriteInput["targets"]): Promise<void> {
  const byDimension = new Map<string, string[]>();
  for (const target of targets) {
    const list = byDimension.get(target.dimension) ?? [];
    list.push(target.entityId);
    byDimension.set(target.dimension, list);
  }
  const checks: Array<{ dimension: string; found: string[] }> = [];
  for (const [dimension, ids] of byDimension) {
    const unique = [...new Set(ids)];
    switch (dimension) {
      case "PRODUCT": checks.push({ dimension, found: (await client.select({ id: products.id }).from(products).where(inArray(products.id, unique))).map((row) => row.id) }); break;
      case "CATEGORY": checks.push({ dimension, found: (await client.select({ id: categories.id }).from(categories).where(inArray(categories.id, unique))).map((row) => row.id) }); break;
      case "BRAND": checks.push({ dimension, found: (await client.select({ id: brands.id }).from(brands).where(inArray(brands.id, unique))).map((row) => row.id) }); break;
      case "COLLECTION": checks.push({ dimension, found: (await client.select({ id: collections.id }).from(collections).where(inArray(collections.id, unique))).map((row) => row.id) }); break;
      case "CUSTOMER": checks.push({ dimension, found: (await client.select({ id: users.id }).from(users).where(inArray(users.id, unique))).map((row) => row.id) }); break;
      case "SELLER": checks.push({ dimension, found: (await client.select({ id: users.id }).from(users).where(inArray(users.id, unique))).map((row) => row.id) }); break;
    }
  }
  const missing = checks.flatMap(({ dimension, found }) => {
    const requested = byDimension.get(dimension) ?? [];
    return requested.filter((id) => !found.includes(id)).map(() => dimension);
  });
  if (missing.length) throw new ValidationError("One or more promotion targets no longer exist.");
}

async function insertTargets(client: DbClient, promotionId: string, targets: PromotionWriteInput["targets"]): Promise<void> {
  if (targets.length) {
    await client.insert(promotionTargets).values(targets.map((target) => ({ promotionId, ...target })));
  }
}

function validateWriteInput(raw: unknown): PromotionWriteInput {
  const parsed = promotionWriteSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Promotion configuration is invalid.");
  assertValidTimezone(parsed.data.timezone);
  const config = promotionConfigSchema.parse(parsed.data.config);
  const eligibility = promotionEligibilitySchema.parse(parsed.data.eligibility);
  if (config.strategy !== parsed.data.strategy) throw new ValidationError("Discount configuration must match the selected strategy.");
  if (parsed.data.isAutomatic && (parsed.data.totalUsageLimit != null || parsed.data.perCustomerUsageLimit != null)) {
    throw new ValidationError("Usage-limited automatic promotions need a reservation flow; use a code-based coupon until that is configured.");
  }
  if (parsed.data.applyToCatalog) {
    throw new ValidationError("Catalog-detail price badges are not wired to this domain yet. Promotions can currently apply at cart and checkout.");
  }
  return parsed.data;
}

function toPromotionCandidate(
  row: PromotionDbRow,
  targets: PromotionTarget[],
  coupon: CouponRow | null = null,
): PromotionCandidate | null {
  const config = promotionConfigSchema.safeParse(row.discountConfig);
  const eligibility = promotionEligibilitySchema.safeParse(row.eligibility);
  if (!config.success || !eligibility.success || config.data.strategy !== row.strategy) return null;
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    status: row.status,
    strategy: row.strategy as PromotionCandidate["strategy"],
    config: config.data as PromotionConfig,
    eligibility: eligibility.data as PromotionEligibility,
    targets,
    priority: row.priority,
    stackable: row.stackable,
    stackGroup: row.stackGroup,
    currency: row.currency,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    campaignStartsAt: row.campaignStartsAt,
    campaignEndsAt: row.campaignEndsAt,
    campaignStatus: row.campaignStatus,
    usageLimit: row.totalUsageLimit,
    perCustomerLimit: row.perCustomerUsageLimit,
    isAutomatic: row.isAutomatic,
    couponId: coupon?.id ?? null,
    couponCode: coupon?.code ?? null,
  };
}

async function selectPromotionRows(client: DbClient, conditions: Parameters<typeof and>[0][]): Promise<PromotionDbRow[]> {
  const rows = await client.select({
    id: promotions.id,
    campaignId: promotions.campaignId,
    name: promotions.name,
    description: promotions.description,
    strategy: promotions.strategy,
    status: promotions.status,
    discountConfig: promotions.discountConfig,
    eligibility: promotions.eligibility,
    priority: promotions.priority,
    stackable: promotions.stackable,
    stackGroup: promotions.stackGroup,
    isAutomatic: promotions.isAutomatic,
    applyToCatalog: promotions.applyToCatalog,
    currency: promotions.currency,
    totalUsageLimit: promotions.totalUsageLimit,
    perCustomerUsageLimit: promotions.perCustomerUsageLimit,
    startsAt: promotions.startsAt,
    endsAt: promotions.endsAt,
    version: promotions.version,
    campaignStatus: promotionCampaigns.status,
    campaignStartsAt: promotionCampaigns.startsAt,
    campaignEndsAt: promotionCampaigns.endsAt,
  })
    .from(promotions)
    .leftJoin(promotionCampaigns, eq(promotionCampaigns.id, promotions.campaignId))
    .where(and(...conditions))
    .orderBy(desc(promotions.priority), asc(promotions.id))
    .limit(MAX_ACTIVE_PROMOTIONS);
  return rows;
}

async function candidatesFromRows(client: DbClient, rows: PromotionDbRow[], coupon: CouponRow | null = null): Promise<PromotionCandidate[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const targetRows = await client.select().from(promotionTargets).where(inArray(promotionTargets.promotionId, ids));
  const targetsByPromotion = new Map<string, PromotionTarget[]>();
  for (const target of targetRows) {
    const list = targetsByPromotion.get(target.promotionId) ?? [];
    list.push({
      dimension: target.dimension as PromotionTarget["dimension"],
      entityId: target.entityId,
      mode: target.mode as PromotionTarget["mode"],
    });
    targetsByPromotion.set(target.promotionId, list);
  }
  return rows.map((row) => toPromotionCandidate(row, targetsByPromotion.get(row.id) ?? [], coupon?.promotionId === row.id ? coupon : null)).filter((candidate): candidate is PromotionCandidate => candidate !== null);
}

async function loadAutomaticCandidates(client: DbClient, currency: string, now: Date): Promise<PromotionCandidate[]> {
  const rows = await selectPromotionRows(client, [
    eq(promotions.status, "ACTIVE"),
    eq(promotions.isAutomatic, true),
    eq(promotions.currency, currency),
    or(isNull(promotions.startsAt), lte(promotions.startsAt, now))!,
    or(isNull(promotions.endsAt), gt(promotions.endsAt, now))!,
  ]);
  return candidatesFromRows(client, rows);
}

async function lookupCoupon(client: DbClient, code: string, now: Date, options: { includeInactive?: boolean } = {}): Promise<CouponRow | null> {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return null;
  const conditions = [
    sql`upper(${coupons.code}) = ${normalized}`,
    or(isNull(coupons.startsAt), lte(coupons.startsAt, now))!,
    or(isNull(coupons.expiresAt), gt(coupons.expiresAt, now))!,
  ];
  if (!options.includeInactive) conditions.push(eq(coupons.isActive, true));
  const [row] = await client.select().from(coupons)
    .where(and(...conditions))
    .limit(1);
  return row ? {
    id: row.id,
    code: row.code,
    promotionId: row.promotionId,
    type: row.type,
    value: row.value,
    minimumOrderAmount: row.minimumOrderAmount,
    maximumDiscountAmount: row.maximumDiscountAmount,
    usageLimit: row.usageLimit,
    perUserLimit: row.perUserLimit,
    usageCount: row.usageCount,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
  } : null;
}

async function loadCouponCandidate(client: DbClient, coupon: CouponRow, currency: string, options: { includeInactive?: boolean } = {}): Promise<PromotionCandidate | null> {
  if (!coupon.promotionId) return null;
  const conditions = [eq(promotions.id, coupon.promotionId), eq(promotions.currency, currency)];
  if (!options.includeInactive) conditions.push(eq(promotions.status, "ACTIVE"));
  const rows = await selectPromotionRows(client, conditions);
  return (await candidatesFromRows(client, rows, coupon))[0] ?? null;
}

async function buildPromotionLines(cart: CartDTO, client: DbClient): Promise<PromotionCartLine[]> {
  const productIds = [...new Set(cart.items.map((line) => line.productId))];
  if (!productIds.length) return [];
  const [productRows, categoryRows, collectionRows] = await Promise.all([
    client.select({ id: products.id, categoryId: products.categoryId, brandId: products.brandId, sellerId: products.sellerId })
      .from(products).where(inArray(products.id, productIds)),
    client.select({ productId: productCategories.productId, categoryId: productCategories.categoryId })
      .from(productCategories).where(inArray(productCategories.productId, productIds)),
    client.select({ productId: productCollections.productId, collectionId: productCollections.collectionId })
      .from(productCollections).where(inArray(productCollections.productId, productIds)),
  ]);
  const productById = new Map(productRows.map((row) => [row.id, row]));
  const categoriesByProduct = new Map<string, string[]>();
  for (const row of categoryRows) {
    const ids = categoriesByProduct.get(row.productId) ?? [];
    ids.push(row.categoryId);
    categoriesByProduct.set(row.productId, ids);
  }
  const collectionsByProduct = new Map<string, string[]>();
  for (const row of collectionRows) {
    const ids = collectionsByProduct.get(row.productId) ?? [];
    ids.push(row.collectionId);
    collectionsByProduct.set(row.productId, ids);
  }
  for (const row of productRows) {
    if (row.categoryId) {
      const ids = categoriesByProduct.get(row.id) ?? [];
      if (!ids.includes(row.categoryId)) ids.push(row.categoryId);
      categoriesByProduct.set(row.id, ids);
    }
  }
  return cart.items.map((line) => {
    const product = productById.get(line.productId);
    return {
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      sellerId: product?.sellerId ?? line.sellerId,
      categoryIds: categoriesByProduct.get(line.productId) ?? [],
      brandId: product?.brandId ?? null,
      collectionIds: collectionsByProduct.get(line.productId) ?? [],
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise ?? 0,
      lineSubtotalPaise: line.lineSubtotalPaise,
      currency: line.currency,
    };
  });
}

function addApplications<T extends CartDTO>(cart: T, evaluation: PromotionEvaluation, candidates: PromotionCandidate[], code: string | null): T {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const applications = evaluation.allocations.map((allocation) => {
    const candidate = candidateById.get(allocation.promotionId);
    return {
      promotionId: allocation.promotionId,
      name: allocation.promotionName,
      discountPaise: allocation.amountPaise,
      couponId: allocation.couponId,
      couponCode: allocation.couponId ? candidate?.couponCode ?? code : null,
    };
  });
  return { ...cart, promotionApplications: applications };
}

async function evaluateCandidates(
  cart: CartDTO,
  candidates: PromotionCandidate[],
  userId: string | null,
  client: DbClient,
  now: Date,
): Promise<PromotionEvaluation> {
  const lines = await buildPromotionLines(cart, client);
  return evaluatePromotionCart({ candidates, lines, currency: cart.currency, context: { userId, now } });
}

export async function applyCartPromotions(
  cart: CartDTO,
  options: { userId?: string | null; couponCode?: string | null; now?: Date; client?: DbClient; checkoutSessionId?: string | null } = {},
): Promise<{ cart: CartDTO; evaluation: PromotionEvaluation; coupon: AppliedCouponPreview | null }> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const userId = options.userId ?? null;
  const automaticCandidates = await loadAutomaticCandidates(client, cart.currency, now);
  const normalizedCode = options.couponCode ? normalizeCouponCode(options.couponCode) : null;
  let coupon: CouponRow | null = null;
  let couponCandidate: PromotionCandidate | null = null;
  let couponUnavailable = false;
  if (options.couponCode) {
    coupon = await lookupCoupon(client, options.couponCode, now);
    if (coupon?.promotionId) couponCandidate = await loadCouponCandidate(client, coupon, cart.currency);
    couponUnavailable = !coupon || !couponCandidate;
    if (coupon && couponCandidate && !(await couponCapacityAvailable(client, couponCandidate, coupon, userId, options.checkoutSessionId ?? "", now))) couponUnavailable = true;
  }

  let candidates = [...automaticCandidates];
  if (couponCandidate && !couponUnavailable) candidates = [...candidates.filter((candidate) => candidate.id !== couponCandidate!.id), couponCandidate];
  let evaluation = await evaluateCandidates(cart, candidates, userId, client, now);
  let allocation = couponCandidate
    ? evaluation.allocations.find((item) => item.promotionId === couponCandidate!.id && item.couponId === coupon!.id)
    : undefined;
  if (options.couponCode && !allocation) {
    couponUnavailable = true;
    evaluation = await evaluateCandidates(cart, automaticCandidates, userId, client, now);
    candidates = automaticCandidates;
  }
  let adjusted = applyPromotionEvaluationToCart(cart, evaluation);
  adjusted = addApplications(adjusted, evaluation, candidates, normalizedCode);
  if (couponUnavailable) adjusted.promotionIssues = [SAFE_COUPON_MESSAGE];
  const couponPreview: AppliedCouponPreview | null = options.couponCode ? {
    valid: Boolean(allocation) && !couponUnavailable,
    couponId: allocation ? coupon?.id ?? null : null,
    promotionId: allocation ? couponCandidate?.id ?? null : null,
    code: normalizedCode ?? "",
    discountPaise: allocation?.amountPaise ?? 0,
    reason: allocation ? "Eligible." : SAFE_COUPON_MESSAGE,
    evaluation,
    cart: adjusted,
    coupon: allocation ? coupon ?? undefined : undefined,
    candidate: allocation ? couponCandidate ?? undefined : undefined,
    allocation,
  } : null;
  return { cart: adjusted, evaluation, coupon: couponPreview };
}

export async function previewCouponApplication(input: {
  cart: CartDTO;
  userId: string | null;
  code: string;
  client?: DbClient;
  now?: Date;
  checkoutSessionId?: string | null;
}): Promise<AppliedCouponPreview> {
  const result = await applyCartPromotions(input.cart, { userId: input.userId, couponCode: input.code, client: input.client, now: input.now, checkoutSessionId: input.checkoutSessionId });
  return result.coupon!;
}

function rowToWritePayload(row: Promotion): Record<string, unknown> {
  return serializePromotion(row);
}

async function recordPromotionVersion(client: DbClient, row: Promotion, actorId: string | null): Promise<void> {
  const [targets, couponRows] = await Promise.all([
    client.select({ dimension: promotionTargets.dimension, entityId: promotionTargets.entityId, mode: promotionTargets.mode })
      .from(promotionTargets).where(eq(promotionTargets.promotionId, row.id)),
    client.select({ id: coupons.id }).from(coupons).where(eq(coupons.promotionId, row.id)).limit(1),
  ]);
  await client.insert(promotionVersions).values({
    promotionId: row.id,
    version: row.version,
    snapshot: {
      ...rowToWritePayload(row),
      targets,
      couponConfigured: couponRows.length > 0,
    },
    actorId,
  });
}

async function emitPromotionEvent(
  client: DbClient,
  eventType: "PROMOTION_CREATED" | "PROMOTION_UPDATED" | "PROMOTION_ACTIVATED" | "PROMOTION_PAUSED" | "PROMOTION_ARCHIVED" | "CAMPAIGN_CREATED" | "CAMPAIGN_UPDATED" | "CAMPAIGN_ACTIVATED" | "CAMPAIGN_PAUSED" | "CAMPAIGN_ARCHIVED" | "PROMOTION_RESERVED" | "PROMOTION_RELEASED" | "COUPON_APPLIED" | "COUPON_REMOVED",
  aggregateType: "promotion" | "campaign" | "checkout",
  aggregateId: string,
  payload: Record<string, unknown>,
  actorId: string | null = null,
): Promise<void> {
  await client.insert(catalogEvents).values({ eventType, aggregateType, aggregateId, payload, actorId });
}

export async function listPromotions(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select({ promotion: promotions, campaignName: promotionCampaigns.name })
    .from(promotions)
    .leftJoin(promotionCampaigns, eq(promotionCampaigns.id, promotions.campaignId))
    .orderBy(desc(promotions.updatedAt), asc(promotions.name))
    .limit(500);
  const ids = rows.map(({ promotion }) => promotion.id);
  const [couponRows, targetRows] = ids.length ? await Promise.all([
    db.select({ id: coupons.id, promotionId: coupons.promotionId, code: coupons.code, isActive: coupons.isActive }).from(coupons).where(inArray(coupons.promotionId, ids)),
    db.select().from(promotionTargets).where(inArray(promotionTargets.promotionId, ids)),
  ]) : [[], []];
  const couponsByPromotion = new Map<string, Array<{ id: string; code: string; isActive: boolean }>>();
  const targetsByPromotion = new Map<string, Array<{ dimension: string; entityId: string; mode: string }>>();
  for (const target of targetRows) {
    const list = targetsByPromotion.get(target.promotionId) ?? [];
    list.push({ dimension: target.dimension, entityId: target.entityId, mode: target.mode });
    targetsByPromotion.set(target.promotionId, list);
  }
  for (const row of couponRows) {
    if (!row.promotionId) continue;
    const list = couponsByPromotion.get(row.promotionId) ?? [];
    list.push({ id: row.id, code: row.code, isActive: row.isActive });
    couponsByPromotion.set(row.promotionId, list);
  }
  return rows.map(({ promotion, campaignName }) => ({
    ...serializePromotion(promotion),
    campaignName,
    couponCodes: couponsByPromotion.get(promotion.id) ?? [],
    targets: targetsByPromotion.get(promotion.id) ?? [],
  }));
}

export async function createCampaign(input: unknown, actorId: string): Promise<Record<string, unknown>> {
  const parsed = campaignWriteSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Campaign details are invalid.");
  assertValidTimezone(parsed.data.timezone);
  const now = new Date();
  const result = await withTransaction(async (tx) => {
    const [row] = await tx.insert(promotionCampaigns).values({
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
      timezone: parsed.data.timezone,
      status: "DRAFT",
      createdBy: actorId,
      updatedBy: actorId,
    }).returning();
    if (!row) throw new ConflictError("Campaign could not be created.");
    await tx.insert(promotionVersions).values({ campaignId: row.id, version: row.version, snapshot: { ...row, startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null }, actorId });
    await emitPromotionEvent(tx, "CAMPAIGN_CREATED", "campaign", row.id, { version: row.version }, actorId);
    return row;
  });
  await writeAudit({ action: "promotion.campaign_created", entityType: "campaign", entityId: result.id, actorId, metadata: { version: result.version, codeLogged: false } });
  return { ...result, createdAt: result.createdAt.toISOString(), updatedAt: result.updatedAt.toISOString(), startsAt: result.startsAt?.toISOString() ?? null, endsAt: result.endsAt?.toISOString() ?? null };
}

export async function listCampaigns(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(promotionCampaigns).orderBy(desc(promotionCampaigns.updatedAt), asc(promotionCampaigns.name)).limit(250);
  const counts = rows.length ? await db.select({ campaignId: promotions.campaignId, count: count() }).from(promotions)
    .where(inArray(promotions.campaignId, rows.map((row) => row.id))).groupBy(promotions.campaignId) : [];
  const byCampaign = new Map(counts.map((row) => [row.campaignId, Number(row.count)]));
  return rows.map((row) => ({ ...row, promotionCount: byCampaign.get(row.id) ?? 0, startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null }));
}

export async function updateCampaign(campaignId: string, input: unknown, actorId: string): Promise<Record<string, unknown>> {
  const parsed = campaignUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Campaign details are invalid.");
  assertValidTimezone(parsed.data.timezone);
  const result = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, campaignId)).for("update").limit(1);
    if (!current) throw new NotFoundError("Campaign not found.");
    if (current.version !== parsed.data.expectedVersion) throw new ConflictError("Campaign changed in another request. Refresh and retry.", "CAMPAIGN_VERSION_CONFLICT");
    const now = new Date();
    const [updated] = await tx.update(promotionCampaigns).set({
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
      timezone: parsed.data.timezone,
      version: sql`${promotionCampaigns.version} + 1`,
      updatedBy: actorId,
      updatedAt: now,
    }).where(eq(promotionCampaigns.id, campaignId)).returning();
    if (!updated) throw new NotFoundError("Campaign not found.");
    await tx.insert(promotionVersions).values({ campaignId, version: updated.version, snapshot: { ...updated, startsAt: updated.startsAt?.toISOString() ?? null, endsAt: updated.endsAt?.toISOString() ?? null }, actorId });
    await emitPromotionEvent(tx, "CAMPAIGN_UPDATED", "campaign", campaignId, { version: updated.version }, actorId);
    return updated;
  });
  await writeAudit({ action: "promotion.campaign_updated", entityType: "campaign", entityId: campaignId, actorId, metadata: { version: result.version } });
  return { ...result, startsAt: result.startsAt?.toISOString() ?? null, endsAt: result.endsAt?.toISOString() ?? null };
}

export async function createPromotion(input: unknown, actorId: string): Promise<Record<string, unknown>> {
  const parsed = validateWriteInput(input);
  const couponCode = parsed.couponCode ? normalizeCouponCode(parsed.couponCode) : null;
  if (parsed.couponCode && !couponCode) throw new ValidationError("Coupon code must use 3–64 letters, digits, hyphens or underscores.");
  const couponConfig = couponValues(parsed);
  const result = await withTransaction(async (tx) => {
    await validateTargets(tx, parsed.targets);
    if (parsed.campaignId) {
      const [campaign] = await tx.select({ id: promotionCampaigns.id }).from(promotionCampaigns).where(eq(promotionCampaigns.id, parsed.campaignId)).limit(1);
      if (!campaign) throw new NotFoundError("Campaign not found.");
    }
    if (couponCode) {
      const [existing] = await tx.select({ id: coupons.id }).from(coupons).where(sql`upper(${coupons.code}) = ${couponCode}`).limit(1);
      if (existing) throw new ConflictError("That coupon code is already in use.", "COUPON_CODE_EXISTS");
    }
    const [row] = await tx.insert(promotions).values({
      campaignId: parsed.campaignId ?? null,
      name: parsed.name,
      description: parsed.description ?? null,
      strategy: parsed.strategy,
      status: "DRAFT",
      discountConfig: parsed.config,
      eligibility: parsed.eligibility,
      priority: parsed.priority,
      stackable: parsed.stackable,
      stackGroup: parsed.stackGroup ?? null,
      isAutomatic: parsed.isAutomatic,
      applyToCatalog: parsed.applyToCatalog,
      currency: parsed.currency,
      totalUsageLimit: parsed.totalUsageLimit ?? null,
      perCustomerUsageLimit: parsed.perCustomerUsageLimit ?? null,
      startsAt: parsed.startsAt ? new Date(parsed.startsAt) : null,
      endsAt: parsed.endsAt ? new Date(parsed.endsAt) : null,
      timezone: parsed.timezone,
      createdBy: actorId,
      updatedBy: actorId,
    }).returning();
    if (!row) throw new ConflictError("Promotion could not be created.");
    await insertTargets(tx, row.id, parsed.targets);
    if (couponCode) {
      await tx.insert(coupons).values({
        code: couponCode,
        promotionId: row.id,
        type: couponConfig.type,
        value: couponConfig.value,
        minimumOrderAmount: couponConfig.minimumOrderAmount,
        maximumDiscountAmount: couponConfig.maximumDiscountAmount,
        usageLimit: parsed.totalUsageLimit ?? null,
        perUserLimit: parsed.perCustomerUsageLimit ?? null,
        startsAt: parsed.startsAt ? new Date(parsed.startsAt) : null,
        expiresAt: parsed.endsAt ? new Date(parsed.endsAt) : null,
        isActive: false,
      });
    }
    await recordPromotionVersion(tx, row, actorId);
    await emitPromotionEvent(tx, "PROMOTION_CREATED", "promotion", row.id, { version: row.version, strategy: row.strategy }, actorId);
    return row;
  });
  await writeAudit({ action: "promotion.created", entityType: "promotion", entityId: result.id, actorId, metadata: { version: result.version, strategy: result.strategy, couponCodeLogged: false } });
  return { ...serializePromotion(result), couponCode: couponCode ? "configured" : null };
}

export async function updatePromotion(promotionId: string, input: unknown, actorId: string): Promise<Record<string, unknown>> {
  const parsed = promotionUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Promotion details are invalid.");
  const body = input as Record<string, unknown>;
  const expectedVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : null;
  if (expectedVersion === null || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ValidationError("A valid expectedVersion is required.");
  const write = validateWriteInput(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedVersion")));
  const couponCode = write.couponCode ? normalizeCouponCode(write.couponCode) : null;
  if (write.couponCode && !couponCode) throw new ValidationError("Coupon code must use 3–64 letters, digits, hyphens or underscores.");
  const nextCouponConfig = couponValues(write);
  const result = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for("update").limit(1);
    if (!current) throw new NotFoundError("Promotion not found.");
    if (current.version !== expectedVersion) throw new ConflictError("Promotion changed in another request. Refresh and retry.", "PROMOTION_VERSION_CONFLICT");
    await validateTargets(tx, write.targets);
    if (write.campaignId) {
      const [campaign] = await tx.select({ id: promotionCampaigns.id }).from(promotionCampaigns).where(eq(promotionCampaigns.id, write.campaignId)).limit(1);
      if (!campaign) throw new NotFoundError("Campaign not found.");
    }
    const [existingCoupon] = await tx.select().from(coupons).where(eq(coupons.promotionId, promotionId)).orderBy(asc(coupons.createdAt)).limit(1).for("update");
    if (couponCode) {
      const [collision] = await tx.select({ id: coupons.id }).from(coupons)
        .where(and(sql`upper(${coupons.code}) = ${couponCode}`, existingCoupon ? sql`${coupons.id} <> ${existingCoupon.id}` : sql`true`))
        .limit(1);
      if (collision) throw new ConflictError("That coupon code is already in use.", "COUPON_CODE_EXISTS");
    }
    const now = new Date();
    const [updated] = await tx.update(promotions).set({
      campaignId: write.campaignId ?? null,
      name: write.name,
      description: write.description ?? null,
      strategy: write.strategy,
      discountConfig: write.config,
      eligibility: write.eligibility,
      priority: write.priority,
      stackable: write.stackable,
      stackGroup: write.stackGroup ?? null,
      isAutomatic: write.isAutomatic,
      applyToCatalog: write.applyToCatalog,
      currency: write.currency,
      totalUsageLimit: write.totalUsageLimit ?? null,
      perCustomerUsageLimit: write.perCustomerUsageLimit ?? null,
      startsAt: write.startsAt ? new Date(write.startsAt) : null,
      endsAt: write.endsAt ? new Date(write.endsAt) : null,
      timezone: write.timezone,
      version: sql`${promotions.version} + 1`,
      updatedBy: actorId,
      updatedAt: now,
    }).where(eq(promotions.id, promotionId)).returning();
    if (!updated) throw new NotFoundError("Promotion not found.");
    await tx.delete(promotionTargets).where(eq(promotionTargets.promotionId, promotionId));
    await insertTargets(tx, promotionId, write.targets);
    if (couponCode && existingCoupon) {
      await tx.update(coupons).set({
        code: couponCode,
        type: nextCouponConfig.type,
        value: nextCouponConfig.value,
        minimumOrderAmount: nextCouponConfig.minimumOrderAmount,
        maximumDiscountAmount: nextCouponConfig.maximumDiscountAmount,
        usageLimit: write.totalUsageLimit ?? null,
        perUserLimit: write.perCustomerUsageLimit ?? null,
        startsAt: write.startsAt ? new Date(write.startsAt) : null,
        expiresAt: write.endsAt ? new Date(write.endsAt) : null,
        isActive: updated.status === "ACTIVE",
        promotionId,
        updatedAt: now,
      }).where(eq(coupons.id, existingCoupon.id));
    } else if (couponCode) {
      await tx.insert(coupons).values({
        code: couponCode,
        promotionId,
        type: nextCouponConfig.type,
        value: nextCouponConfig.value,
        minimumOrderAmount: nextCouponConfig.minimumOrderAmount,
        maximumDiscountAmount: nextCouponConfig.maximumDiscountAmount,
        usageLimit: write.totalUsageLimit ?? null,
        perUserLimit: write.perCustomerUsageLimit ?? null,
        startsAt: write.startsAt ? new Date(write.startsAt) : null,
        expiresAt: write.endsAt ? new Date(write.endsAt) : null,
        isActive: updated.status === "ACTIVE",
      });
    } else if (existingCoupon) {
      await tx.update(coupons).set({ isActive: false, updatedAt: now }).where(eq(coupons.id, existingCoupon.id));
    }
    await recordPromotionVersion(tx, updated, actorId);
    await emitPromotionEvent(tx, "PROMOTION_UPDATED", "promotion", promotionId, { version: updated.version, strategy: updated.strategy }, actorId);
    return updated;
  });
  await writeAudit({ action: "promotion.updated", entityType: "promotion", entityId: promotionId, actorId, metadata: { version: result.version, strategy: result.strategy, couponCodeLogged: false } });
  return serializePromotion(result);
}

export async function transitionPromotion(promotionId: string, expectedVersion: number, action: "ACTIVATE" | "PAUSE" | "ARCHIVE", actorId: string): Promise<Record<string, unknown>> {
  const eventType = action === "ACTIVATE" ? "PROMOTION_ACTIVATED" : action === "PAUSE" ? "PROMOTION_PAUSED" : "PROMOTION_ARCHIVED";
  const status = action === "ACTIVATE" ? "ACTIVE" : action === "PAUSE" ? "PAUSED" : "ARCHIVED";
  const row = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for("update").limit(1);
    if (!current) throw new NotFoundError("Promotion not found.");
    if (current.version !== expectedVersion) throw new ConflictError("Promotion changed in another request. Refresh and retry.", "PROMOTION_VERSION_CONFLICT");
    const config = promotionConfigSchema.safeParse(current.discountConfig);
    const eligibility = promotionEligibilitySchema.safeParse(current.eligibility);
    if (!config.success || config.data.strategy !== current.strategy || !eligibility.success) throw new ValidationError("Promotion rules are invalid and cannot be activated.");
    if (current.strategy === "FREE_SHIPPING") throw new ValidationError("A real shipping quote provider is not configured; free-shipping campaigns cannot be activated.");
    if (current.applyToCatalog) throw new ValidationError("Catalog-detail pricing integration is not configured; this promotion cannot be activated.");
    const [codeCoupon] = await tx.select({ id: coupons.id }).from(coupons).where(eq(coupons.promotionId, current.id)).limit(1);
    if (!current.isAutomatic && !codeCoupon) throw new ValidationError("A code-based promotion needs an active coupon record before activation.");
    if (current.applyToCatalog && (!current.isAutomatic || current.totalUsageLimit != null || current.perCustomerUsageLimit != null)) throw new ValidationError("This promotion is not safe for catalog price application.");
    const now = new Date();
    const [updated] = await tx.update(promotions).set({
      status,
      version: sql`${promotions.version} + 1`,
      updatedBy: actorId,
      updatedAt: now,
    }).where(eq(promotions.id, current.id)).returning();
    if (!updated) throw new NotFoundError("Promotion not found.");
    await tx.update(coupons).set({ isActive: status === "ACTIVE", updatedAt: now }).where(eq(coupons.promotionId, current.id));
    await recordPromotionVersion(tx, updated, actorId);
    await emitPromotionEvent(tx, eventType, "promotion", current.id, { version: updated.version, status }, actorId);
    return updated;
  });
  await writeAudit({ action: `promotion.${action.toLowerCase()}`, entityType: "promotion", entityId: row.id, actorId, metadata: { version: row.version, status: row.status } });
  return serializePromotion(row);
}

export async function transitionCampaign(campaignId: string, expectedVersion: number, action: "ACTIVATE" | "PAUSE" | "ARCHIVE", actorId: string): Promise<Record<string, unknown>> {
  const eventType = action === "ACTIVATE" ? "CAMPAIGN_ACTIVATED" : action === "PAUSE" ? "CAMPAIGN_PAUSED" : "CAMPAIGN_ARCHIVED";
  const status = action === "ACTIVATE" ? "ACTIVE" : action === "PAUSE" ? "PAUSED" : "ARCHIVED";
  const row = await withTransaction(async (tx) => {
    const [current] = await tx.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, campaignId)).for("update").limit(1);
    if (!current) throw new NotFoundError("Campaign not found.");
    if (current.version !== expectedVersion) throw new ConflictError("Campaign changed in another request. Refresh and retry.", "CAMPAIGN_VERSION_CONFLICT");
    const now = new Date();
    const [updated] = await tx.update(promotionCampaigns).set({
      status,
      version: sql`${promotionCampaigns.version} + 1`,
      updatedBy: actorId,
      updatedAt: now,
    }).where(eq(promotionCampaigns.id, campaignId)).returning();
    if (!updated) throw new NotFoundError("Campaign not found.");
    await tx.insert(promotionVersions).values({ campaignId, version: updated.version, snapshot: { ...updated, startsAt: updated.startsAt?.toISOString() ?? null, endsAt: updated.endsAt?.toISOString() ?? null }, actorId });
    await emitPromotionEvent(tx, eventType, "campaign", campaignId, { version: updated.version, status }, actorId);
    return updated;
  });
  await writeAudit({ action: `promotion.campaign_${action.toLowerCase()}`, entityType: "campaign", entityId: row.id, actorId, metadata: { version: row.version, status: row.status } });
  return { ...row, startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null };
}

async function capacityCount(client: DbClient, promotionId: string, couponId: string | null, userId: string | null, checkoutSessionId: string, now: Date): Promise<{ promotion: number; coupon: number; userPromotion: number; userCoupon: number; legacyPromotion: number; legacyCoupon: number; legacyUserPromotion: number; legacyUserCoupon: number }> {
  const activeOrRedeemed = or(
    eq(promotionRedemptions.status, "REDEEMED"),
    and(eq(promotionRedemptions.status, "RESERVED"), gt(promotionRedemptions.expiresAt, now), sql`${promotionRedemptions.checkoutSessionId} <> ${checkoutSessionId}`),
  )!;
  const [promotionCount] = await client.select({ value: count() }).from(promotionRedemptions).where(and(eq(promotionRedemptions.promotionId, promotionId), activeOrRedeemed));
  const [couponCount] = couponId ? await client.select({ value: count() }).from(promotionRedemptions).where(and(eq(promotionRedemptions.couponId, couponId), activeOrRedeemed)) : [{ value: 0 }];
  const [userPromotionCount] = userId ? await client.select({ value: count() }).from(promotionRedemptions).where(and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.userId, userId), activeOrRedeemed)) : [{ value: 0 }];
  const [userCouponCount] = couponId && userId ? await client.select({ value: count() }).from(promotionRedemptions).where(and(eq(promotionRedemptions.couponId, couponId), eq(promotionRedemptions.userId, userId), activeOrRedeemed)) : [{ value: 0 }];
  const [legacyPromotionCount] = await client.select({ value: count() }).from(couponUsages)
    .innerJoin(coupons, eq(coupons.id, couponUsages.couponId))
    .where(and(eq(coupons.promotionId, promotionId), isNotNull(couponUsages.orderId)));
  const [legacyCouponCount] = couponId ? await client.select({ value: count() }).from(couponUsages).where(and(eq(couponUsages.couponId, couponId), isNotNull(couponUsages.orderId))) : [{ value: 0 }];
  const [legacyUserPromotionCount] = userId ? await client.select({ value: count() }).from(couponUsages)
    .innerJoin(coupons, eq(coupons.id, couponUsages.couponId))
    .where(and(eq(coupons.promotionId, promotionId), eq(couponUsages.userId, userId), isNotNull(couponUsages.orderId))) : [{ value: 0 }];
  const [legacyUserCouponCount] = couponId && userId ? await client.select({ value: count() }).from(couponUsages)
    .where(and(eq(couponUsages.couponId, couponId), eq(couponUsages.userId, userId), isNotNull(couponUsages.orderId))) : [{ value: 0 }];
  return {
    promotion: Number(promotionCount?.value ?? 0),
    coupon: Number(couponCount?.value ?? 0),
    userPromotion: Number(userPromotionCount?.value ?? 0),
    userCoupon: Number(userCouponCount?.value ?? 0),
    legacyPromotion: Number(legacyPromotionCount?.value ?? 0),
    legacyCoupon: Number(legacyCouponCount?.value ?? 0),
    legacyUserPromotion: Number(legacyUserPromotionCount?.value ?? 0),
    legacyUserCoupon: Number(legacyUserCouponCount?.value ?? 0),
  };
}

async function couponCapacityAvailable(client: DbClient, candidate: PromotionCandidate, coupon: CouponRow, userId: string | null, checkoutSessionId: string, now: Date): Promise<boolean> {
  if ((candidate.perCustomerLimit ?? coupon.perUserLimit) != null && !userId) return false;
  const counts = await capacityCount(client, candidate.id, coupon.id, userId, checkoutSessionId, now);
  const totalPromotionUses = counts.promotion + counts.legacyPromotion;
  const totalCouponUses = Math.max(coupon.usageCount, counts.legacyCoupon) + counts.coupon;
  const userPromotionUses = counts.userPromotion + counts.legacyUserPromotion;
  const userCouponUses = counts.userCoupon + counts.legacyUserCoupon;
  if (candidate.usageLimit != null && totalPromotionUses >= candidate.usageLimit) return false;
  if (coupon.usageLimit != null && totalCouponUses >= coupon.usageLimit) return false;
  if (userId && candidate.perCustomerLimit != null && userPromotionUses >= candidate.perCustomerLimit) return false;
  if (userId && coupon.perUserLimit != null && userCouponUses >= coupon.perUserLimit) return false;
  return true;
}

async function releaseReservations(client: DbClient, checkoutSessionId: string, reason: string, actorId: string | null = null): Promise<number> {
  const now = new Date();
  const rows = await client.update(promotionRedemptions).set({ status: "RELEASED", releasedAt: now, updatedAt: now })
    .where(and(eq(promotionRedemptions.checkoutSessionId, checkoutSessionId), eq(promotionRedemptions.status, "RESERVED")))
    .returning({ promotionId: promotionRedemptions.promotionId, id: promotionRedemptions.id });
  for (const row of rows) {
    await emitPromotionEvent(client, "PROMOTION_RELEASED", "promotion", row.promotionId, { reservationId: row.id, checkoutSessionId, reason }, actorId);
  }
  return rows.length;
}

/** Call only inside the checkout-session mutation transaction (session row is already locked). */
export async function reserveCouponForCheckout(
  tx: DbTx,
  input: {
    couponId: string;
    promotionId: string;
    expectedPromotionVersion: number;
    expectedCouponCode: string;
    checkoutSessionId: string;
    expectedCartId: string | null;
    expectedCartVersion: number;
    userId: string | null;
    idempotencyKey: string;
    discountPaise: number;
    currency: string;
    allocations: Array<{ cartItemId: string; productId: string; amountPaise: number }>;
    expiresAt: Date;
    actorId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  if (!input.expectedCartId) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  const [cart] = await tx.select({ version: carts.version, status: carts.status }).from(carts)
    .where(eq(carts.id, input.expectedCartId)).for("update").limit(1);
  if (!cart || cart.status !== "ACTIVE" || cart.version !== input.expectedCartVersion) {
    throw new ConflictError("Your cart changed while the coupon was being applied. Review the cart and retry.", "CART_CHANGED");
  }
  const [promotion] = await tx.select().from(promotions).where(eq(promotions.id, input.promotionId)).for("update").limit(1);
  const [coupon] = await tx.select().from(coupons).where(eq(coupons.id, input.couponId)).for("update").limit(1);
  if (!promotion || !coupon || !coupon.isActive || coupon.promotionId !== promotion.id || promotion.status !== "ACTIVE" || promotion.version !== input.expectedPromotionVersion || coupon.code !== input.expectedCouponCode) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime() || coupon.expiresAt && coupon.expiresAt.getTime() <= now.getTime()) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (promotion.startsAt && promotion.startsAt.getTime() > now.getTime() || promotion.endsAt && promotion.endsAt.getTime() <= now.getTime()) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (promotion.campaignId) {
    const [campaign] = await tx.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, promotion.campaignId)).for("update").limit(1);
    if (!campaign || campaign.status !== "ACTIVE" || campaign.startsAt && campaign.startsAt.getTime() > now.getTime() || campaign.endsAt && campaign.endsAt.getTime() <= now.getTime()) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  }
  if ((promotion.perCustomerUsageLimit ?? coupon.perUserLimit) != null && !input.userId) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  await tx.update(promotionRedemptions).set({ status: "EXPIRED", releasedAt: now, updatedAt: now })
    .where(and(eq(promotionRedemptions.checkoutSessionId, input.checkoutSessionId), eq(promotionRedemptions.status, "RESERVED"), lte(promotionRedemptions.expiresAt, now)));
  await releaseReservations(tx, input.checkoutSessionId, "COUPON_REPLACED", input.actorId ?? null);

  const counts = await capacityCount(tx, promotion.id, coupon.id, input.userId, input.checkoutSessionId, now);
  const promotionUses = counts.promotion + counts.legacyPromotion;
  const couponUses = Math.max(coupon.usageCount, counts.legacyCoupon) + counts.coupon;
  const userPromotionUses = counts.userPromotion + counts.legacyUserPromotion;
  const userCouponUses = counts.userCoupon + counts.legacyUserCoupon;
  if (promotion.totalUsageLimit != null && promotionUses >= promotion.totalUsageLimit) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (coupon.usageLimit != null && couponUses >= coupon.usageLimit) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (input.userId && promotion.perCustomerUsageLimit != null && userPromotionUses >= promotion.perCustomerUsageLimit) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");
  if (input.userId && coupon.perUserLimit != null && userCouponUses >= coupon.perUserLimit) throw new ConflictError(SAFE_COUPON_MESSAGE, "COUPON_UNAVAILABLE");

  const [existing] = await tx.select().from(promotionRedemptions)
    .where(and(eq(promotionRedemptions.checkoutSessionId, input.checkoutSessionId), eq(promotionRedemptions.promotionId, promotion.id), eq(promotionRedemptions.status, "RESERVED")))
    .for("update").limit(1);
  if (existing) {
    await tx.update(promotionRedemptions).set({
      couponId: coupon.id,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      discountPaise: input.discountPaise,
      currency: input.currency,
      allocations: input.allocations,
      expiresAt: input.expiresAt,
      updatedAt: now,
    }).where(eq(promotionRedemptions.id, existing.id));
  } else {
    await tx.insert(promotionRedemptions).values({
      promotionId: promotion.id,
      couponId: coupon.id,
      checkoutSessionId: input.checkoutSessionId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      status: "RESERVED",
      discountPaise: input.discountPaise,
      currency: input.currency,
      allocations: input.allocations,
      expiresAt: input.expiresAt,
    });
  }
  await emitPromotionEvent(tx, "PROMOTION_RESERVED", "promotion", promotion.id, {
    checkoutSessionId: input.checkoutSessionId,
    couponId: coupon.id,
    discountPaise: input.discountPaise,
    currency: input.currency,
    expiresAt: input.expiresAt.toISOString(),
  }, input.actorId ?? null);
  await emitPromotionEvent(tx, "COUPON_APPLIED", "checkout", input.checkoutSessionId, {
    promotionId: promotion.id,
    couponId: coupon.id,
    discountPaise: input.discountPaise,
    currency: input.currency,
  }, input.actorId ?? null);
}

export async function releaseCheckoutPromotionReservations(tx: DbTx, checkoutSessionId: string, reason: string, actorId: string | null = null): Promise<number> {
  return releaseReservations(tx, checkoutSessionId, reason, actorId);
}

export async function extendCheckoutPromotionReservations(tx: DbTx, checkoutSessionId: string, expiresAt: Date): Promise<void> {
  await tx.update(promotionRedemptions).set({ expiresAt, updatedAt: new Date() })
    .where(and(eq(promotionRedemptions.checkoutSessionId, checkoutSessionId), eq(promotionRedemptions.status, "RESERVED")));
}

export async function hasActiveCouponReservation(tx: DbTx, checkoutSessionId: string, couponId: string, now = new Date()): Promise<boolean> {
  const [row] = await tx.select({ id: promotionRedemptions.id }).from(promotionRedemptions)
    .where(and(
      eq(promotionRedemptions.checkoutSessionId, checkoutSessionId),
      eq(promotionRedemptions.couponId, couponId),
      eq(promotionRedemptions.status, "RESERVED"),
      gt(promotionRedemptions.expiresAt, now),
    )).limit(1);
  return Boolean(row);
}

export async function expirePromotionReservations(now = new Date(), batchSize = 500): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new ValidationError("Reservation batch size must be between 1 and 5000.");
  const rows = await withTransaction(async (tx) => {
    const candidates = await tx.select({ id: promotionRedemptions.id }).from(promotionRedemptions)
      .where(and(eq(promotionRedemptions.status, "RESERVED"), lte(promotionRedemptions.expiresAt, now)))
      .limit(batchSize);
    if (!candidates.length) return [];
    return tx.update(promotionRedemptions).set({ status: "EXPIRED", releasedAt: now, updatedAt: now })
      .where(and(inArray(promotionRedemptions.id, candidates.map((row) => row.id)), eq(promotionRedemptions.status, "RESERVED"), lte(promotionRedemptions.expiresAt, now)))
      .returning({ id: promotionRedemptions.id, promotionId: promotionRedemptions.promotionId, checkoutSessionId: promotionRedemptions.checkoutSessionId });
  });
  if (rows.length) {
    for (const row of rows) {
      await writeAudit({ action: "promotion.reservation_expired", entityType: "promotion", entityId: row.promotionId, metadata: { checkoutSessionId: row.checkoutSessionId, reservationId: row.id } });
    }
  }
  return rows.length;
}

export async function getPromotionAnalytics(): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select({
    id: promotions.id,
    name: promotions.name,
    status: promotions.status,
    currency: promotions.currency,
    reserved: sql<number>`count(*) filter (where ${promotionRedemptions.status} = 'RESERVED' and ${promotionRedemptions.expiresAt} > now())`.mapWith(Number),
    redeemed: sql<number>`count(*) filter (where ${promotionRedemptions.status} = 'REDEEMED')`.mapWith(Number),
    released: sql<number>`count(*) filter (where ${promotionRedemptions.status} in ('RELEASED', 'EXPIRED'))`.mapWith(Number),
    reservedDiscountPaise: sql<number>`coalesce(sum(${promotionRedemptions.discountPaise}) filter (where ${promotionRedemptions.status} = 'RESERVED' and ${promotionRedemptions.expiresAt} > now()), 0)`.mapWith(Number),
  }).from(promotions).leftJoin(promotionRedemptions, eq(promotionRedemptions.promotionId, promotions.id))
    .groupBy(promotions.id).orderBy(desc(promotions.updatedAt)).limit(500);
  return rows.map((row) => ({ ...row, redeemedFinalizationIntegrated: false }));
}

export async function simulatePromotion(input: {
  promotionId?: string;
  couponCode?: string | null;
  items: Array<{ productId: string; variantId: string; quantity: number }>;
  assumeActive: boolean;
}): Promise<Record<string, unknown>> {
  const quantities = new Map<string, { productId: string; quantity: number }>();
  for (const item of input.items) {
    const existing = quantities.get(item.variantId);
    if (existing && existing.productId !== item.productId) throw new ValidationError("A variant cannot be assigned to multiple products.");
    quantities.set(item.variantId, { productId: item.productId, quantity: (existing?.quantity ?? 0) + item.quantity });
  }
  const variantIds = [...quantities.keys()];
  const [catalogRows, quotes] = await Promise.all([
    db.select({
      variantId: productVariants.id,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      productStatus: products.status,
      currency: products.currency,
      productSellerId: products.sellerId,
      variantName: productVariants.name,
      variantActive: productVariants.isActive,
      stockQuantity: productVariants.stockQuantity,
    }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(inArray(productVariants.id, variantIds)),
    quoteVariantPrices(variantIds),
  ]);
  if (catalogRows.length !== variantIds.length || catalogRows.some((row) => quantities.get(row.variantId)?.productId !== row.productId || row.productStatus !== "ACTIVE" || !row.variantActive)) {
    throw new ValidationError("The simulation contains an unavailable or mismatched product variant.");
  }
  const currencies = new Set(catalogRows.map((row) => row.currency));
  if (currencies.size !== 1) throw new ValidationError("A simulated cart must use one currency.");
  const currency = catalogRows[0]!.currency;
  const items: CartLineDTO[] = catalogRows.map((row, index) => {
    const quote = quotes.get(row.variantId);
    const quantity = quantities.get(row.variantId)!.quantity;
    if (!quote) throw new ValidationError("A product price could not be resolved for this simulation.");
    return {
      id: `simulation-${index}-${row.variantId}`,
      productId: row.productId,
      variantId: row.variantId,
      slug: row.productSlug,
      productName: row.productName,
      variantName: row.variantName,
      size: null,
      color: null,
      imageUrl: null,
      sellerId: row.productSellerId,
      sellerName: null,
      quantity,
      currency,
      observedUnitPricePaise: quote.finalPaise,
      unitPricePaise: quote.finalPaise,
      compareAtPaise: quote.compareAtPaise,
      listUnitPricePaise: quote.originalPaise,
      lineSubtotalPaise: quote.finalPaise * quantity,
      lineDiscountPaise: quote.discountPaise * quantity,
      estimatedTaxPaise: quote.taxPaise * quantity,
      availableQuantity: row.stockQuantity,
      purchasable: true,
      attributionSource: "ADMIN_SIMULATION",
      version: 1,
      warnings: [],
    };
  });
  const totals = calculateCartTotals(items.map((item) => ({
    quantity: item.quantity,
    currentUnitPricePaise: item.unitPricePaise,
    listUnitPricePaise: item.listUnitPricePaise,
    estimatedTaxPerUnitPaise: item.quantity ? Math.trunc(item.estimatedTaxPaise / item.quantity) : 0,
  })), currency);
  const cart: CartDTO = {
    id: null,
    status: "ACTIVE",
    currency,
    version: 0,
    createdAt: null,
    lastActivityAt: null,
    expiresAt: null,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    lineCount: items.length,
    totals,
    warnings: [],
    readyForCheckout: true,
    mergeResult: null,
  };
  const now = new Date();
  let candidates: PromotionCandidate[] = [];
  let selectedCoupon: CouponRow | null = null;
  if (input.couponCode) {
    selectedCoupon = await lookupCoupon(db, input.couponCode, now, { includeInactive: true });
    if (!selectedCoupon?.promotionId) throw new ValidationError(SAFE_COUPON_MESSAGE);
    const couponCandidate = await loadCouponCandidate(db, selectedCoupon, currency, { includeInactive: true });
    if (!couponCandidate || input.promotionId && couponCandidate.id !== input.promotionId) throw new ValidationError(SAFE_COUPON_MESSAGE);
    candidates = input.promotionId ? [couponCandidate] : [...await loadAutomaticCandidates(db, currency, now), couponCandidate];
  } else if (input.promotionId) {
    const rows = await selectPromotionRows(db, [eq(promotions.id, input.promotionId)]);
    candidates = await candidatesFromRows(db, rows);
    if (!candidates.length) throw new NotFoundError("Promotion not found.");
  } else {
    candidates = await loadAutomaticCandidates(db, currency, now);
  }
  const lines = await buildPromotionLines(cart, db);
  const evaluation = evaluatePromotionCart({
    candidates,
    lines,
    currency,
    context: { userId: null, now, ignoreLifecycle: input.assumeActive },
  });
  const resultCart = applyPromotionEvaluationToCart(cart, evaluation);
  const visibleApplications = evaluation.allocations.map((allocation) => ({
    promotionId: allocation.promotionId,
    name: allocation.promotionName,
    discountPaise: allocation.amountPaise,
    couponCode: allocation.couponId === selectedCoupon?.id ? selectedCoupon.code : null,
  }));
  return {
    currency,
    subtotalBeforePromotionPaise: cart.totals.subtotalPaise,
    subtotalAfterPromotionPaise: resultCart.totals.subtotalPaise,
    discountPaise: evaluation.totalDiscountPaise,
    applications: visibleApplications,
    evaluatedPromotions: evaluation.evaluatedPromotions,
    unsupported: evaluation.unsupported,
    reservationCreated: false,
    finalRedemptionIntegrated: false,
  };
}

export function safeCouponError(): string {
  return SAFE_COUPON_MESSAGE;
}
