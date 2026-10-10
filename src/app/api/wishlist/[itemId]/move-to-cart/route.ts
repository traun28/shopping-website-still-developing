import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { RECOMMENDATION_TYPES } from "@/lib/recommendations/types";
import { assertSameOriginJsonMutation, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { moveWishlistItemToCart, MAX_CART_QUANTITY } from "@/services/cart/cart.service";
import type { RecommendationAttribution } from "@/services/cart/types";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "cart-write" });
const bodySchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_CART_QUANTITY),
  cartVersion: z.number().int().min(0).optional(),
  recommendation: z.object({
    id: z.string().min(8).max(160),
    type: z.enum(RECOMMENDATION_TYPES),
    position: z.number().int().min(0).max(100),
    algorithmVersion: z.string().min(1).max(80),
  }).strict().optional(),
}).strict();

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const { itemId } = await context.params;
  if (!z.string().uuid().safeParse(itemId).success) throw new ValidationError("Invalid wishlist item id.");
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the selected product option.");
  const identity = await cartRequestIdentity(request);
  const recommendation = parsed.data.recommendation as RecommendationAttribution | undefined;
  const result = await moveWishlistItemToCart(identity.principal, {
    wishlistItemId: itemId,
    variantId: parsed.data.variantId,
    quantity: parsed.data.quantity,
    recommendation,
  }, {
    idempotencyKey: requireIdempotencyKey(request),
    expectedCartVersion: parsed.data.cartVersion && parsed.data.cartVersion > 0 ? parsed.data.cartVersion : undefined,
    recommendation,
  });
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-wishlist-move-to-cart");
