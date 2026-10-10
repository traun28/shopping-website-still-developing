import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { removeSavedItem } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, namespace: "cart-write" });
const bodySchema = z.object({ cartVersion: z.number().int().min(0).optional() }).strict();

export const DELETE = withErrorHandling(async (request: Request, context: { params: Promise<{ savedItemId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const { savedItemId } = await context.params;
  if (!z.string().uuid().safeParse(savedItemId).success) throw new ValidationError("Invalid saved item id.");
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
  const identity = await cartRequestIdentity(request);
  const result = await removeSavedItem(identity.principal, savedItemId, {
    idempotencyKey: requireIdempotencyKey(request),
    expectedCartVersion: parsed.data.cartVersion && parsed.data.cartVersion > 0 ? parsed.data.cartVersion : undefined,
  });
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-cart-remove-saved-item");
