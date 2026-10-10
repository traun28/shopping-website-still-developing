import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { cartRequestIdentity } from "@/server/cart/request";
import { getSavedItemSnapshot } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 90, windowMs: 60_000, namespace: "cart-read" });

/** GET /api/cart/saved-items — separate Save for Later collection, live-priced. */
export const GET = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  const identity = await cartRequestIdentity(request);
  const result = await getSavedItemSnapshot(identity.principal);
  return apiOk(result, { headers: { "Cache-Control": "private, no-store" } });
}, "api-cart-saved-items");
