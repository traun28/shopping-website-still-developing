import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { cartRequestIdentity } from "@/server/cart/request";
import { appendSetCookie, guestCartClearCookie } from "@/server/cart/session";
import { getCartSnapshot } from "@/services/cart/cart.service";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 90, windowMs: 60_000, namespace: "cart-read" });

/** GET /api/cart — live, owner-scoped reconciliation with server totals. */
export const GET = withErrorHandling(async (request: Request) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  const identity = await cartRequestIdentity(request);
  const cart = await getCartSnapshot(identity.principal);
  const response = apiOk(cart, { headers: { "Cache-Control": "private, no-store" } });
  // A guest credential is one-use for ownership. After a successful or empty
  // account merge, stop sending it so a stale bearer cookie cannot linger.
  if (identity.principal.userId && identity.guestToken) {
    return appendSetCookie(response, guestCartClearCookie(request));
  }
  return response;
}, "api-cart-read");
