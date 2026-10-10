import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { saveCartItemForLater } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "cart-write" });
const itemIdSchema = z.string().uuid();
const bodySchema = z.object({ cartVersion: z.number().int().min(0).optional() }).strict();

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ itemId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const { itemId } = await context.params;
  const parsedId = itemIdSchema.safeParse(itemId);
  if (!parsedId.success) throw new ValidationError("Invalid cart item id.");
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  const body = bodySchema.safeParse(raw);
  if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? "Invalid request body.");
  const identity = await cartRequestIdentity(request);
  const result = await saveCartItemForLater(identity.principal, parsedId.data, {
    idempotencyKey: requireIdempotencyKey(request),
    expectedCartVersion: body.data.cartVersion && body.data.cartVersion > 0 ? body.data.cartVersion : undefined,
  });
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-cart-save-for-later");
