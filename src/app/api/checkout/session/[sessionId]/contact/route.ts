import { z } from "zod";
import { apiOk, withErrorHandling } from "@/lib/api-response";
import { NotFoundError, RateLimitError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { assertSameOriginJsonMutation, requireIdempotencyKey } from "@/server/cart/session";
import { cartRequestIdentity } from "@/server/cart/request";
import { readJsonBody, validateBody } from "@/server/api/request";
import { updateCheckoutContact } from "@/services/checkout/checkout.service";
import { checkoutContactSchema } from "@/validations/checkout";

export const dynamic = "force-dynamic";
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000, namespace: "checkout-write" });

export const PATCH = withErrorHandling(async (request: Request, context: { params: Promise<{ sessionId: string }> }) => {
  if (!limiter.check(clientIp(request)).success) throw new RateLimitError();
  assertSameOriginJsonMutation(request);
  const { sessionId } = await context.params;
  if (!z.uuid().safeParse(sessionId).success) throw new NotFoundError("Checkout session not found.");
  const identity = await cartRequestIdentity(request);
  const body = validateBody(z.object({ expectedVersion: z.number().int().positive(), contact: checkoutContactSchema }).strict(), await readJsonBody(request));
  const data = await updateCheckoutContact(identity.principal, sessionId, body.contact, {
    expectedVersion: body.expectedVersion,
    idempotencyKey: requireIdempotencyKey(request),
  });
  return apiOk(data, { headers: { "Cache-Control": "private, no-store" } });
}, "api-checkout-contact-update");
