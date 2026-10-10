import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { cartRequestIdentity } from "@/server/cart/request";
import { getCheckoutSessionSummary } from "@/services/checkout/checkout.service";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 90, windowMs: 60_000, namespace: "checkout-summary-read" });

export const GET = withErrorHandling(async (request: Request, context: { params: Promise<{ sessionId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  const { sessionId } = await context.params;
  if (!z.uuid().safeParse(sessionId).success) throw new NotFoundError("Checkout session not found.");
  const identity = await cartRequestIdentity(request);
  const data = await getCheckoutSessionSummary(identity.principal, sessionId);
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-checkout-summary-read");
