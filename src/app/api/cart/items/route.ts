import { z } from "zod";
import { cartPolicy } from "@/config/cart";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { RECOMMENDATION_TYPES } from "@/lib/recommendations/types";
import { assertSameOriginJsonMutation, appendSetCookie, guestCartSetCookie, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { addCartItem, MAX_CART_QUANTITY } from "@/services/cart/cart.service";
import type { RecommendationAttribution } from "@/services/cart/types";
import type { CartAttributionSource } from "@/services/cart/types";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "cart-write" });
const sourceSchema = z.enum([
  "PRODUCT_PAGE",
  "PRODUCT_CARD",
  "MINI_CART",
  "CART_RECOMMENDATION",
  "WISHLIST",
  "SAVED_FOR_LATER",
  "RESTORE_SAVED_ITEM",
  "UNKNOWN",
]);
const recommendationSchema = z.object({
  id: z.string().min(8).max(160),
  type: z.enum(RECOMMENDATION_TYPES),
  position: z.number().int().min(0).max(100),
  algorithmVersion: z.string().min(1).max(80),
}).strict();
const bodySchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_CART_QUANTITY),
  source: sourceSchema.default("PRODUCT_PAGE"),
  cartVersion: z.number().int().min(0).optional(),
  recommendation: recommendationSchema.optional(),
}).strict();

/** POST /api/cart/items — add a live catalog variant; client prices are ignored. */
export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const identity = await cartRequestIdentity(request, { createGuestSession: true });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the product and quantity.");

  const recommendation = parsed.data.recommendation as RecommendationAttribution | undefined;
  const result = await addCartItem(
    identity.principal,
    {
      productId: parsed.data.productId,
      variantId: parsed.data.variantId,
      quantity: parsed.data.quantity,
      source: parsed.data.source as CartAttributionSource,
      recommendation,
    },
    {
      idempotencyKey: requireIdempotencyKey(request),
      expectedCartVersion: parsed.data.cartVersion && parsed.data.cartVersion > 0 ? parsed.data.cartVersion : undefined,
      recommendation,
    },
  );
  const response = apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
  return identity.mintedGuestToken && identity.guestToken
    ? appendSetCookie(response, guestCartSetCookie(request, identity.guestToken, Math.floor(cartPolicy().guestTtlMs / 1000)))
    : response;
}, "api-cart-add-item");
