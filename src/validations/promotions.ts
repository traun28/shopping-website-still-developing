import { z } from "zod";
import { PROMOTION_STRATEGIES, PROMOTION_TARGET_DIMENSIONS } from "@/lib/promotions/types";

const paise = z.number().int().min(0).max(2_000_000_000);
const positivePaise = paise.min(1);
const basisPoints = z.number().int().min(1).max(10_000);
const priority = z.number().int().min(0).max(100_000);

const targetSchema = z.object({
  dimension: z.enum(PROMOTION_TARGET_DIMENSIONS),
  entityId: z.uuid(),
  mode: z.enum(["INCLUDE", "EXCLUDE"]).default("INCLUDE"),
}).strict();

const percentageConfig = z.object({
  strategy: z.literal("PERCENTAGE_OFF"),
  discountBasisPoints: basisPoints,
  maxDiscountPaise: paise.nullable().optional(),
}).strict();

const fixedConfig = z.object({
  strategy: z.literal("FIXED_AMOUNT_OFF"),
  amountPaise: positivePaise,
}).strict();

const cartThresholdConfig = z.object({
  strategy: z.literal("CART_THRESHOLD"),
  thresholdPaise: positivePaise,
  discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
  value: positivePaise,
  maxDiscountPaise: paise.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.discountType === "PERCENTAGE" && value.value > 10_000) {
    context.addIssue({ code: "custom", path: ["value"], message: "Percentage value is basis points and cannot exceed 10000." });
  }
  if (value.discountType === "FIXED_AMOUNT" && value.maxDiscountPaise != null) {
    context.addIssue({ code: "custom", path: ["maxDiscountPaise"], message: "A fixed discount does not accept a percentage cap." });
  }
});

const tierSchema = z.object({
  minQuantity: z.number().int().min(1).max(10_000),
  discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
  value: positivePaise,
  maxDiscountPaise: paise.nullable().optional(),
}).strict().superRefine((tier, context) => {
  if (tier.discountType === "PERCENTAGE" && tier.value > 10_000) {
    context.addIssue({ code: "custom", path: ["value"], message: "Percentage value is basis points and cannot exceed 10000." });
  }
  if (tier.discountType === "FIXED_AMOUNT" && tier.maxDiscountPaise != null) {
    context.addIssue({ code: "custom", path: ["maxDiscountPaise"], message: "A fixed discount does not accept a percentage cap." });
  }
});

const quantityTierConfig = z.object({
  strategy: z.literal("QUANTITY_TIER"),
  tiers: z.array(tierSchema).min(1).max(10),
}).strict().superRefine((value, context) => {
  const thresholds = value.tiers.map((tier) => tier.minQuantity);
  if (new Set(thresholds).size !== thresholds.length || thresholds.some((threshold, index) => index > 0 && threshold <= thresholds[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["tiers"], message: "Quantity tiers must be unique and ordered by ascending minimum quantity." });
  }
});

const buyXGetYConfig = z.object({
  strategy: z.literal("BUY_X_GET_Y"),
  buyQuantity: z.number().int().min(1).max(100),
  getQuantity: z.number().int().min(1).max(100),
  rewardBasisPoints: z.number().int().min(1).max(10_000),
}).strict();

const bundleConfig = z.object({
  strategy: z.literal("BUNDLE"),
  minimumDistinctProducts: z.number().int().min(2).max(50),
  discountBasisPoints: basisPoints,
}).strict();

const freeShippingConfig = z.object({ strategy: z.literal("FREE_SHIPPING") }).strict();

export const promotionConfigSchema = z.discriminatedUnion("strategy", [
  percentageConfig,
  fixedConfig,
  cartThresholdConfig,
  quantityTierConfig,
  buyXGetYConfig,
  bundleConfig,
  freeShippingConfig,
]);

export const promotionEligibilitySchema = z.object({
  minimumCartSubtotalPaise: positivePaise.nullable().optional(),
  minimumItemQuantity: z.number().int().min(1).max(10_000).nullable().optional(),
  requireAuthenticatedCustomer: z.boolean().default(false),
  // Do not add first-order here until the platform has a trusted order/payment
  // lifecycle and guest/account purchase identity semantics.
}).strict().default({ requireAuthenticatedCustomer: false });

const scheduleSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
}).strict();

const campaignLinkSchema = z.object({ campaignId: z.uuid().nullable().optional() }).strict();

export const promotionWriteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  strategy: z.enum(PROMOTION_STRATEGIES),
  config: promotionConfigSchema,
  eligibility: promotionEligibilitySchema,
  targets: z.array(targetSchema).max(500).default([]),
  couponCode: z.string().trim().min(3).max(64).nullable().optional(),
  isAutomatic: z.boolean().default(true),
  applyToCatalog: z.boolean().default(false),
  stackable: z.boolean().default(false),
  stackGroup: z.string().trim().min(1).max(80).nullable().optional(),
  priority,
  currency: z.string().regex(/^[A-Z]{3}$/).default("INR"),
  totalUsageLimit: z.number().int().min(1).max(10_000_000).nullable().optional(),
  perCustomerUsageLimit: z.number().int().min(1).max(100_000).nullable().optional(),
  ...scheduleSchema.shape,
  ...campaignLinkSchema.shape,
}).strict().superRefine((value, context) => {
  if (value.config.strategy !== value.strategy) {
    context.addIssue({ code: "custom", path: ["config", "strategy"], message: "Discount configuration must match the selected strategy." });
  }
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after start time." });
  }
  if (!value.isAutomatic && !value.couponCode) {
    context.addIssue({ code: "custom", path: ["couponCode"], message: "A coupon code is required for a code-based promotion." });
  }
  if (value.isAutomatic && value.couponCode) {
    context.addIssue({ code: "custom", path: ["couponCode"], message: "Automatic promotions do not take a coupon code." });
  }
  if (value.isAutomatic && (value.totalUsageLimit != null || value.perCustomerUsageLimit != null)) {
    context.addIssue({ code: "custom", path: ["totalUsageLimit"], message: "Usage-limited promotions must use a code-based coupon with a reservation flow." });
  }
  if (value.applyToCatalog && (!value.isAutomatic || value.couponCode || value.totalUsageLimit || value.perCustomerUsageLimit || value.eligibility.minimumCartSubtotalPaise || value.eligibility.minimumItemQuantity || value.targets.some((target) => target.dimension === "CUSTOMER"))) {
    context.addIssue({ code: "custom", path: ["applyToCatalog"], message: "Catalog price rules must be automatic, unlimited, and independent of customer/cart eligibility." });
  }
  const targetKeys = value.targets.map((target) => `${target.dimension}:${target.entityId}:${target.mode}`);
  if (new Set(targetKeys).size !== targetKeys.length) {
    context.addIssue({ code: "custom", path: ["targets"], message: "Duplicate targets are not allowed." });
  }
});

export const promotionCreateSchema = promotionWriteSchema;
export const promotionUpdateSchema = promotionWriteSchema.extend({ expectedVersion: z.number().int().positive() });

export const promotionStateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["ACTIVATE", "PAUSE", "ARCHIVE"]),
}).strict();

export const campaignWriteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  description: z.string().trim().max(1000).nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
}).strict().superRefine((value, context) => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after start time." });
  }
});

export const campaignUpdateSchema = campaignWriteSchema.extend({ expectedVersion: z.number().int().positive() });

export const campaignStateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["ACTIVATE", "PAUSE", "ARCHIVE"]),
}).strict();

export const promotionSimulationSchema = z.object({
  promotionId: z.uuid().optional(),
  couponCode: z.string().trim().min(3).max(64).nullable().optional(),
  items: z.array(z.object({ productId: z.uuid(), variantId: z.uuid(), quantity: z.number().int().min(1).max(99) }).strict()).min(1).max(50),
  assumeActive: z.boolean().default(false),
}).strict();

export type PromotionWriteInput = z.infer<typeof promotionWriteSchema>;
export type PromotionCreateInput = z.infer<typeof promotionCreateSchema>;
