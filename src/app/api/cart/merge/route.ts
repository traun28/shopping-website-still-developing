import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, appendSetCookie, guestCartClearCookie } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { mergeGuestCart } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, namespace: "cart-merge" });
const bodySchema = z.object({}).strict();

/** POST /api/cart/merge — explicit, idempotent guest-to-account merge hook. */
export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new ValidationError("Invalid request body."); }
  if (!bodySchema.safeParse(raw).success) throw new ValidationError("Invalid request body.");
  const identity = await cartRequestIdentity(request);
  const result = await mergeGuestCart(identity.principal);
  const response = apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
  return identity.guestToken ? appendSetCookie(response, guestCartClearCookie(request)) : response;
}, "api-cart-merge");
