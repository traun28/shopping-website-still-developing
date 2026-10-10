import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { removeCartItem, updateCartItem, MAX_CART_QUANTITY } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "cart-write" });
const itemIdSchema = z.string().uuid();
const updateSchema = z.object({ quantity: z.number().int().min(1).max(MAX_CART_QUANTITY), cartVersion: z.number().int().min(0).optional() }).strict();
const removeSchema = z.object({ cartVersion: z.number().int().min(0).optional() }).strict();

async function itemIdFrom(context: { params: Promise<{ itemId: string }> }): Promise<string> {
  const { itemId } = await context.params;
  const parsed = itemIdSchema.safeParse(itemId);
  if (!parsed.success) throw new ValidationError("Invalid cart item id.");
  return parsed.data;
}

async function bodyFrom(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }
}

export const PATCH = withErrorHandling(async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const parsed = updateSchema.safeParse(await bodyFrom(request));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the quantity.");
  const identity = await cartRequestIdentity(request);
  const result = await updateCartItem(identity.principal, {
    itemId: await itemIdFrom(context),
    quantity: parsed.data.quantity,
  }, {
    idempotencyKey: requireIdempotencyKey(request),
    expectedCartVersion: parsed.data.cartVersion && parsed.data.cartVersion > 0 ? parsed.data.cartVersion : undefined,
  });
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-cart-update-item");

export const DELETE = withErrorHandling(async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const parsed = removeSchema.safeParse(await bodyFrom(request));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
  const identity = await cartRequestIdentity(request);
  const result = await removeCartItem(identity.principal, await itemIdFrom(context), {
    idempotencyKey: requireIdempotencyKey(request),
    expectedCartVersion: parsed.data.cartVersion && parsed.data.cartVersion > 0 ? parsed.data.cartVersion : undefined,
  });
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-cart-remove-item");
