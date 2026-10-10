import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, appendSetCookie, guestCartSetCookie, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { readJsonBody, validateBody } from "@/server/api/request";
import { serverEnv } from "@/config/env";
import { createOrResumeCheckoutSession } from "@/services/checkout/checkout.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 12, windowMs: 60_000, namespace: "checkout-create" });

export const POST = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  validateBody(z.object({}).strict(), await readJsonBody(request));
  const identity = await cartRequestIdentity(request, { createGuestSession: true });
  const idempotencyKey = requireIdempotencyKey(request);
  const session = await createOrResumeCheckoutSession(identity.principal, idempotencyKey);
  let response = apiOk(session, { headers: { "Cache-Control": "private, no-store" } });
  if (identity.mintedGuestToken && identity.guestToken) {
    response = appendSetCookie(response, guestCartSetCookie(request, identity.guestToken, serverEnv().CART_GUEST_TTL_DAYS * 24 * 60 * 60));
  }
  return response;
}, "api-checkout-create");
